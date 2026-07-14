import type { QueueEntry } from './queue-service.js';
import type { PipelineProgress } from '../types/pipeline-progress.js';
import { readLiveBatchEvalProgress } from './batch-eval-progress.js';

export interface EnrichedQueueEntry extends QueueEntry {
  progress?: PipelineProgress;
}

/**
 * Merge stored queue metadata progress with live batch-runner state for Stage 2.
 */
export async function enrichQueueEntryProgress(
  entry: QueueEntry | null,
  options?: {
    skillDevPluginDir?: string;
    /** Fallback when metadata not yet written (in-flight run on older daemon). */
    defaultEvalSuites?: string[];
  },
): Promise<EnrichedQueueEntry | null> {
  if (!entry) return null;

  let base = entry.metadata?.pipelineProgress;

  // Infer Stage 2 from live batch state when daemon has not written progress yet.
  if (
    !base &&
    entry.status === 'benchmarking' &&
    options?.skillDevPluginDir &&
    options.defaultEvalSuites?.length
  ) {
    const live = await readLiveBatchEvalProgress(
      options.skillDevPluginDir,
      entry.modelId,
      options.defaultEvalSuites,
    );
    if (live.completed.length > 0 || live.evalCurrent || live.queuedSuiteId) {
      base = {
        stage: 'stage2_evals',
        detail: live.evalCurrent
          ? `Running ${live.evalCurrent}`
          : 'Security eval batch in progress',
        evalSuites: options.defaultEvalSuites,
        evalTotal: options.defaultEvalSuites.length,
        evalCompleted: live.completedSuiteIds,
        evalCurrent: live.evalCurrent,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  if (!base) {
    return { ...entry };
  }

  const progress: PipelineProgress = { ...base };

  if (
    progress.stage === 'stage2_evals' &&
    options?.skillDevPluginDir &&
    progress.evalSuites?.length
  ) {
    const live = await readLiveBatchEvalProgress(
      options.skillDevPluginDir,
      entry.modelId,
      progress.evalSuites,
    );
    progress.evalCompleted = live.completedSuiteIds;
    progress.evalCurrent = live.evalCurrent;
    progress.evalTotal = progress.evalSuites.length;
    if (live.evalCurrent) {
      const done = live.completedSuiteIds.length;
      progress.detail = `Running ${live.evalCurrent} (${done}/${progress.evalTotal} suites done)`;
    } else if (live.completedSuiteIds.length >= (progress.evalTotal ?? 0)) {
      progress.detail = `All ${progress.evalTotal} suites finished — wrapping up batch`;
    }
  }

  return { ...entry, progress };
}
