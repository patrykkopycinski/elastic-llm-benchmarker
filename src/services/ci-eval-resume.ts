import type { QueueService } from './queue-service.js';
import type { ElasticsearchResultsStore } from './elasticsearch-results-store.js';
import type { BuildkiteEvalTrigger } from './buildkite-eval-trigger.js';
import type { CIEvalResult } from '../types/ci-eval.js';
import type { Logger } from 'winston';

const RECOVERABLE_BUILD_STATES = new Set(['running', 'scheduled', 'blocked', 'canceling']);

export interface RecoverActiveEntriesResult {
  recovered: number;
  failed: number;
}

/**
 * Returns suite ids that already have a terminal CI eval result for this model.
 */
export function getCompletedEvalSuites(
  ciEvalResults: CIEvalResult[],
  evalSuites: string[],
): string[] {
  const terminal = new Set<string>();
  for (const result of ciEvalResults) {
    if (result.status === 'running') continue;
    for (const suiteId of result.evalSuites ?? []) {
      if (evalSuites.includes(suiteId)) {
        terminal.add(suiteId);
      }
    }
  }
  return [...terminal];
}

/**
 * On daemon startup, fail orphaned active queue entries unless a Buildkite CI eval
 * is still running for that model (recoverable after unclean shutdown).
 */
export async function recoverOrFailActiveEntries(
  queueService: QueueService,
  resultsStore: ElasticsearchResultsStore,
  buildkiteTrigger: BuildkiteEvalTrigger,
  evalSuites: string[],
  logger: Logger,
): Promise<RecoverActiveEntriesResult> {
  const entries = await queueService.getActiveEntries();
  let recovered = 0;
  let failed = 0;

  for (const entry of entries) {
    if (entry.status !== 'benchmarking') {
      await queueService.updateStatus(
        entry.id,
        'failed',
        'Orphaned active entry — previous daemon exited before completion',
      );
      failed++;
      continue;
    }

    const ciEvalResults = await resultsStore.getCIEvalResults(entry.modelId, { limit: 30 });
    const runningEval = ciEvalResults.find((r) => r.status === 'running');
    if (!runningEval) {
      await queueService.updateStatus(
        entry.id,
        'failed',
        'Orphaned active entry — previous daemon exited before completion',
      );
      failed++;
      continue;
    }

    const buildState = await buildkiteTrigger.getBuildState(
      runningEval.pipelineSlug,
      runningEval.buildkiteBuildNumber,
    );
    if (!buildState || !RECOVERABLE_BUILD_STATES.has(buildState)) {
      await queueService.updateStatus(
        entry.id,
        'failed',
        'Orphaned active entry — previous daemon exited before completion',
      );
      failed++;
      continue;
    }

    logger.info('Recovering active queue entry with in-flight Buildkite CI eval', {
      queueEntryId: entry.id,
      modelId: entry.modelId,
      buildNumber: runningEval.buildkiteBuildNumber,
      buildState,
      completedSuites: getCompletedEvalSuites(ciEvalResults, evalSuites),
    });
    recovered++;
  }

  return { recovered, failed };
}
