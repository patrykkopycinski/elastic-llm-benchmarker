import type { QueueService, QueueEntry } from '../services/queue-service.js';
import { DEFAULT_ENTRY_STALE_AFTER_MS } from '../services/queue-service.js';
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
  buildResumeStage2Result,
  mapBuildkiteResultToStage2,
  mergeStage2Results,
  parseEvalArtifactJson,
} from '../services/ci-eval-stage2-mapper.js';
import type { Stage2Result } from './pipeline-state.js';
import type { Logger } from 'winston';
import { createLogger } from '../utils/logger.js';
import { classifyFailure } from '../utils/failure-classifier.js';
import { compileModelExcludeMatchers, findMatchingExcludePattern } from '../utils/model-exclude.js';
import { VllmPublicEndpointResolver } from '../services/vllm-public-endpoint.js';
import { CiEvalInfrastructureGuard } from '../services/ci-eval-infrastructure-guard.js';
import { resolveCompletedEvalSuites } from '../services/ci-eval-resume.js';
import type { SSHClientPool } from '../services/ssh-client.js';
import type { TunnelService } from '../services/tunnel-service.js';
import type { SshPortForward } from '../utils/ssh-port-forward.js';
import { progressNow, reportQueueProgress } from '../utils/queue-progress.js';

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
  /** entryId → lease token held for the entry currently being processed. */
  private readonly entryLeases = new Map<string, string>();
  /** Tracks whether the daily cost cap is currently gating dequeues (log-once). */
  private costCapEngaged = false;
  /** Epoch ms of the last periodic stuck-entry reclaim (throttled to TTL). */
  private lastReclaimAtMs = 0;

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

  /**
   * Refresh the heartbeat on every entry this daemon is actively processing so
   * a restart's stale-entry reclaim (and any second daemon) never reclaims a
   * live run. Best-effort: a failed heartbeat is logged, not fatal.
   */
  private async heartbeatActiveEntries(): Promise<void> {
    for (const [entryId, token] of this.entryLeases) {
      try {
        await this.queueService.heartbeat(entryId, token);
      } catch (err) {
        this.logger.warn('Scheduler: queue entry heartbeat failed', {
          queueEntryId: entryId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Every entry id this daemon is actively responsible for right now. */
  private ownedEntryIds(): Set<string> {
    return new Set<string>([
      ...this.entryLeases.keys(),
      ...this.entryInProcess,
      ...this.deferredCleanups.keys(),
    ]);
  }

  /**
   * Periodic backstop: reset entries stuck in `deploying`/`benchmarking` past
   * the heartbeat TTL back to `pending` so a crashed/abandoned run is retried
   * automatically — no more manual `curl` resets. Never touches an entry this
   * daemon owns (it heartbeats those every poll, keeping them fresh) and is
   * throttled to at most once per TTL to keep ES load negligible. Runs
   * alongside the one-shot startup reclaim in `cli.ts`.
   */
  private async reclaimStuckEntries(): Promise<void> {
    const staleAfterMs = this.config?.scheduler?.entryStaleAfterMs ?? DEFAULT_ENTRY_STALE_AFTER_MS;
    const nowMs = Date.now();
    if (nowMs - this.lastReclaimAtMs < staleAfterMs) return;
    this.lastReclaimAtMs = nowMs;
    try {
      const reclaimed = await this.queueService.reclaimStaleEntries(
        staleAfterMs,
        this.ownedEntryIds(),
      );
      if (reclaimed > 0) {
        this.logger.warn('Scheduler: reclaimed stuck in-flight entries to pending (periodic backstop)', {
          count: reclaimed,
        });
      }
    } catch (err) {
      this.logger.warn('Scheduler: periodic stuck-entry reclaim failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Write a terminal status (`completed`/`failed`) fenced by the held lease
   * token, so a zombie daemon whose lease was reclaimed/adopted cannot clobber
   * the live owner. Falls back to an unfenced write only for legacy/unclaimed
   * entries with no token. Returns whether the write was applied.
   */
  private async writeTerminal(
    id: string,
    status: 'completed' | 'failed',
    errorMessage: string | undefined,
    leaseToken: string | undefined,
  ): Promise<boolean> {
    if (!leaseToken) {
      return this.queueService.updateStatus(id, status, errorMessage);
    }
    const result =
      status === 'completed'
        ? await this.queueService.complete(id, leaseToken)
        : await this.queueService.fail(id, errorMessage ?? 'failed', leaseToken);
    if (!result.applied && result.reason === 'lease-mismatch') {
      this.logger.warn('Scheduler: terminal write fenced out — lease no longer held, another owner controls this entry', {
        queueEntryId: id,
        status,
      });
    }
    return result.applied;
  }

  /**
   * True when the daily cost cap is enabled and the number of models that
   * reached a terminal state since 00:00 UTC today meets/exceeds the ceiling.
   * Logs once on each engage/release transition to avoid per-poll spam.
   * Fails open (returns false) if the count query errors — a monitoring blip
   * must never wedge the pipeline into a permanent pause.
   */
  private async isDailyCostCapReached(): Promise<boolean> {
    const caps = this.config?.costCaps;
    if (!caps?.enabled) return false;

    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    let terminalToday: number;
    try {
      terminalToday = await this.queueService.countTerminalSince(startOfUtcDay.toISOString());
    } catch (err) {
      this.logger.warn('Scheduler: cost-cap count query failed — failing open (no pause)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    const reached = terminalToday >= caps.maxModelsPerDay;
    if (reached && !this.costCapEngaged) {
      this.costCapEngaged = true;
      this.logger.warn('Scheduler: daily cost cap reached — pausing new model intake (VM stays up, in-flight runs finish)', {
        terminalToday,
        maxModelsPerDay: caps.maxModelsPerDay,
      });
    } else if (!reached && this.costCapEngaged) {
      this.costCapEngaged = false;
      this.logger.info('Scheduler: daily cost cap cleared — resuming model intake', {
        terminalToday,
        maxModelsPerDay: caps.maxModelsPerDay,
      });
    }
    return reached;
  }

  /**
   * Recency backstop for the queue. If `entry` targets a model matching
   * `discoveryScheduler.excludeModelPatterns` AND was not force-enqueued, mark
   * it `failed` (fenced by `leaseToken`) and return true so the caller skips it.
   *
   * Discovery already refuses to queue denylisted models, so this only fires for
   * (a) a leftover entry queued before its pattern was added and (b) an in-flight
   * entry a restart would otherwise resume. Force-enqueued entries are the
   * operator's explicit override and are always honored.
   */
  private async retireIfRecencyExcluded(
    entry: QueueEntry,
    leaseToken: string | null,
  ): Promise<boolean> {
    if (entry.metadata?.force === true) return false;
    const matchers = compileModelExcludeMatchers(this.config?.discoveryScheduler?.excludeModelPatterns);
    const matched = findMatchingExcludePattern(entry.modelId, matchers);
    if (!matched) return false;

    this.logger.warn(
      'Scheduler: retiring queue entry — model matches excludeModelPatterns (outdated generation); enqueue with --force to override',
      { queueEntryId: entry.id, modelId: entry.modelId, pattern: matched.source, status: entry.status },
    );
    const reason = `Skipped: matches excludeModelPatterns (${matched.source}) — outdated generation`;
    // Retire as `cancelled` (not `failed`): a denylist skip never ran and
    // incurred no CI-eval/EIS cost, so it must not consume daily cost-cap budget
    // or block re-discovery. `cancelled` is excluded from both.
    if (leaseToken) {
      const res = await this.queueService.cancelActive(entry.id, reason, leaseToken);
      if (!res.applied) {
        this.logger.warn('Scheduler: recency-excluded entry not retired cleanly', {
          queueEntryId: entry.id,
          reason: res.reason,
        });
      }
    } else {
      // No lease held (unexpected post claim/adopt): fall back to an unfenced
      // admin status write so the entry still leaves the active set.
      await this.queueService.updateStatus(entry.id, 'cancelled');
    }
    return true;
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    await this.heartbeatActiveEntries();
    await this.reclaimStuckEntries();
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
        // Take over the lease abandoned by the previous daemon so our heartbeat
        // keeps the entry fresh (prevents a concurrent reclaim to `pending`).
        const adoptedToken = (await this.queueService.adoptEntry(inFlight.id)) ?? inFlight.leaseToken;
        if (adoptedToken) this.entryLeases.set(inFlight.id, adoptedToken);
        // Recency backstop: never resume a Stage-1/CI-eval run for a model the
        // operator has since denylisted. Discovery cannot un-queue an already
        // in-flight entry, so a restart would otherwise redeploy an outdated
        // model. `--force`-enqueued entries are honored.
        if (await this.retireIfRecencyExcluded(inFlight, adoptedToken ?? null)) {
          this.entryLeases.delete(inFlight.id);
          return;
        }
        this.activeRuns++;
        this.entryInProcess.add(inFlight.id);
        this.processEntry(inFlight, { resume: true }).finally(() => {
          this.activeRuns--;
          this.entryInProcess.delete(inFlight.id);
          // Keep the lease for deferred (detached-poll) entries so we keep
          // heartbeating them until the poll completes; the deferred cleanup
          // drops the lease. Otherwise the periodic reclaimer could reset a
          // still-running deferred run to pending.
          if (!this.deferredCleanups.has(inFlight.id)) {
            this.entryLeases.delete(inFlight.id);
          }
        });
        return;
      }

      // Cost cap: pause NEW work intake once the daily terminal-model ceiling is
      // hit. This gates only new dequeues — never the VM (stopping = loss) and
      // never in-flight/resume runs (handled above). Capping models/day caps the
      // downstream CI-eval builds + EIS reasoning each model triggers.
      if (await this.isDailyCostCapReached()) return;

      const entry = await this.queueService.dequeue();
      if (!entry) return;

      if (entry.leaseToken) this.entryLeases.set(entry.id, entry.leaseToken);
      // Recency backstop: retire a leftover pending entry whose model was
      // denylisted after it was queued (discovery already refuses to enqueue
      // such models). `--force`-enqueued entries are honored.
      if (await this.retireIfRecencyExcluded(entry, entry.leaseToken)) {
        this.entryLeases.delete(entry.id);
        return;
      }
      this.activeRuns++;
      this.entryInProcess.add(entry.id);

      // Run in background (don't await)
      this.processEntry(entry).finally(() => {
        this.activeRuns--;
        this.entryInProcess.delete(entry.id);
        if (!this.deferredCleanups.has(entry.id)) {
          this.entryLeases.delete(entry.id);
        }
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

    // The lease token stamped on claim/adopt. Every terminal write for this
    // entry — including those in the detached Buildkite poll that runs after
    // this method returns — is fenced with it, so a zombie daemon can't clobber
    // us. Captured here because `entryLeases` is released once this returns.
    const leaseToken = this.entryLeases.get(entry.id);

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
          await this.failEntry(entry, result.error ?? 'Stage 1 benchmark failed', leaseToken);
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

      // Local Stage 2 gate (`local` / `localThenWeekly` tiers): run the local
      // eval-suite-runner first. Its own Stage2Gate already re-checks the
      // Stage 1 thresholds, so a model that failed stage2Eligible above comes
      // back `skipped` here rather than needing a second external check.
      // When Buildkite is also wired (`localThenWeekly`), a passing local gate
      // is the signal to spend the slower/costlier weekly matrix on this
      // model; a failing/skipped gate short-circuits and the weekly matrix is
      // never triggered — that's the whole point of the gate.
      const localStage2Worker = this.stage2Worker;
      const hasLocalGate = Boolean(localStage2Worker);
      let localGatePassed = true;
      if (localStage2Worker && run.benchmarkResult) {
        const stage2Result = await localStage2Worker.execute(run, run.benchmarkResult);
        run.stage2Result = stage2Result;

        if (this.resultsStore) {
          await this.resultsStore.saveStage2Result(stage2Result);
        }

        if (stage2Result.status === 'error') {
          await this.failEntry(entry, stage2Result.reason ?? 'Stage 2 eval error', leaseToken);
          return;
        }

        localGatePassed = stage2Result.status === 'success';
        if (!localGatePassed) {
          this.logger.info(
            'Scheduler: local Stage 2 gate did not pass — skipping weekly matrix promotion',
            {
              modelId: run.modelId,
              status: stage2Result.status,
              reason: stage2Result.reason,
            },
          );
        }
      }

      // CI Evals pipeline (weekly matrix Buildkite build). Gated on the local
      // Stage 2 gate passing when one is configured (`localThenWeekly`); runs
      // unconditionally when there's no local gate (pure `buildkiteWeekly`).
      let deferPostStage2 = false;
      if (
        this.ciEvals?.enabled &&
        localGatePassed &&
        run.deployment &&
        run.benchmarkResult?.stage2Eligible !== false
      ) {
        let skipSuiteIds: string[] | undefined;
        if (options?.resume && this.resultsStore && this.config) {
          const priorResults = await this.resultsStore.getCIEvalResults(run.modelId, {
            limit: 30,
          });
          // Scope completed-suite detection to THIS queue entry. `getCIEvalResults`
          // is keyed by modelId across all history, so a previous fully-evaluated
          // run of the same model would otherwise mark every suite complete and
          // silently no-op Stage 2 on a fresh re-benchmark. `queueEntryId` is stable
          // across resumes of the same entry; rows written before it existed have
          // it undefined and are conservatively ignored (suite re-runs, never skips).
          const entryResults = priorResults.filter((r) => r.queueEntryId === entry.id);
          const evalSuites = this.config.buildkite?.defaultEvalSuites ?? [];
          skipSuiteIds = this.ciEvals.buildkiteTrigger
            ? await resolveCompletedEvalSuites(
                entryResults,
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
          leaseToken,
          skipSuiteIds,
        );

        if (ciOutcome.aborted) {
          await this.failEntry(entry, ciOutcome.abortReason ?? 'CI eval aborted', leaseToken);
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

      if (this.ciEvals?.enabled && !hasLocalGate && !run.stage2Result && !deferPostStage2) {
        this.logger.warn('CI evals enabled but no Stage 2 result was produced');
      }

      if (deferPostStage2) {
        // Stage 3 + report run after detached Buildkite poll completes.
        return;
      }

      await this.finalizePipeline(run, entry.id, leaseToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failEntry(entry, message, leaseToken);
    } finally {
      if (!deferInfrastructureTeardown) {
        await this.releaseInfrastructure({
          releasePublicEndpoint,
          deploymentName: run.deployment?.deploymentName,
        });
      }
    }
  }

  /**
   * Terminal-failure chokepoint: classify the failure and either auto-re-enqueue
   * the model (transient-infra / resource-fit, within budget) or mark it failed
   * (quarantine). The failed status is always written with the held lease token
   * so a zombie daemon can't clobber a live owner. The re-enqueued entry carries
   * an incremented `infraRetryCount` so the budget is enforced across restarts.
   *
   * ponytail: resource-fit retries currently re-run at the same concurrency —
   * the budget (default 1) bounds the waste; per-entry concurrency-override on
   * retry is the upgrade path.
   */
  private async failEntry(
    entry: QueueEntry,
    message: string,
    leaseToken: string | undefined,
  ): Promise<void> {
    const classification = classifyFailure(message);
    const retryEnabled = this.config?.retry?.enabled !== false;
    const retryCount = entry.metadata?.infraRetryCount ?? 0;
    const budget =
      classification.category === 'resource-fit'
        ? (this.config?.retry?.maxResourceFitRetries ?? 1)
        : (this.config?.retry?.maxInfraRetries ?? 2);
    const willRetry = retryEnabled && classification.retriable && retryCount < budget;
    // Tag classified failures so operators can triage by category in the queue;
    // leave `unknown` messages pristine (a `[unknown]` prefix is just noise).
    const tagged =
      classification.category === 'unknown'
        ? message
        : `[${classification.category}] ${message}`;
    const statusMessage = willRetry ? `${tagged} (auto-retry ${retryCount + 1}/${budget})` : tagged;

    const applied = await this.writeTerminal(entry.id, 'failed', statusMessage, leaseToken);
    if (!applied) {
      // Fenced out (lease lost) or already terminal — another owner controls
      // this entry now. Do NOT re-enqueue: that would duplicate the model.
      return;
    }

    if (willRetry) {
      try {
        await this.queueService.enqueue(
          entry.modelId,
          entry.source,
          entry.priority,
          entry.requestedBy ?? undefined,
          {
            ...entry.metadata,
            infraRetryCount: retryCount + 1,
            reason: `auto-retry after ${classification.category} failure`,
          },
        );
        this.logger.warn('Scheduler: transient failure — re-enqueued for auto-retry', {
          modelId: entry.modelId,
          category: classification.category,
          attempt: retryCount + 1,
          budget,
        });
      } catch (err) {
        this.logger.error('Scheduler: failed to re-enqueue after transient failure', {
          modelId: entry.modelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (classification.retriable) {
      this.logger.warn('Scheduler: retry budget exhausted — quarantining model', {
        modelId: entry.modelId,
        category: classification.category,
        retryCount,
        budget,
      });
    }
  }

  /** Stage 3 reasoning, recommendation report, queue completion, Slack. */
  private async finalizePipeline(
    run: PipelineRun,
    queueEntryId: string,
    leaseToken: string | undefined,
  ): Promise<void> {
    if (this.stage3Worker) {
      await reportQueueProgress(
        this.queueService,
        queueEntryId,
        progressNow('stage3_reasoning', 'Generating recommendation via EIS reasoning'),
        leaseToken,
      );
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
      await reportQueueProgress(
        this.queueService,
        queueEntryId,
        progressNow('finalize', 'Building recommendation report'),
        leaseToken,
      );
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
      await this.writeTerminal(
        queueEntryId,
        'failed',
        run.stage2Result?.reason ?? 'Stage 2 Kibana CI eval failed',
        leaseToken,
      );
    } else {
      await this.writeTerminal(queueEntryId, 'completed', undefined, leaseToken);
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
      // Deferred poll (and its terminal write via finalizePipeline) is done —
      // release the lease we retained so it stayed heartbeated.
      this.entryLeases.delete(queueEntryId);
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
    leaseToken: string | undefined,
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
        queueEntryId: run.queueEntryId,
        modelId: run.modelId,
        buildkiteBuildUrl: result.buildUrl,
        buildkiteBuildNumber: result.buildNumber,
        pipelineSlug: buildkiteConfig?.weeklyPipelineSlug ?? 'kibana-evals-weekly-llm-evals',
        status: result.status === 'running' ? 'running' : result.status,
        buildkiteState: result.terminalState,
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
        return buildResumeStage2Result(run.runId, run.modelId, evalSuites, startedAt);
      }

      // On-demand pipeline supports vLLM connectors via KIBANA_TESTING_AI_CONNECTORS;
      // the weekly matrix only accepts pre-registered EIS connectors. Run each suite
      // as a separate on-demand build (sequential, per AGENTS.md on-demand contract).
      this.logger.info('CI Evals: triggering on-demand evals (one build per suite)', {
        modelId: run.modelId,
        suites: suitesToRun,
        pipeline: buildkiteConfig?.onDemandPipelineSlug ?? 'kibana-evals-on-demand-llm-evals',
      });

      const perSuiteStage2: Stage2Result[] = [];

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

        // Resolve THIS suite's artifacts — scores live in the suite's own build,
        // not the last suite's — and map to a per-suite Stage2Result keyed by the
        // suite name. Resolving only the last build (the old behavior) collapsed
        // every suite's score onto one build, leaving the others null → 0 and
        // dragging otherwise-passing models to an "investigate" verdict.
        const suiteArtifactSummary = await this.resolveEvalArtifactSummary(
          buildkiteTrigger,
          buildResult,
        );
        perSuiteStage2.push(
          mapBuildkiteResultToStage2(
            run.runId,
            run.modelId,
            [suite],
            buildResult,
            suiteArtifactSummary,
            startedAt,
          ),
        );
      }

      // Merge per-suite Stage2Results: mergeStage2Results unions each suite's
      // scores map + suiteResults and derives overall status from all suites.
      if (perSuiteStage2.length === 0) {
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
      return mergeStage2Results(perSuiteStage2);
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
          expectedModelId: run.modelId,
          onTakeover: (reason) => {
            // Shared-VM takeover: another benchmarker instance redeployed on this GPU and
            // removed our container. Aborting keeps us from redeploying over their run and
            // from wasting serial pipeline slots on doomed 404 evals. Retriable once free.
            this.logger.error(
              'CI Evals: vLLM deployment taken over externally during Buildkite poll — aborting Stage 2 for this model (retriable)',
              { modelId: run.modelId, reason },
            );
            void this.writeTerminal(
              queueEntryId,
              'failed',
              `Stage 2 aborted: shared-VM takeover — ${reason}. Re-enqueue to retry once the GPU is free.`,
              leaseToken,
            );
          },
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
          await this.finalizePipeline(run, queueEntryId, leaseToken);
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
          await this.writeTerminal(queueEntryId, 'failed', msg, leaseToken);
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
