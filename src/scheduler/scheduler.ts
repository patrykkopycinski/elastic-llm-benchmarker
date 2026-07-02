import type { QueueService, QueueEntry } from '../services/queue-service.js';
import type { PipelineRun } from './pipeline-state.js';
import type { Stage1Worker, Stage2Worker, Stage3Worker } from '../worker/index.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { AppConfig } from '../types/config.js';
import type { RecommendationReport } from '../types/recommendation.js';
import { buildRecommendationReport } from '../services/recommendation-report-builder.js';
import type { SlackNotifier } from '../services/slack-notifier.js';
import type { InferenceEngine } from '../engines/engine-types.js';
import type { ModelSmokeTest } from '../services/model-smoke-test.js';
import type { BuildkiteEvalTrigger, BuildkiteBuildResult } from '../services/buildkite-eval-trigger.js';
import { isRetriableInfraState } from '../services/buildkite-eval-trigger.js';
import {
  mapBuildkiteResultToStage2,
  parseEvalArtifactJson,
} from '../services/ci-eval-stage2-mapper.js';
import type { Stage2Result } from './pipeline-state.js';
import type { Logger } from 'winston';
import { createLogger } from '../utils/logger.js';
import { VllmPublicEndpointResolver } from '../services/vllm-public-endpoint.js';
import { CiEvalInfrastructureGuard } from '../services/ci-eval-infrastructure-guard.js';
import { resolveCompletedEvalSuites } from '../services/ci-eval-resume.js';
import type { SSHClientPool } from '../services/ssh-client.js';
import type { TunnelService } from '../services/tunnel-service.js';
import type { SshPortForward } from '../utils/ssh-port-forward.js';

export interface SchedulerOptions {
  pollIntervalMs: number;
  maxConcurrentRuns: number;
}

export interface CIEvalsOptions {
  enabled: boolean;
  detachPoll: boolean;
  smokeTest: ModelSmokeTest;
  buildkiteTrigger: BuildkiteEvalTrigger;
  sshPool?: SSHClientPool;
}

interface DeferredInfrastructureCleanup {
  releasePublicEndpoint?: () => Promise<void>;
  deploymentName: string;
  pollPromise: Promise<void>;
  stopGuard?: () => void;
}

interface CIEvalRunResult {
  /** Keep tunnel/model alive until Buildkite poll completes. */
  deferTeardown: boolean;
  /** Stage 2 result when poll completed synchronously. */
  stage2Result?: Stage2Result;
  /** When true, pipeline should abort (smoke failure). */
  aborted?: boolean;
  abortReason?: string;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRuns = 0;
  private shuttingDown = false;
  private readonly logger: Logger;
  private readonly deferredCleanups = new Map<string, DeferredInfrastructureCleanup>();
  private readonly entryInProcess = new Set<string>();

  constructor(
    private queueService: QueueService,
    private stage1Worker: Stage1Worker,
    private options: SchedulerOptions = { pollIntervalMs: 30000, maxConcurrentRuns: 1 },
    private stage2Worker?: Stage2Worker,
    private resultsStore?: ElasticsearchResultsStore,
    private stage3Worker?: Stage3Worker,
    private config?: AppConfig,
    private slackNotifier?: SlackNotifier,
    private engine?: InferenceEngine,
    private ciEvals?: CIEvalsOptions,
    private onModelCompleted?: (modelId: string) => void,
  ) {
    this.logger = createLogger(config?.logLevel ?? 'info');
  }

