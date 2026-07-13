import type { Logger } from 'winston';
import type { Stage2Result, PipelineRun, Stage1Result } from '../scheduler/pipeline-state.js';
import type { Stage2Worker } from './stage2-worker.js';
import type { Stage2Gate } from './stage2-gate.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { AppConfig } from '../types/config.js';
import type { LocalBatchEvalRunner } from '../services/local-batch-eval-runner.js';

interface BatchStage2WorkerDeps {
  config: AppConfig;
  gate: Stage2Gate;
  batchRunner: LocalBatchEvalRunner;
  resultsStore: ElasticsearchResultsStore;
  logger?: Logger;
}

/**
 * Stage 2 worker that delegates to the skill-dev plugin's batch runner
 * (run-security-evals-batch.sh) instead of the single-suite eval-suite-runner.
 *
 * Activated when `stage2Local.useBatchRunner` is true. The batch runner boots
 * parallel Scout stacks with the merged evals_security_all config, runs all
 * security suites across N workers, and returns a combined result. This avoids
 * the single-stack single-suite bottleneck and leverages the two-stage EIS
 * connector boot that is required for the merged config set.
 */
export function createBatchStage2Worker(deps: BatchStage2WorkerDeps): Stage2Worker {
  const { gate, batchRunner, resultsStore, logger } = deps;

  return {
    async execute(run: PipelineRun, stage1Result: Stage1Result): Promise<Stage2Result> {
      const now = () => new Date().toISOString();
      const startedAt = now();

      const gateResult = gate.check(stage1Result);
      if (!gateResult.proceed) {
        return {
          runId: run.runId,
          modelId: run.modelId,
          status: 'skipped',
          reason: gateResult.reason,
          startedAt,
          completedAt: now(),
        };
      }

      const endpointUrl = run.deployment?.endpointUrl;
      if (!endpointUrl) {
        return {
          runId: run.runId,
          modelId: run.modelId,
          status: 'failed',
          reason: 'No deployment endpoint',
          startedAt,
          completedAt: now(),
        };
      }

      try {
        logger?.info('Stage 2 (batch): starting batch eval', {
          runId: run.runId,
          modelId: run.modelId,
          endpointUrl,
          pauseAlwaysOnStack: deps.config.stage2Local.pauseAlwaysOnStack,
          teardownBatchStack: deps.config.stage2Local.teardownBatchStack,
        });

        const batchResult = await batchRunner.run({
          vllmBaseUrl: endpointUrl,
          modelId: run.modelId,
        });

        const scores: Record<string, number> = {};
        const suiteResults = batchResult.suites.map((s) => ({
          suite: s.suite,
          status: s.status,
          score: s.status === 'pass' ? 1 : 0,
        }));

        for (const sr of suiteResults) {
          scores[sr.suite] = sr.score ?? 0;
        }

        const passCount = suiteResults.filter((sr) => sr.status === 'pass').length;
        const result: Stage2Result = {
          runId: run.runId,
          modelId: run.modelId,
          status: batchResult.status === 'success' ? 'success' : 'failed',
          scores,
          suiteResults,
          startedAt,
          completedAt: batchResult.completedAt,
          reason:
            batchResult.status !== 'success'
              ? `Stage 2 batch ${batchResult.status}: ${passCount}/${suiteResults.length} suites passed`
              : undefined,
        };

        logger?.info('Stage 2 (batch): completed', {
          runId: run.runId,
          modelId: run.modelId,
          status: batchResult.status,
          passCount,
          suiteCount: suiteResults.length,
          summaryPath: batchResult.summaryPath,
          stdoutLogPath: batchResult.stdoutLogPath,
        });

        try {
          await resultsStore.saveStage2Result(result);
        } catch (saveErr: unknown) {
          // Non-fatal: the caller still gets a valid Stage2Result and the
          // pipeline should proceed. But a silently swallowed save means the
          // run vanishes from the golden cluster with zero trace — log it so
          // it's at least visible in the daemon log / observability surface.
          const saveMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
          logger?.warn('Stage 2 (batch): failed to persist result to results store', {
            runId: run.runId,
            modelId: run.modelId,
            error: saveMessage,
          });
        }

        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error('Stage 2 (batch) execution error', { error: message, runId: run.runId });
        return {
          runId: run.runId,
          modelId: run.modelId,
          status: 'error',
          reason: message,
          startedAt,
          completedAt: now(),
        };
      }
    },
  };
}
