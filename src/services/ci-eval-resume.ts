import type { QueueService } from './queue-service.js';
import type { ElasticsearchResultsStore } from './elasticsearch-results-store.js';
import type { CIEvalResult } from '../types/ci-eval.js';
import type { Logger } from 'winston';

import {
  isRetriableInfraState,
  isTerminalBuildkiteState,
  type BuildkiteEvalTrigger,
} from './buildkite-eval-trigger.js';

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
    // A build that Buildkite skipped/canceled/not_run never actually ran the eval — the suite
    // is NOT complete and must be re-run on resume. Persisting these as status `failed` (the
    // mapped CIEvalResult.status) would otherwise make resume treat the suite as done, silently
    // dropping it — the same suite-loss bug the skip_queued_branch_builds fix set out to solve.
    if (isRetriableInfraState(result.buildkiteState)) continue;
    for (const suiteId of result.evalSuites ?? []) {
      if (evalSuites.includes(suiteId)) {
        terminal.add(suiteId);
      }
    }
  }
  return [...terminal];
}

/**
 * Merge ES terminal results with Buildkite state for stale `running` rows (e.g. after
 * daemon restart while poll was stuck on a skipped build).
 */
export async function resolveCompletedEvalSuites(
  ciEvalResults: CIEvalResult[],
  evalSuites: string[],
  buildkiteTrigger: BuildkiteEvalTrigger,
): Promise<string[]> {
  const completed = new Set(getCompletedEvalSuites(ciEvalResults, evalSuites));

  for (const result of ciEvalResults) {
    if (result.status !== 'running') continue;
    for (const suiteId of result.evalSuites ?? []) {
      if (!evalSuites.includes(suiteId) || completed.has(suiteId)) continue;

      const buildState = await buildkiteTrigger.getBuildState(
        result.pipelineSlug,
        result.buildkiteBuildNumber,
      );
      if (buildState === 'passed') {
        completed.add(suiteId);
      }
    }
  }

  return [...completed];
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
    const recoverable =
      buildState !== undefined &&
      (RECOVERABLE_BUILD_STATES.has(buildState) || isTerminalBuildkiteState(buildState));
    if (!recoverable) {
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
