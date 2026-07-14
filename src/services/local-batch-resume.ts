import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElasticsearchResultsStore } from './elasticsearch-results-store.js';

/**
 * Suites with a terminal `pass` in the batch runner's incremental JSONL state.
 * Only passes are skipped on resume — failed suites are re-run.
 */
export async function getPassedSuitesFromJsonl(
  pluginDir: string,
  modelId: string,
): Promise<string[]> {
  const stateDir = join(pluginDir, 'matrix-output', '.batch-state');
  const passed = new Set<string>();

  try {
    const entries = await readdir(stateDir);
    const resultFiles = entries.filter((e) => /^worker-\d+-results\.jsonl$/.test(e));
    for (const file of resultFiles) {
      const raw = await readFile(join(stateDir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as { suite?: string; model?: string; status?: string };
          if (row.model !== modelId || !row.suite || row.status !== 'pass') continue;
          passed.add(row.suite);
        } catch {
          // skip malformed lines
        }
      }
    }
  } catch {
    // no state dir
  }

  return [...passed];
}

/**
 * Merge JSONL passes with ES stage2 suite passes scoped to a queue entry.
 */
export async function resolveSkipLocalBatchSuites(options: {
  pluginDir?: string;
  modelId: string;
  queueEntryId: string;
  evalSuites: string[];
  resultsStore?: ElasticsearchResultsStore;
  includeJsonl?: boolean;
}): Promise<string[]> {
  const skip = new Set<string>();

  if (options.includeJsonl !== false && options.pluginDir) {
    for (const suite of await getPassedSuitesFromJsonl(options.pluginDir, options.modelId)) {
      if (options.evalSuites.includes(suite)) skip.add(suite);
    }
  }

  if (options.resultsStore) {
    const fromEs = await options.resultsStore.getPassedStage2SuitesForEntry(
      options.queueEntryId,
      options.evalSuites,
    );
    for (const suite of fromEs) skip.add(suite);
  }

  return [...skip];
}
