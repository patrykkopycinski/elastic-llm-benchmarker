import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BatchSuiteResult {
  suite: string;
  model: string;
  status: 'pass' | 'fail';
  durationMs: number;
}

export interface LiveBatchEvalProgress {
  completed: BatchSuiteResult[];
  completedSuiteIds: string[];
  /** First suite file still in the work-stealing queue, if any. */
  queuedSuiteId: string | null;
  evalCurrent: string | null;
}

/**
 * Reads in-flight results from `run-security-evals-batch.sh` state dir.
 * Best-effort: returns empty progress when batch is not running.
 */
export async function readLiveBatchEvalProgress(
  pluginDir: string,
  modelId: string,
  plannedSuites?: string[],
): Promise<LiveBatchEvalProgress> {
  const stateDir = join(pluginDir, 'matrix-output', '.batch-state');
  const empty: LiveBatchEvalProgress = {
    completed: [],
    completedSuiteIds: [],
    queuedSuiteId: null,
    evalCurrent: null,
  };

  try {
    const entries = await readdir(stateDir);
    const resultFiles = entries.filter((e) => /^worker-\d+-results\.jsonl$/.test(e));
    const completed: BatchSuiteResult[] = [];

    for (const file of resultFiles) {
      const raw = await readFile(join(stateDir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as {
            suite?: string;
            model?: string;
            status?: string;
            duration_ms?: number;
          };
          if (row.model !== modelId || !row.suite) continue;
          if (row.status !== 'pass' && row.status !== 'fail') continue;
          completed.push({
            suite: row.suite,
            model: row.model,
            status: row.status,
            durationMs: row.duration_ms ?? 0,
          });
        } catch {
          // skip malformed lines
        }
      }
    }

    const completedSuiteIds = [...new Set(completed.map((c) => c.suite))];
    let queuedSuiteId: string | null = null;
    const queueDir = join(stateDir, 'suite-queue');
    try {
      const queueFiles = (await readdir(queueDir)).filter((f) => f.includes('__'));
      queueFiles.sort();
      if (queueFiles.length > 0) {
        const first = queueFiles[0]!;
        const idx = first.indexOf('__');
        queuedSuiteId = idx >= 0 ? first.slice(idx + 2) : null;
      }
    } catch {
      // no queue dir yet
    }

    const planned = plannedSuites ?? [];
    const evalCurrent =
      queuedSuiteId ??
      planned.find((s) => !completedSuiteIds.includes(s)) ??
      null;

    return { completed, completedSuiteIds, queuedSuiteId, evalCurrent };
  } catch {
    return empty;
  }
}
