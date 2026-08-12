import type { Logger } from 'winston';
import type { Stage1Result, Stage2Result, PipelineRun } from '../scheduler/pipeline-state.js';
import type { AppConfig } from '../types/config.js';
import type { Stage2Gate } from './stage2-gate.js';
import type { KibanaRepoService } from '../services/kibana-repo-service.js';
import type { EvalSuiteRunner } from '../services/eval-suite-runner.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';

export interface Stage2Worker {
  execute(run: PipelineRun, stage1Result: Stage1Result): Promise<Stage2Result>;
  /**
   * Force-terminate any in-flight execute() call's underlying process tree.
   * Optional — only implemented by workers that spawn external processes
   * (e.g. the batch runner). Called by the scheduler when the shutdown
   * drain timeout expires with this worker's execute() still pending, so a
   * stuck batch eval doesn't leak an orphaned Playwright/ES/Kibana process
   * tree after the daemon itself exits. See
   * SchedulerOptions.shutdownDrainTimeoutMs.
   */
  killActive?(): void;
}

export interface Stage2WorkerDependencies {
  config: AppConfig;
  gate: Stage2Gate;
  repoService: KibanaRepoService;
  evalRunner: EvalSuiteRunner;
  resultsStore: ElasticsearchResultsStore;
  logger?: Logger;
}

export class Stage2WorkerImpl implements Stage2Worker {
  private readonly config: AppConfig;
  private readonly gate: Stage2Gate;
  private readonly repoService: KibanaRepoService;
  private readonly evalRunner: EvalSuiteRunner;
  private readonly resultsStore: ElasticsearchResultsStore;
  private readonly logger: Logger | undefined;

  constructor(deps: Stage2WorkerDependencies) {
    this.config = deps.config;
    this.gate = deps.gate;
    this.repoService = deps.repoService;
    this.evalRunner = deps.evalRunner;
    this.resultsStore = deps.resultsStore;
    this.logger = deps.logger;
  }

  async execute(run: PipelineRun, stage1Result: Stage1Result): Promise<Stage2Result> {
    const now = () => new Date().toISOString();
    const startedAt = now();

    try {
      // 1. Gate check
      const gateResult = this.gate.check(stage1Result);
      if (!gateResult.proceed) {
        const result: Stage2Result = {
          runId: run.runId,
          modelId: run.modelId,
          status: 'skipped',
          reason: gateResult.reason,
          startedAt,
          completedAt: now(),
        };
        return result;
      }

      // 2. Ensure deployment endpoint exists
      const endpointUrl = run.deployment?.endpointUrl;
      if (!endpointUrl) {
        const result: Stage2Result = {
          runId: run.runId,
          modelId: run.modelId,
          status: 'failed',
          reason: 'No deployment endpoint',
          startedAt,
          completedAt: now(),
        };
        return result;
      }

      // 2b. Stage 2 needs a Kibana instance to create the evaluation connector
      // against. When neither `stage2Local.kibanaUrl` nor `kibanaConnector.url`
      // is configured, `EvalSuiteRunner.buildConnectorConfig()` returns null,
      // no connector is created, and every suite exits non-zero within seconds.
      //
      // That is an INFRASTRUCTURE gap, not evidence about the model — but it
      // used to surface as status 'failed' with all suites failed, which
      // `computeVerdict()` maps to `reject`. Good models were being recorded as
      // rejected because a URL was missing from config. Report it as `skipped`
      // (-> verdict `investigate`, confidence `low`) so the run is visibly
      // inconclusive instead of a false negative.
      //
      // This guard lives on BOTH Stage2WorkerImpl (the live `evalTier=local`
      // path) and createBatchStage2Worker (batch path). Verified 2026-08-12:
      // config has enableStage2=true / evalTier=local / stage2Local empty, so
      // only this worker is wired; the batch-only guard never fired live.
      const stage2KibanaUrl =
        this.config.stage2Local?.kibanaUrl ?? this.config.kibanaConnector?.url;
      const stage2KibanaApiKey =
        this.config.stage2Local?.kibanaApiKey ?? this.config.kibanaConnector?.apiKey;
      if (!stage2KibanaUrl || !stage2KibanaApiKey) {
        const missing = [
          !stage2KibanaUrl ? 'kibanaUrl' : null,
          !stage2KibanaApiKey ? 'kibanaApiKey' : null,
        ].filter(Boolean);
        this.logger?.warn(
          'Stage 2: no Kibana connector configuration — skipping (infrastructure gap, not a model failure)',
          { modelId: run.modelId, missing },
        );
        return {
          runId: run.runId,
          modelId: run.modelId,
          status: 'skipped',
          reason: `Stage 2 infrastructure not configured: missing ${missing.join(' + ')}`,
          startedAt,
          completedAt: now(),
        };
      }

      // 3. Clone/pull and bootstrap repo
      this.logger?.info('Stage 2: cloning/pulling Kibana repo', { runId: run.runId });
      const cloneResult = await this.repoService.cloneOrPull();
      if (!cloneResult.success) {
        const result: Stage2Result = {
          runId: run.runId,
          modelId: run.modelId,
          status: 'failed',
          reason: `Kibana repo clone/pull failed: ${cloneResult.error}`,
          startedAt,
          completedAt: now(),
        };
        return result;
      }
      this.logger?.info('Stage 2: bootstrapping Kibana repo', { runId: run.runId });
      const bootstrapResult = await this.repoService.bootstrap();
      if (!bootstrapResult.success) {
        const result: Stage2Result = {
          runId: run.runId,
          modelId: run.modelId,
          status: 'failed',
          reason: `Kibana repo bootstrap failed: ${bootstrapResult.error}`,
          startedAt,
          completedAt: now(),
        };
        return result;
      }

      // 4. Run evaluation suite
      this.logger?.info('Stage 2: running eval suite', { runId: run.runId, endpointUrl });
      const evalResult = await this.evalRunner.run({
        repoPath: this.repoService.getRepoPath(),
        endpointUrl,
        modelId: run.modelId,
        evalProfile: this.config.stage2Local?.exportProfile === 'dev-vault' ? 'dev-vault' : undefined,
      });

      // 5. Build Stage2Result
      const completedAt = now();
      const status = evalResult.status === 'failed' ? 'failed' : 'success';
      const scores: Record<string, number> = {};
      for (const sr of evalResult.suiteResults) {
        if (sr.score !== undefined) {
          scores[sr.suite] = sr.score;
        }
      }

      const suiteResults = evalResult.suiteResults.map((sr) => ({
        suite: sr.suite,
        status: sr.status,
        score: sr.score,
        error: sr.error,
      }));

      const result: Stage2Result = {
        runId: run.runId,
        modelId: run.modelId,
        status,
        scores,
        suiteResults,
        startedAt,
        completedAt,
      };

      // 6. Persist result (ignore errors)
      try {
        await this.resultsStore.saveStage2Result(result);
      } catch {
        // swallow — result should still be returned
      }

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error('Stage 2 execution error', { error: message, runId: run.runId });
      const result: Stage2Result = {
        runId: run.runId,
        modelId: run.modelId,
        status: 'error',
        reason: message,
        startedAt,
        completedAt: now(),
      };
      return result;
    }
  }
}
