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
import {
  mapBuildkiteResultToStage2,
  parseEvalArtifactJson,
} from '../services/ci-eval-stage2-mapper.js';
import type { Stage2Result } from './pipeline-state.js';
import type { Logger } from 'winston';
import { createLogger } from '../utils/logger.js';
import { VllmPublicEndpointResolver } from '../services/vllm-public-endpoint.js';

export interface SchedulerOptions {
  pollIntervalMs: number;
  maxConcurrentRuns: number;
}

export interface CIEvalsOptions {
  enabled: boolean;
  fullEval: boolean;
  detachPoll: boolean;
  smokeTest: ModelSmokeTest;
  buildkiteTrigger: BuildkiteEvalTrigger;
}

interface DeferredInfrastructureCleanup {
  releasePublicEndpoint?: () => Promise<void>;
  deploymentName: string;
  pollPromise: Promise<void>;
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
        return;
      }

      const entry = await this.queueService.dequeue();
      if (!entry) return;

      this.activeRuns++;

      // Run in background (don't await)
      this.processEntry(entry).finally(() => {
        this.activeRuns--;
      });
    } catch (err) {
      console.error('Scheduler poll error:', err);
    }
  }

  private async processEntry(entry: QueueEntry): Promise<void> {
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
        await this.queueService.updateStatus(entry.id, 'failed', result.error);
        return;
      }

      // SSH forward + ngrok when tunnel.enabled — CI smoke and Buildkite need a public URL.
      if (run.deployment && this.config) {
        const resolver = new VllmPublicEndpointResolver({
          ssh: this.config.ssh,
          tunnel: this.config.tunnel,
          logLevel: this.config.logLevel,
        });
        const resolved = await resolver.resolve(run.deployment.endpointUrl);
        run.deployment.endpointUrl = resolved.endpointUrl;
        if (resolved.tunneled) {
          this.logger.info('Scheduler: using public vLLM endpoint', {
            endpointUrl: resolved.endpointUrl,
            directUrl: resolved.directUrl,
          });
        }
        releasePublicEndpoint = resolved.cleanup;
      }

      // CI Evals pipeline (smoke test → on-demand Buildkite → optional weekly)
      let deferPostStage2 = false;
      if (this.ciEvals?.enabled && run.deployment) {
        const ciOutcome = await this.runCIEvals(run, entry.id, {
          releasePublicEndpoint,
          deploymentName: run.deployment.deploymentName,
        });

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
      if (this.stage2Worker && !useCiEvalsAsStage2) {
        const stage2Result = await this.stage2Worker.execute(run, result);
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
  }): Promise<void> {
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
    },
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

    const { buildConnectorPayload } = await import('../services/buildkite-connector-builder.js');
    const buildkiteConfig = this.config.buildkite;
    const evalSuites = buildkiteConfig?.defaultEvalSuites ?? ['security_ai_assistant'];
    const { connectorId, connectorJson } = buildConnectorPayload({
      endpointUrl,
      modelId: run.modelId,
      maxTokens: buildkiteConfig?.connectorMaxTokens,
    });

    this.logger.info('CI Evals: triggering on-demand Buildkite eval', {
      modelId: run.modelId,
      suites: evalSuites,
      kibanaBranch: buildkiteConfig?.kibanaBranch,
      connectorId,
      detachPoll,
    });

    const triggered = await buildkiteTrigger.createOnDemandBuild({
      connectorJson,
      connectorId,
      evalSuiteIds: evalSuites,
      modelId: run.modelId,
    });

    const startedAt = new Date().toISOString();

    const buildStage2FromBuild = async (
      buildResult: BuildkiteBuildResult,
    ): Promise<Stage2Result> => {
      const artifactSummary = await this.resolveEvalArtifactSummary(buildkiteTrigger, buildResult);
      return mapBuildkiteResultToStage2(
        run.runId,
        run.modelId,
        evalSuites,
        buildResult,
        artifactSummary,
        startedAt,
      );
    };

    const persistOnDemandResult = async (
      result: BuildkiteBuildResult,
      retryCount: number,
    ): Promise<void> => {
      if (!this.resultsStore) return;
      await this.resultsStore.saveCIEvalResult({
        runId: run.runId,
        modelId: run.modelId,
        buildkiteBuildUrl: result.buildUrl,
        buildkiteBuildNumber: result.buildNumber,
        pipelineSlug: buildkiteConfig?.onDemandPipelineSlug ?? 'kibana-evals-on-demand-llm-evals',
        status: result.status === 'running' ? 'running' : result.status,
        evalSuites,
        artifacts: result.artifacts
          ? Object.fromEntries(result.artifacts.map((a) => [a.filename, a.url]))
          : undefined,
        startedAt,
        completedAt: new Date().toISOString(),
        retryCount,
        connectorJson,
      });
    };

    const pollOnDemand = async (): Promise<Stage2Result> => {
      let onDemandResult = await buildkiteTrigger.waitForBuild(
        triggered.pipelineSlug,
        triggered.buildNumber,
        triggered.buildUrl,
      );

      if (onDemandResult.status === 'failed' && buildkiteConfig?.retryOnFailure !== false) {
        this.logger.info('CI Evals: retrying on-demand eval (attempt 2)', { modelId: run.modelId });
        const retryTriggered = await buildkiteTrigger.createOnDemandBuild({
          connectorJson,
          connectorId,
          evalSuiteIds: evalSuites,
          modelId: run.modelId,
        });
        onDemandResult = await buildkiteTrigger.waitForBuild(
          retryTriggered.pipelineSlug,
          retryTriggered.buildNumber,
          retryTriggered.buildUrl,
        );
        await persistOnDemandResult(onDemandResult, 1);
      } else {
        await persistOnDemandResult(onDemandResult, 0);
      }

      this.logger.info('CI Evals: on-demand eval completed', {
        modelId: run.modelId,
        status: onDemandResult.status,
        buildUrl: onDemandResult.buildUrl,
      });

      if (this.ciEvals?.fullEval && onDemandResult.status === 'passed') {
        this.logger.info('CI Evals: triggering full weekly eval', { modelId: run.modelId });
        const weeklyTriggered = await buildkiteTrigger.triggerWeeklyEval({
          connectorJson,
          modelId: run.modelId,
        });

        let weeklyResult = weeklyTriggered;
        if (weeklyTriggered.status === 'running') {
          weeklyResult = await buildkiteTrigger.waitForBuild(
            buildkiteConfig?.weeklyPipelineSlug ?? 'kibana-evals-weekly-llm-evals',
            weeklyTriggered.buildNumber,
            weeklyTriggered.buildUrl,
          );
        }

        if (this.resultsStore) {
          await this.resultsStore.saveCIEvalResult({
            runId: run.runId,
            modelId: run.modelId,
            buildkiteBuildUrl: weeklyResult.buildUrl,
            buildkiteBuildNumber: weeklyResult.buildNumber,
            pipelineSlug: buildkiteConfig?.weeklyPipelineSlug ?? 'kibana-evals-weekly-llm-evals',
            status: weeklyResult.status === 'running' ? 'running' : weeklyResult.status,
            evalSuites: ['weekly-full'],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            retryCount: 0,
            connectorJson,
          });
        }

        this.logger.info('CI Evals: weekly eval completed', {
          modelId: run.modelId,
          status: weeklyResult.status,
        });
      }

      return buildStage2FromBuild(onDemandResult);
    };

    if (detachPoll) {
      await persistOnDemandResult(
        {
          buildUrl: triggered.buildUrl,
          buildNumber: triggered.buildNumber,
          status: 'running',
        },
        0,
      );

      const pollPromise = pollOnDemand()
        .then(async (stage2Result) => {
          run.stage2Result = stage2Result;
          if (this.resultsStore) {
            await this.resultsStore.saveStage2Result(stage2Result);
          }
          await this.finalizePipeline(run, queueEntryId);
        })
        .catch(async (err) => {
          this.logger.error('CI Evals: detached Buildkite poll failed', {
            modelId: run.modelId,
            error: err instanceof Error ? err.message : String(err),
          });
          await this.queueService.updateStatus(
            queueEntryId,
            'failed',
            err instanceof Error ? err.message : String(err),
          );
        })
        .then(() =>
          this.releaseInfrastructure({
            releasePublicEndpoint: infrastructure.releasePublicEndpoint,
            deploymentName: infrastructure.deploymentName,
          }),
        );

      this.scheduleDeferredInfrastructureCleanup(queueEntryId, {
        releasePublicEndpoint: infrastructure.releasePublicEndpoint,
        deploymentName: infrastructure.deploymentName,
        pollPromise,
      });

      return { deferTeardown: true };
    }

    const stage2Result = await pollOnDemand();
    return { deferTeardown: false, stage2Result };
  }
}
