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
import type { BuildkiteEvalTrigger } from '../services/buildkite-eval-trigger.js';
import type { Logger } from 'winston';
import { createLogger } from '../utils/logger.js';

export interface SchedulerOptions {
  pollIntervalMs: number;
  maxConcurrentRuns: number;
}

export interface CIEvalsOptions {
  enabled: boolean;
  fullEval: boolean;
  smokeTest: ModelSmokeTest;
  buildkiteTrigger: BuildkiteEvalTrigger;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRuns = 0;
  private shuttingDown = false;
  private readonly logger: Logger;

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
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.activeRuns >= this.options.maxConcurrentRuns) return;

    try {
      const pending = await this.queueService.findPending(1);
      if (pending.length === 0) return;

      const entry = pending[0];
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

      // CI Evals pipeline (smoke test → on-demand Buildkite → optional weekly)
      if (this.ciEvals?.enabled && run.deployment) {
        await this.runCIEvals(run);
      }

      // Stage 2 local evals — optional
      if (this.stage2Worker) {
        const stage2Result = await this.stage2Worker.execute(run, result);
        run.stage2Result = stage2Result;

        if (this.resultsStore) {
          await this.resultsStore.saveStage2Result(stage2Result);
        }

        if (stage2Result.status === 'error') {
          await this.queueService.updateStatus(entry.id, 'failed', stage2Result.reason);
          return;
        }
      }

      // Stage 3 reasoning — optional
      if (this.stage3Worker) {
        const stage3Result = await this.stage3Worker.execute(run);
        run.stage3Result = stage3Result;
        if (this.resultsStore) {
          await this.resultsStore.saveReasoningResult(stage3Result);
        }
        if (stage3Result.status === 'error') {
          await this.queueService.updateStatus(entry.id, 'failed', stage3Result.error);
          return;
        }
      }

      // Build and save recommendation report
      let report: RecommendationReport | undefined;
      if (this.resultsStore && this.config) {
        try {
          report = buildRecommendationReport(run, { config: this.config });
          await this.resultsStore.saveRecommendationReport(report);
        } catch {
          // Report generation failure should not block pipeline completion
        }
      }

      await this.queueService.updateStatus(entry.id, 'completed');

      // Send Slack notification for actionable verdicts
      if (report && this.slackNotifier) {
        try {
          await this.slackNotifier.notifyVerdict(report);
        } catch {
          // Notification failure should not block pipeline
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.queueService.updateStatus(entry.id, 'failed', message);
    } finally {
      // Scheduler owns model teardown — clean up regardless of outcome
      if (run.deployment && this.engine && this.config) {
        try {
          this.logger.info('Scheduler: tearing down deployment', {
            deploymentName: run.deployment.deploymentName,
          });
          await this.engine.stop(this.config.ssh, run.deployment.deploymentName);
          this.logger.info('Scheduler: deployment stopped');
        } catch (stopErr) {
          this.logger.error('Scheduler: failed to stop deployment', {
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        }
      }
    }
  }

  private async runCIEvals(run: PipelineRun): Promise<void> {
    if (!this.ciEvals || !run.deployment || !this.config) return;

    const { smokeTest, buildkiteTrigger } = this.ciEvals;
    const endpointUrl = run.deployment.endpointUrl;

    // 1. Layered smoke test
    this.logger.info('CI Evals: running smoke test', { modelId: run.modelId });
    const smokeResult = await smokeTest.run(endpointUrl, run.modelId);
    if (!smokeResult.passed) {
      this.logger.warn('CI Evals: smoke test failed', {
        modelId: run.modelId,
        tier: smokeResult.tier,
        details: smokeResult.details,
      });
      return;
    }
    this.logger.info('CI Evals: smoke test passed all tiers', { modelId: run.modelId });

    // 2. Build connector JSON + trigger on-demand Buildkite eval
    const { buildConnectorJson } = await import('../services/buildkite-connector-builder.js');
    const connectorJson = buildConnectorJson({ endpointUrl, modelId: run.modelId });

    const buildkiteConfig = this.config.buildkite;
    const evalSuites = buildkiteConfig?.defaultEvalSuites ?? ['security_ai_assistant'];

    this.logger.info('CI Evals: triggering on-demand Buildkite eval', {
      modelId: run.modelId,
      suites: evalSuites,
    });

    let onDemandResult = await buildkiteTrigger.triggerOnDemandEval({
      connectorJson,
      evalSuiteIds: evalSuites,
      modelId: run.modelId,
    });

    // Retry once on failure
    if (onDemandResult.status === 'failed' && buildkiteConfig?.retryOnFailure !== false) {
      this.logger.info('CI Evals: retrying on-demand eval (attempt 2)', { modelId: run.modelId });
      onDemandResult = await buildkiteTrigger.triggerOnDemandEval({
        connectorJson,
        evalSuiteIds: evalSuites,
        modelId: run.modelId,
      });
    }

    // Store CI eval result
    if (this.resultsStore) {
      await this.resultsStore.saveCIEvalResult({
        runId: run.runId,
        modelId: run.modelId,
        buildkiteBuildUrl: onDemandResult.buildUrl,
        buildkiteBuildNumber: onDemandResult.buildNumber,
        pipelineSlug: buildkiteConfig?.onDemandPipelineSlug ?? 'kibana-evals-on-demand',
        status: onDemandResult.status === 'running' ? 'error' : onDemandResult.status,
        evalSuites,
        artifacts: onDemandResult.artifacts
          ? Object.fromEntries(onDemandResult.artifacts.map((a) => [a.filename, a.url]))
          : undefined,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        retryCount: onDemandResult.status === 'failed' ? 1 : 0,
        connectorJson,
      });
    }

    this.logger.info('CI Evals: on-demand eval completed', {
      modelId: run.modelId,
      status: onDemandResult.status,
      buildUrl: onDemandResult.buildUrl,
    });

    // 3. Optionally trigger weekly eval if on-demand passed
    if (this.ciEvals.fullEval && onDemandResult.status === 'passed') {
      this.logger.info('CI Evals: triggering full weekly eval', { modelId: run.modelId });
      const weeklyResult = await buildkiteTrigger.triggerWeeklyEval({
        connectorJson,
        modelId: run.modelId,
      });

      if (this.resultsStore) {
        await this.resultsStore.saveCIEvalResult({
          runId: run.runId,
          modelId: run.modelId,
          buildkiteBuildUrl: weeklyResult.buildUrl,
          buildkiteBuildNumber: weeklyResult.buildNumber,
          pipelineSlug: buildkiteConfig?.weeklyPipelineSlug ?? 'kibana-evals-weekly-llm-evals',
          status: weeklyResult.status === 'running' ? 'error' : weeklyResult.status,
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
  }
}
