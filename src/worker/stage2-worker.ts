import type { Logger } from 'winston';
import type { Stage1Result, Stage2Result, PipelineRun } from '../scheduler/pipeline-state.js';
import type { AppConfig } from '../types/config.js';
import type { Stage2Gate } from './stage2-gate.js';
import type { KibanaRepoService } from '../services/kibana-repo-service.js';
import type { EvalSuiteRunner } from '../services/eval-suite-runner.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';

export interface Stage2Worker {
  execute(run: PipelineRun, stage1Result: Stage1Result): Promise<Stage2Result>;
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
  private readonly gate: Stage2Gate;
  private readonly repoService: KibanaRepoService;
  private readonly evalRunner: EvalSuiteRunner;
  private readonly resultsStore: ElasticsearchResultsStore;
  private readonly logger: Logger | undefined;

  constructor(deps: Stage2WorkerDependencies) {
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

      // 3. Clone/pull and bootstrap repo
      this.logger?.info('Stage 2: cloning/pulling Kibana repo', { runId: run.runId });
      await this.repoService.cloneOrPull();
      this.logger?.info('Stage 2: bootstrapping Kibana repo', { runId: run.runId });
      await this.repoService.bootstrap();

      // 4. Run evaluation suite
      this.logger?.info('Stage 2: running eval suite', { runId: run.runId, endpointUrl });
      const evalResult = await this.evalRunner.run({
        repoPath: this.repoService.getRepoPath(),
        endpointUrl,
        modelId: run.modelId,
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

      // 6. Persist result
      await this.resultsStore.saveStage2Result(result);

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
