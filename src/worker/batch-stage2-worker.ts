import type { Logger } from 'winston';
import type { Stage2Result, PipelineRun, Stage1Result } from '../scheduler/pipeline-state.js';
import type { Stage2Worker } from './stage2-worker.js';
import type { Stage2Gate } from './stage2-gate.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { AppConfig } from '../types/config.js';
import type {
  LocalBatchEvalRunner,
  LocalBatchEvalResult,
  LocalBatchEvalSuiteResult,
} from '../services/local-batch-eval-runner.js';
import { progressNow, reportQueueProgress } from '../utils/queue-progress.js';
import type { QueueService } from '../services/queue-service.js';
import { resolveEvalSuiteTiers, tierAGatePassed } from '../utils/eval-suite-tiers.js';

interface BatchStage2WorkerDeps {
  config: AppConfig;
  gate: Stage2Gate;
  batchRunner: LocalBatchEvalRunner;
  resultsStore: ElasticsearchResultsStore;
  queueService?: QueueService;
  logger?: Logger;
}

function mapBatchStatus(
  status: LocalBatchEvalResult['status'],
): Stage2Result['status'] {
  if (status === 'success') return 'success';
  if (status === 'partial') return 'partial';
  return 'failed';
}

function buildStage2FromBatch(
  run: PipelineRun,
  batchResult: LocalBatchEvalResult,
  startedAt: string,
  reasonOverride?: string,
): Stage2Result {
  const scores: Record<string, number> = {};
  const suiteResults = batchResult.suites.map((s) => ({
    suite: s.suite,
    status: s.status,
    // Playwright's exit code is binary — one failing spec marks the whole
    // suite `fail` — so a `fail` status with a parsed `specPassRate` (e.g.
    // 24/30 specs passed) reports that fractional score instead of a flat 0.
    score: s.status === 'pass' ? 1 : s.specPassRate ?? 0,
    durationMs: s.durationMs,
    logPath: s.logPath,
  }));

  for (const sr of suiteResults) {
    scores[sr.suite] = sr.score ?? 0;
  }

  const passCount = suiteResults.filter((sr) => sr.status === 'pass').length;
  const status = mapBatchStatus(batchResult.status);

  return {
    runId: run.runId,
    modelId: run.modelId,
    status,
    scores,
    suiteResults,
    batchSummaryPath: batchResult.summaryPath,
    stdoutLogPath: batchResult.stdoutLogPath,
    startedAt,
    completedAt: batchResult.completedAt,
    reason:
      reasonOverride ??
      (status !== 'success'
        ? `Stage 2 batch ${batchResult.status}: ${passCount}/${suiteResults.length} suites passed`
        : undefined),
  };
}

function mergeBatchResults(parts: LocalBatchEvalResult[]): LocalBatchEvalResult {
  if (parts.length === 0) {
    throw new Error('mergeBatchResults requires at least one batch result');
  }
  if (parts.length === 1) return parts[0]!;

  const bySuite = new Map<string, LocalBatchEvalSuiteResult>();
  for (const part of parts) {
    for (const suite of part.suites) {
      bySuite.set(suite.suite, suite);
    }
  }
  const suites = [...bySuite.values()];
  const passCount = suites.filter((s) => s.status === 'pass').length;
  const status: LocalBatchEvalResult['status'] =
    passCount === suites.length
      ? 'success'
      : passCount > 0
        ? 'partial'
        : 'failed';

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return {
    modelId: first.modelId,
    status,
    suites,
    startedAt: first.startedAt,
    completedAt: last.completedAt,
    summaryPath: last.summaryPath,
    stdoutLogPath: last.stdoutLogPath,
    logPath: last.summaryPath,
  };
}

/**
 * Stage 2 worker that delegates to the skill-dev plugin's batch runner
 * (run-security-evals-batch.sh) instead of the single-suite eval-suite-runner.
 */
export function createBatchStage2Worker(deps: BatchStage2WorkerDeps): Stage2Worker {
  const { gate, batchRunner, resultsStore, queueService, logger } = deps;

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
        const tiers = resolveEvalSuiteTiers(deps.config.stage2Local);
        const skipSuites = run.skipStage2Suites ?? [];
        const plannedSuites =
          tiers.tierA.length > 0
            ? [...tiers.tierA, ...tiers.tierB.filter((s) => !tiers.tierA.includes(s))]
            : tiers.all;

        logger?.info('Stage 2 (batch): starting batch eval', {
          runId: run.runId,
          modelId: run.modelId,
          endpointUrl,
          tierA: tiers.tierA,
          tierB: tiers.tierB,
          skipSuites,
          pauseAlwaysOnStack: deps.config.stage2Local.pauseAlwaysOnStack,
          teardownBatchStack: deps.config.stage2Local.teardownBatchStack,
        });

        await reportQueueProgress(
          queueService,
          run.queueEntryId,
          progressNow('stage2_evals', `Starting ${plannedSuites.length} security eval suites`, {
            evalSuites: plannedSuites,
            evalTotal: plannedSuites.length,
            evalCompleted: skipSuites,
            evalCurrent: plannedSuites.find((s) => !skipSuites.includes(s)) ?? null,
          }),
        );

        const runPhase = async (suites: string[]): Promise<LocalBatchEvalResult | null> => {
          const toRun = suites.filter((s) => !skipSuites.includes(s));
          if (toRun.length === 0) return null;
          return batchRunner.run({
            vllmBaseUrl: endpointUrl,
            modelId: run.modelId,
            suites: toRun,
            skipSuites,
          });
        };

        const parts: LocalBatchEvalResult[] = [];

        if (tiers.tierA.length > 0) {
          const tierAResult = await runPhase(tiers.tierA);
          if (tierAResult) parts.push(tierAResult);
          if (tierAResult && !tierAGatePassed(tierAResult.suites, tiers.tierA)) {
            const merged = mergeBatchResults(parts);
            const result = buildStage2FromBatch(
              run,
              merged,
              startedAt,
              `Tier A gate failed: not all fast-gate suites passed`,
            );
            await persistStage2(resultsStore, result, logger, run);
            return result;
          }
        }

        const tierBSuites =
          tiers.tierA.length > 0
            ? tiers.tierB
            : tiers.all;
        const tierBResult = await runPhase(tierBSuites);
        if (tierBResult) parts.push(tierBResult);

        if (parts.length === 0) {
          return {
            runId: run.runId,
            modelId: run.modelId,
            status: 'success',
            reason: 'All suites already passed (resume skip)',
            startedAt,
            completedAt: now(),
          };
        }

        const merged = mergeBatchResults(parts);
        const result = buildStage2FromBatch(run, merged, startedAt);

        logger?.info('Stage 2 (batch): completed', {
          runId: run.runId,
          modelId: run.modelId,
          status: result.status,
          passCount: result.suiteResults?.filter((sr) => sr.status === 'pass').length,
          suiteCount: result.suiteResults?.length,
          summaryPath: result.batchSummaryPath,
          stdoutLogPath: result.stdoutLogPath,
        });

        await persistStage2(resultsStore, result, logger, run);
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

async function persistStage2(
  resultsStore: ElasticsearchResultsStore,
  result: Stage2Result,
  logger: Logger | undefined,
  run: PipelineRun,
): Promise<void> {
  try {
    await resultsStore.saveStage2Result(result, run.queueEntryId);
  } catch (saveErr: unknown) {
    const saveMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
    logger?.warn('Stage 2 (batch): failed to persist result to results store', {
      runId: run.runId,
      modelId: run.modelId,
      error: saveMessage,
    });
  }
}
