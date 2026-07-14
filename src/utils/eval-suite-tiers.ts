import type { Stage2LocalConfig } from '../types/config.js';
import type { LocalBatchEvalSuiteResult } from '../services/local-batch-eval-runner.js';

export interface EvalSuiteTiers {
  tierA: string[];
  tierB: string[];
  all: string[];
}

/** Resolve Tier A (fast gate) and Tier B (full matrix) from stage2Local config. */
export function resolveEvalSuiteTiers(config: Stage2LocalConfig): EvalSuiteTiers {
  const all = config.evalSuites ?? [];
  const tierA = config.tierASuites ?? [];
  const tierB =
    config.tierBSuites ??
    (tierA.length > 0 ? all.filter((s) => !tierA.includes(s)) : all);
  return { tierA, tierB, all };
}

/** Tier A gate: every tier-A suite that ran must have passed. */
export function tierAGatePassed(
  suites: LocalBatchEvalSuiteResult[],
  tierA: string[],
): boolean {
  if (tierA.length === 0) return true;
  const bySuite = new Map(suites.map((s) => [s.suite, s]));
  for (const suite of tierA) {
    const result = bySuite.get(suite);
    if (!result || result.status !== 'pass') return false;
  }
  return true;
}