  async start(): Promise<void> {
    // Immediately check once, then set interval
    await this.poll();
    this.timer = setInterval(() => this.poll(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for active runs to complete
    while (this.activeRuns > 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Wait for deferred Buildkite polls + tunnel teardown
    await Promise.all(
      [...this.deferredCleanups.values()].map((entry) => entry.pollPromise),
    );
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.activeRuns >= this.options.maxConcurrentRuns) return;
    if (this.deferredCleanups.size > 0) {
      this.logger.info('Scheduler: waiting for deferred Buildkite poll before dequeuing next model', {
        pending: this.deferredCleanups.size,
      });
      return;
    }

    try {
      const inFlight = await this.queueService.getCurrent();
      if (inFlight) {
        if (this.entryInProcess.has(inFlight.id) || this.deferredCleanups.has(inFlight.id)) {
          return;
        }
        this.logger.info('Scheduler: resuming in-flight queue entry', {
          queueEntryId: inFlight.id,
          modelId: inFlight.modelId,
          status: inFlight.status,
        });
        this.activeRuns++;
        this.entryInProcess.add(inFlight.id);
        this.processEntry(inFlight, { resume: true }).finally(() => {
          this.activeRuns--;
          this.entryInProcess.delete(inFlight.id);
        });
        return;
      }

      const entry = await this.queueService.dequeue();
      if (!entry) return;

      this.activeRuns++;
      this.entryInProcess.add(entry.id);

      // Run in background (don't await)
      this.processEntry(entry).finally(() => {
        this.activeRuns--;
        this.entryInProcess.delete(entry.id);
      });
    } catch (err) {
      console.error('Scheduler poll error:', err);
    }
  }

  private async processEntry(
    entry: QueueEntry,
    options?: { resume?: boolean },
  ): Promise<void> {
    const run: PipelineRun = {
      runId: crypto.randomUUID(),
      modelId: entry.modelId,
      queueEntryId: entry.id,
      stage: 'idle',
      startedAt: new Date().toISOString(),
    };

    let releasePublicEndpoint: (() => Promise<void>) | undefined;
    let deferInfrastructureTeardown = false;

    try {
      let stage1Skipped = false;
      if (options?.resume && this.ciEvals?.enabled && this.engine && this.config) {
        const findRunning = this.engine.findRunningDeployment;
        const existing = findRunning
          ? await findRunning.call(this.engine, this.config.ssh, entry.modelId)
          : null;
        if (existing) {
          stage1Skipped = true;
          await this.queueService.updateStatus(entry.id, 'benchmarking');
          const now = new Date().toISOString();
          run.benchmarkResult = {
            runId: run.runId,
            modelId: entry.modelId,
            queueEntryId: entry.id,
            status: 'skipped',
            metrics: null,
            rawOutput: '',
            startedAt: now,
            completedAt: now,
            deploymentName: existing.deploymentName,
            endpointUrl: existing.endpointUrl,
          };
          run.deployment = {
            deploymentName: existing.deploymentName,
            containerId: '',
            endpointUrl: existing.endpointUrl,
            status: 'deployed',
          };
          this.logger.info('Scheduler: resumed with existing vLLM deployment (skipped Stage 1)', {
            modelId: entry.modelId,
            deploymentName: existing.deploymentName,
          });
        }
      }

      // Pre-warm tunnel in parallel with Stage 1 when CI evals are enabled.
      // The SSH forward + ngrok only need the config-driven ports (not the
      // actual model endpoint URL), so we can start them while Stage 1 runs.
      let tunnelPromise: Promise<Awaited<ReturnType<VllmPublicEndpointResolver['resolve']>>> | undefined;
      const needsTunnel = this.ciEvals?.enabled && this.config?.tunnel?.enabled;
      if (needsTunnel && this.config) {
        const resolver = new VllmPublicEndpointResolver({
          ssh: this.config.ssh,
          tunnel: this.config.tunnel,
          logLevel: this.config.logLevel,
        });
        // directUrl is only used as a fallback; use a placeholder — we'll override after Stage 1.
        tunnelPromise = resolver.resolve(`http://${this.config.ssh.host}:8000`);
      }

      if (!stage1Skipped) {
        await this.queueService.updateStatus(entry.id, 'deploying');
        const result = await this.stage1Worker.execute(run);
        run.benchmarkResult = result;

        // Populate run.deployment from Stage 1 so downstream stages can
        // reach the still-running model endpoint.
        if (result.endpointUrl && result.deploymentName) {
          run.deployment = {
            deploymentName: result.deploymentName,
            containerId: '',
            endpointUrl: result.endpointUrl,
            status: 'deployed',
          };
        }

        if (result.status !== 'success') {
          if (tunnelPromise) {
            tunnelPromise.then((r) => r.cleanup()).catch(() => {});
          }
          await this.queueService.updateStatus(entry.id, 'failed', result.error);
          return;
        }
      }

      let publicEndpointMeta:
        | Pick<
            Awaited<ReturnType<VllmPublicEndpointResolver['resolve']>>,
            'localPort' | 'sshForward' | 'tunnelService' | 'publicEndpointUrl'
          >
        | undefined;

      // Await pre-warmed tunnel or start fresh.
      if (run.deployment && this.config) {
        let resolved: Awaited<ReturnType<VllmPublicEndpointResolver['resolve']>>;
        if (tunnelPromise) {
          resolved = await tunnelPromise;
        } else {
          const resolver = new VllmPublicEndpointResolver({
            ssh: this.config.ssh,
            tunnel: this.config.tunnel,
            logLevel: this.config.logLevel,
          });
          resolved = await resolver.resolve(run.deployment.endpointUrl);
        }

        // Pre-warmed tunnel may have fallen back to direct VM URL if vLLM was
        // still loading when the SSH forward health check ran. Now that Stage 1
        // has passed, vLLM is guaranteed to be serving — retry tunnel resolution.
        if (!resolved.tunneled && tunnelPromise && this.config.tunnel?.enabled) {
          this.logger.info('Scheduler: pre-warmed tunnel fell back to direct URL — retrying now that vLLM is serving');
          await resolved.cleanup();
          const freshResolver = new VllmPublicEndpointResolver({
            ssh: this.config.ssh,
            tunnel: this.config.tunnel,
            logLevel: this.config.logLevel,
          });
          resolved = await freshResolver.resolve(run.deployment.endpointUrl);
        }

        run.deployment.endpointUrl = resolved.endpointUrl;
        run.deployment.publicEndpointUrl = resolved.publicEndpointUrl;
        publicEndpointMeta = resolved;
        if (resolved.tunneled) {
          this.logger.info('Scheduler: using public vLLM endpoint', {
            endpointUrl: resolved.endpointUrl,
            directUrl: resolved.directUrl,
          });
        }
        releasePublicEndpoint = resolved.cleanup;
      }

      // Gate: skip expensive CI evals if model doesn't meet stage2Thresholds
      if (
        this.ciEvals?.enabled &&
        run.benchmarkResult &&
        run.benchmarkResult.stage2Eligible === false
      ) {
        this.logger.warn('Scheduler: skipping CI evals — model failed stage2 eligibility thresholds', {
          modelId: run.modelId,
          metrics: run.benchmarkResult.metrics,
        });
      }

      // CI Evals pipeline (weekly matrix Buildkite build)
      let deferPostStage2 = false;
      if (this.ciEvals?.enabled && run.deployment && run.benchmarkResult?.stage2Eligible !== false) {
        let skipSuiteIds: string[] | undefined;
        if (options?.resume && this.resultsStore && this.config) {
          const priorResults = await this.resultsStore.getCIEvalResults(run.modelId, {
            limit: 30,
          });
          const evalSuites = this.config.buildkite?.defaultEvalSuites ?? [];
          skipSuiteIds = this.ciEvals.buildkiteTrigger
            ? await resolveCompletedEvalSuites(
                priorResults,
                evalSuites,
                this.ciEvals.buildkiteTrigger,
              )
            : [];
          if (skipSuiteIds.length > 0) {
            this.logger.info('CI Evals: skipping suites already completed before resume', {
              modelId: run.modelId,
              skipSuiteIds,
            });
          }
        }

        const ciOutcome = await this.runCIEvals(
          run,
          entry.id,
          {
            releasePublicEndpoint,
            deploymentName: run.deployment.deploymentName,
            localPort: publicEndpointMeta?.localPort,
            sshForward: publicEndpointMeta?.sshForward,
            tunnelService: publicEndpointMeta?.tunnelService,
            publicEndpointUrl: publicEndpointMeta?.publicEndpointUrl,
          },
          skipSuiteIds,
        );

        if (ciOutcome.aborted) {
          await this.queueService.updateStatus(entry.id, 'failed', ciOutcome.abortReason);
          return;
        }

        if (ciOutcome.stage2Result) {
          run.stage2Result = ciOutcome.stage2Result;
          if (this.resultsStore) {
            await this.resultsStore.saveStage2Result(ciOutcome.stage2Result);
          }
        }

        deferPostStage2 = ciOutcome.deferTeardown;
        deferInfrastructureTeardown = deferPostStage2;
        if (deferPostStage2) {
          releasePublicEndpoint = undefined;
        }
      }

      // Local Stage 2 evals — skip when Buildkite CI evals are the source of truth
      const useCiEvalsAsStage2 = Boolean(this.ciEvals?.enabled);
      if (this.stage2Worker && !useCiEvalsAsStage2 && run.benchmarkResult) {
        const stage2Result = await this.stage2Worker.execute(run, run.benchmarkResult);
        run.stage2Result = stage2Result;

        if (this.resultsStore) {
          await this.resultsStore.saveStage2Result(stage2Result);
        }

        if (stage2Result.status === 'error') {
          await this.queueService.updateStatus(entry.id, 'failed', stage2Result.reason);
          return;
        }
      } else if (useCiEvalsAsStage2 && !run.stage2Result && !deferPostStage2) {
        this.logger.warn('CI evals enabled but no Stage 2 result was produced');
      }

      if (deferPostStage2) {
        // Stage 3 + report run after detached Buildkite poll completes.
        return;
      }

      await this.finalizePipeline(run, entry.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.queueService.updateStatus(entry.id, 'failed', message);
    } finally {
      if (!deferInfrastructureTeardown) {
        await this.releaseInfrastructure({
          releasePublicEndpoint,
          deploymentName: run.deployment?.deploymentName,
        });
      }
    }
  }

  /** Stage 3 reasoning, recommendation report, queue completion, Slack. */
  private async finalizePipeline(run: PipelineRun, queueEntryId: string): Promise<void> {
    if (this.stage3Worker) {
      const stage3Result = await this.stage3Worker.execute(run);
      run.stage3Result = stage3Result;
      if (this.resultsStore) {
        await this.resultsStore.saveReasoningResult(stage3Result);
      }
      if (stage3Result.status === 'error') {
        this.logger.warn('Stage 3 reasoning failed (non-fatal)', {
          error: stage3Result.error,
        });
      }
    }

    let report: RecommendationReport | undefined;
    if (this.resultsStore && this.config) {
      try {
        report = buildRecommendationReport(run, { config: this.config });
        await this.resultsStore.saveRecommendationReport(report);
      } catch {
        // Report generation failure should not block pipeline completion
      }
    }

    const stage2Failed =
      run.stage2Result?.status === 'failed' || run.stage2Result?.status === 'error';
    if (stage2Failed) {
      await this.queueService.updateStatus(
        queueEntryId,
        'failed',
        run.stage2Result?.reason ?? 'Stage 2 Kibana CI eval failed',
      );
    } else {
      await this.queueService.updateStatus(queueEntryId, 'completed');
    }

    this.onModelCompleted?.(run.modelId);

    if (report && this.slackNotifier) {
      try {
        await this.slackNotifier.notifyVerdict(report);
      } catch {
        // Notification failure should not block pipeline
      }
    }
  }

  private async resolveEvalArtifactSummary(
    buildkiteTrigger: BuildkiteEvalTrigger,
    buildResult: BuildkiteBuildResult,
  ): Promise<ReturnType<typeof parseEvalArtifactJson>> {
    if (!buildResult.artifacts?.length) return undefined;

    const candidates = buildResult.artifacts.filter(
      (a) =>
        a.filename.endsWith('.json') &&
        (a.filename.includes('eval') ||
          a.filename.includes('result') ||
          a.filename.includes('summary')),
    );

    for (const artifact of candidates) {
      const body = await buildkiteTrigger.downloadArtifact(artifact.url);
      if (!body) continue;
      const summary = parseEvalArtifactJson(body);
      if (summary) return summary;
    }

    return undefined;
  }

  private async releaseInfrastructure(options: {
    releasePublicEndpoint?: () => Promise<void>;
    deploymentName?: string;
    stopGuard?: () => void;
  }): Promise<void> {
    if (options.stopGuard) {
      options.stopGuard();
    }
    if (options.releasePublicEndpoint) {
      try {
        await options.releasePublicEndpoint();
        this.logger.info('Scheduler: public endpoint tunnel released');
      } catch (tunnelErr) {
        this.logger.warn('Scheduler: failed to release public endpoint tunnel', {
          error: tunnelErr instanceof Error ? tunnelErr.message : String(tunnelErr),
        });
      }
    }

    if (options.deploymentName && this.engine && this.config) {
      try {
        this.logger.info('Scheduler: tearing down deployment', {
          deploymentName: options.deploymentName,
        });
        await this.engine.stop(this.config.ssh, options.deploymentName);
        this.logger.info('Scheduler: deployment stopped');
      } catch (stopErr) {
        this.logger.error('Scheduler: failed to stop deployment', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    }
  }

  private scheduleDeferredInfrastructureCleanup(
    queueEntryId: string,
    cleanup: DeferredInfrastructureCleanup,
  ): void {
    this.deferredCleanups.set(queueEntryId, cleanup);
    void cleanup.pollPromise.finally(() => {
      this.deferredCleanups.delete(queueEntryId);
    });
  }

  private async runCIEvals(
    run: PipelineRun,
    queueEntryId: string,
    infrastructure: {
      releasePublicEndpoint?: () => Promise<void>;
      deploymentName: string;
      localPort?: number;
      sshForward?: SshPortForward;
      tunnelService?: TunnelService;
      publicEndpointUrl?: string;
    },
    skipSuiteIds?: string[],
  ): Promise<CIEvalRunResult> {
    if (!this.ciEvals || !run.deployment || !this.config) {
      return { deferTeardown: false };
    }

    const { smokeTest, buildkiteTrigger, detachPoll } = this.ciEvals;
    const endpointUrl = run.deployment.endpointUrl;

    this.logger.info('CI Evals: running smoke test', { modelId: run.modelId });
    const smokeResult = await smokeTest.run(endpointUrl, run.modelId);
    if (!smokeResult.passed) {
      this.logger.warn('CI Evals: smoke test failed', {
        modelId: run.modelId,
        tier: smokeResult.tier,
        details: smokeResult.details,
      });
      return {
        deferTeardown: false,
        aborted: true,
        abortReason: `CI smoke test failed at tier ${smokeResult.tier}`,
      };
    }
    this.logger.info('CI Evals: smoke test passed all tiers', { modelId: run.modelId });

    const buildkiteEndpointUrl = run.deployment.publicEndpointUrl;
    if (!buildkiteEndpointUrl) {
      this.logger.warn('CI Evals: no public ngrok URL — cannot trigger Buildkite', {
        modelId: run.modelId,
        smokeEndpoint: endpointUrl,
      });
      return {
        deferTeardown: false,
        aborted: true,
        abortReason:
          'CI evals require a public ngrok URL (set TUNNEL_ENABLED=true and NGROK_AUTH_TOKEN in .env)',
      };
    }

    const { buildConnectorPayload } = await import('../services/buildkite-connector-builder.js');
    const buildkiteConfig = this.config.buildkite;
    const evalSuites = buildkiteConfig?.defaultEvalSuites ?? ['security_ai_assistant'];
    const { connectorId, connectorJson } = buildConnectorPayload({
      endpointUrl: buildkiteEndpointUrl,
      modelId: run.modelId,
    });

    this.logger.info('CI Evals: triggering weekly matrix Buildkite evals', {
      modelId: run.modelId,
      suites: evalSuites,
      kibanaBranch: buildkiteConfig?.kibanaBranch,
      connectorId,
      detachPoll,
    });

    const startedAt = new Date().toISOString();

    const persistOnDemandResult = async (
      result: BuildkiteBuildResult,
      retryCount: number,
      suiteIds: string[],
    ): Promise<void> => {
      if (!this.resultsStore) return;
      await this.resultsStore.saveCIEvalResult({
        runId: run.runId,
        modelId: run.modelId,
        buildkiteBuildUrl: result.buildUrl,
        buildkiteBuildNumber: result.buildNumber,
        pipelineSlug: buildkiteConfig?.weeklyPipelineSlug ?? 'kibana-evals-weekly-llm-evals',
        status: result.status === 'running' ? 'running' : result.status,
        evalSuites: suiteIds,
        artifacts: result.artifacts
          ? Object.fromEntries(result.artifacts.map((a) => [a.filename, a.url]))
          : undefined,
        startedAt,
        completedAt: new Date().toISOString(),
        retryCount,
        connectorJson,
      });
    };


    const pollWeeklyMatrix = async (): Promise<Stage2Result> => {
      const suitesToRun = evalSuites.filter((id) => !skipSuiteIds?.includes(id));
      if (suitesToRun.length === 0) {
        this.logger.warn('CI Evals: all suites already completed — nothing to run', {
          modelId: run.modelId,
        });
        return {
          status: 'success',
          modelId: run.modelId,
          runId: run.runId,
          suiteResults: evalSuites.map((suite) => ({ suite, status: 'passed' })),
          reason: 'All suites completed before resume',
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }

      // On-demand pipeline supports vLLM connectors via KIBANA_TESTING_AI_CONNECTORS;
      // the weekly matrix only accepts pre-registered EIS connectors. Run each suite
      // as a separate on-demand build (sequential, per AGENTS.md on-demand contract).
      this.logger.info('CI Evals: triggering on-demand evals (one build per suite)', {
        modelId: run.modelId,
        suites: suitesToRun,
        pipeline: buildkiteConfig?.onDemandPipelineSlug ?? 'kibana-evals-on-demand-llm-evals',
      });

      const perSuiteResults: Array<{ suite: string; status: string; buildUrl: string; buildNumber: number }> = [];
      let overallStatus = 'passed';

      const maxSkipRetries = buildkiteConfig?.maxSkipRetries ?? 5;
      const skipRetryBackoffMs = buildkiteConfig?.skipRetryBackoffMs ?? 30_000;

      // Trigger + poll one suite, re-triggering when Buildkite skips/cancels the queued build
      // before it runs (skip_queued_branch_builds on the shared branch) and retrying once on a
      // genuine eval failure. createOnDemandBuildOrAdopt waits for the pipeline to be idle
      // (no running OR scheduled builds), so each re-trigger only fires once the branch clears.
      const runSuiteBuild = async (suite: string): Promise<BuildkiteBuildResult> => {
        let attemptCount = 0;
        let infraRetries = 0;
        let evalRetried = false;

        for (;;) {
          const triggered = await buildkiteTrigger.createOnDemandBuildOrAdopt({
            connectorJson,
            connectorId,
            evalSuiteIds: [suite],
            modelId: run.modelId,
          });

          await persistOnDemandResult(
            { buildUrl: triggered.buildUrl, buildNumber: triggered.buildNumber, status: 'running' },
            attemptCount,
            [suite],
          );

          const buildResult = await buildkiteTrigger.waitForBuild(
            triggered.pipelineSlug,
            triggered.buildNumber,
            triggered.buildUrl,
          );
          attemptCount += 1;
          await persistOnDemandResult(buildResult, attemptCount, [suite]);

          if (isRetriableInfraState(buildResult.terminalState) && infraRetries < maxSkipRetries) {
            infraRetries += 1;
            this.logger.warn(
              'CI Evals: build was skipped/canceled by Buildkite before running — re-triggering after idle',
              {
                modelId: run.modelId,
                suite,
                terminalState: buildResult.terminalState,
                buildUrl: buildResult.buildUrl,
                infraRetry: infraRetries,
                maxSkipRetries,
              },
            );
            if (skipRetryBackoffMs > 0) {
              await new Promise((r) => setTimeout(r, skipRetryBackoffMs));
            }
            continue;
          }

          if (
            buildResult.status === 'failed' &&
            !isRetriableInfraState(buildResult.terminalState) &&
            buildkiteConfig?.retryOnFailure !== false &&
            !evalRetried
          ) {
            evalRetried = true;
            this.logger.info('CI Evals: retrying on-demand build (attempt 2)', {
              modelId: run.modelId,
              suite,
            });
            continue;
          }

          return buildResult;
        }
      };

      for (const suite of suitesToRun) {
        this.logger.info('CI Evals: triggering on-demand build', {
          modelId: run.modelId,
          suite,
        });

        const buildResult = await runSuiteBuild(suite);

        this.logger.info('CI Evals: on-demand build completed', {
          modelId: run.modelId,
          suite,
          status: buildResult.status,
          terminalState: buildResult.terminalState,
          buildUrl: buildResult.buildUrl,
        });

        perSuiteResults.push({
          suite,
          status: buildResult.status,
          buildUrl: buildResult.buildUrl,
          buildNumber: buildResult.buildNumber,
        });
        if (buildResult.status !== 'passed') overallStatus = 'failed';
      }

      // Aggregate per-suite results into a single Stage2Result. Use the last build
      // for artifact resolution; suite-level outcomes are in suiteResults.
      const lastResult = perSuiteResults[perSuiteResults.length - 1];
      if (!lastResult) {
        return {
          status: 'failed',
          modelId: run.modelId,
          runId: run.runId,
          suiteResults: [],
          reason: 'No suites ran',
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
      const aggregatedBuildResult: BuildkiteBuildResult = {
        status: overallStatus as BuildkiteBuildResult['status'],
        buildNumber: lastResult.buildNumber,
        buildUrl: lastResult.buildUrl,
      };
      const artifactSummary = await this.resolveEvalArtifactSummary(
        buildkiteTrigger,
        aggregatedBuildResult,
      );
      const stage2 = mapBuildkiteResultToStage2(
        run.runId,
        run.modelId,
        suitesToRun,
        aggregatedBuildResult,
        artifactSummary,
        startedAt,
      );
      // Override suiteResults with per-suite outcomes from the loop above
      stage2.suiteResults = perSuiteResults.map((r) => ({ suite: r.suite, status: r.status }));
      return stage2;
    };

    if (detachPoll) {
      let stopGuard: (() => void) | undefined;
      if (
        this.ciEvals?.sshPool &&
        infrastructure.localPort &&
        infrastructure.sshForward &&
        this.config
      ) {
        const guard = new CiEvalInfrastructureGuard({
          ssh: this.config.ssh,
          sshPool: this.ciEvals.sshPool,
          localPort: infrastructure.localPort,
          deploymentName: infrastructure.deploymentName,
          sshForward: infrastructure.sshForward,
          tunnelService: infrastructure.tunnelService,
          publicEndpointUrl: infrastructure.publicEndpointUrl,
          logLevel: this.config.logLevel,
        });
        guard.start();
        stopGuard = () => guard.stop();
        this.logger.info('CI Evals: infrastructure guard active during Buildkite poll', {
          modelId: run.modelId,
          localPort: infrastructure.localPort,
        });
      }

      const pollPromise = pollWeeklyMatrix()
        .then(async (stage2Result) => {
          run.stage2Result = stage2Result;
          if (this.resultsStore) {
            await this.resultsStore.saveStage2Result(stage2Result);
          }
          await this.finalizePipeline(run, queueEntryId);
        })
        .catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const transient = msg.includes('fetch failed') ||
            msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
            msg.includes('ENOTFOUND') || msg.toLowerCase().includes('network');
          if (transient) {
            // Transient network errors (fetch failed, ECONN*) should NOT tear down
            // the vLLM deployment or mark the queue entry as permanently failed —
            // the Buildkite build may still be running and the operator can resume.
            // Observed regression: 2026-06-30 run abandoned mid-suite due to one blip.
            this.logger.error(
              'CI Evals: detached Buildkite poll hit transient network error — NOT tearing down deployment; queue entry remains active for manual resume',
              { modelId: run.modelId, error: msg },
            );
            return;
          }
          this.logger.error('CI Evals: detached Buildkite poll failed', {
            modelId: run.modelId,
            error: msg,
          });
          await this.queueService.updateStatus(
            queueEntryId,
            'failed',
            msg,
          );
        })
        .then(() =>
          this.releaseInfrastructure({
            releasePublicEndpoint: infrastructure.releasePublicEndpoint,
            deploymentName: infrastructure.deploymentName,
            stopGuard,
          }),
        );

      this.scheduleDeferredInfrastructureCleanup(queueEntryId, {
        releasePublicEndpoint: infrastructure.releasePublicEndpoint,
        deploymentName: infrastructure.deploymentName,
        pollPromise,
        stopGuard,
      });

      return { deferTeardown: true };
    }

    const stage2Result = await pollWeeklyMatrix();
    return { deferTeardown: false, stage2Result };
  }
}
