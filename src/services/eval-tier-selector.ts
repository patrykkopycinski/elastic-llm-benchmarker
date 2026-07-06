import type { AppConfig, EvalTier } from '../types/config.js';

/**
 * Resolved eval pipeline shape after reconciling config, CLI flags, and env.
 *
 * - `local`:         Tier-1 only — run stage2-worker/eval-suite-runner in-VPC.
 *                     No Buildkite trigger. This is the GCP autonomous default.
 * - `buildkiteWeekly`: Tier-2 — Buildkite weekly matrix via public LB endpoint.
 *                     Requires a Buildkite API token + a public endpoint.
 * - `localThenWeekly`: Tier-1 gate → Tier-2 promotion. Run local evals first;
 *                     only trigger the weekly matrix if Tier-1 passes.
 */
export type ResolvedEvalTier = 'local' | 'buildkiteWeekly' | 'localThenWeekly' | 'none';

export interface ResolveEvalTierOptions {
  /** Explicit `evalTier` from config (highest priority). */
  evalTier?: EvalTier;
  /** Whether CI evals (Buildkite) are enabled via CLI flag or config. */
  ciEvalsEnabled: boolean;
  /** Whether the local Stage-2 worker is enabled (`enableStage2` / `--stage2`). */
  localStage2Enabled: boolean;
}

/**
 * Resolves the effective eval tier from config + runtime flags.
 *
 * Resolution order (first match wins):
 * 1. `evalTier: 'local'` → local-only (Tier-1), even if Buildkite is configured.
 *    When CI evals are also enabled, upgrades to `localThenWeekly` so Tier-1
 *    gates the slower weekly matrix.
 * 2. `evalTier: 'buildkite-weekly'` → Buildkite weekly only (Tier-2).
 *    The local stage2-worker is not instantiated.
 * 3. No explicit `evalTier` → legacy behavior: Buildkite when CI evals enabled,
 *    otherwise local when Stage 2 is enabled.
 */
export function resolveEvalTier(opts: ResolveEvalTierOptions): ResolvedEvalTier {
  const { evalTier, ciEvalsEnabled, localStage2Enabled } = opts;

  if (evalTier === 'local') {
    return ciEvalsEnabled ? 'localThenWeekly' : 'local';
  }

  if (evalTier === 'buildkite-weekly') {
    return ciEvalsEnabled ? 'buildkiteWeekly' : 'none';
  }

  // Legacy: no explicit evalTier
  if (ciEvalsEnabled) return 'buildkiteWeekly';
  if (localStage2Enabled) return 'local';
  return 'none';
}

/**
 * Convenience wrapper that reads from a full AppConfig + the CI-evals flag
 * resolved at startup.
 */
export function resolveEvalTierFromConfig(
  config: AppConfig,
  ciEvalsEnabled: boolean,
): ResolvedEvalTier {
  return resolveEvalTier({
    evalTier: config.evalTier,
    ciEvalsEnabled,
    localStage2Enabled: Boolean(config.enableStage2),
  });
}

/**
 * Whether the local Stage-2 worker should be instantiated for this tier.
 * True for `local` and `localThenWeekly`; false otherwise.
 */
export function shouldUseLocalStage2(tier: ResolvedEvalTier): boolean {
  return tier === 'local' || tier === 'localThenWeekly';
}

/**
 * Whether the Buildkite CI-evals pipeline should be wired for this tier.
 * True for `buildkiteWeekly` and `localThenWeekly`; false otherwise.
 */
export function shouldUseBuildkiteCIEvals(tier: ResolvedEvalTier): boolean {
  return tier === 'buildkiteWeekly' || tier === 'localThenWeekly';
}
