import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecommendationReport } from '../types/recommendation.js';

export interface BatchSummaryResultEntry {
  suite: string;
  model: string;
  status: string;
  duration_ms: number;
  log_file?: string;
}

export interface BatchSummaryFile {
  results?: BatchSummaryResultEntry[];
}

const BATCH_SUMMARY_PATTERN = /^batch-summary-.*\.json$/;

export async function readBatchSummaryFile(path: string): Promise<BatchSummaryFile | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as BatchSummaryFile;
  } catch {
    return null;
  }
}

/** Latest batch-summary JSON in matrix-output that includes `modelId`. */
export async function findLatestBatchSummaryForModel(
  matrixOutputDir: string,
  modelId: string,
): Promise<{ path: string; basename: string; summary: BatchSummaryFile } | null> {
  let entries: string[];
  try {
    entries = await readdir(matrixOutputDir);
  } catch {
    return null;
  }

  const candidates = entries.filter((name) => BATCH_SUMMARY_PATTERN.test(name));
  if (!candidates.length) return null;

  const ranked = await Promise.all(
    candidates.map(async (name) => {
      const path = join(matrixOutputDir, name);
      const st = await stat(path);
      return { name, path, mtimeMs: st.mtimeMs };
    }),
  );
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { name, path } of ranked) {
    const summary = await readBatchSummaryFile(path);
    if (!summary?.results?.some((r) => r.model === modelId)) continue;
    return { path, basename: name, summary };
  }
  return null;
}

/** Merge suite durations from a batch summary into a recommendation report (API-only backfill). */
export function mergeBatchDurationsIntoReport(
  report: RecommendationReport,
  summary: BatchSummaryFile,
  modelId: string,
): RecommendationReport {
  if (!report.stage2Results) return report;

  const bySuite = new Map<string, BatchSummaryResultEntry>();
  for (const entry of summary.results ?? []) {
    if (entry.model === modelId) bySuite.set(entry.suite, entry);
  }
  if (!bySuite.size) return report;

  const suiteResults = { ...report.stage2Results.suiteResults };
  for (const [suite, entry] of bySuite) {
    const existing = suiteResults[suite];
    if (!existing) continue;
    suiteResults[suite] = {
      ...existing,
      durationSec: Math.round((entry.duration_ms ?? 0) / 1000),
    };
  }

  return {
    ...report,
    stage2Results: { ...report.stage2Results, suiteResults },
  };
}
