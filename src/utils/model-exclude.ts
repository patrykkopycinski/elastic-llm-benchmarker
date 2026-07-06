/**
 * Shared recency denylist matching for `discoveryScheduler.excludeModelPatterns`.
 *
 * Two consumers enforce the same denylist so "focus on the most recent
 * generation" holds end-to-end:
 *  - `DiscoveryScheduler` — pre-fetch backstop, never scores/queues a matching
 *    model (the primary guard).
 *  - `Scheduler` — dequeue/resume backstop, retires a leftover queue entry that
 *    was enqueued before a denylist pattern was added (and that discovery can no
 *    longer prevent because it is already in the queue).
 *
 * Kept as pure functions in `utils/` to avoid a cross-service import (and any
 * circular dependency between the two schedulers).
 */

/**
 * Compile denylist patterns into case-insensitive matchers. An invalid regex is
 * reported via `onInvalid` (if provided) and dropped rather than throwing, so a
 * single bad operator entry never aborts a scheduler poll or a discovery sweep.
 */
export function compileModelExcludeMatchers(
  patterns: readonly string[] | undefined,
  onInvalid?: (pattern: string, err: unknown) => void,
): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns ?? []) {
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch (err) {
      onInvalid?.(pattern, err);
    }
  }
  return compiled;
}

/**
 * The first matcher that matches `modelId`, or `null` when none do. Returning
 * the matcher (not a boolean) lets callers log which pattern fired.
 */
export function findMatchingExcludePattern(modelId: string, matchers: RegExp[]): RegExp | null {
  return matchers.find((re) => re.test(modelId)) ?? null;
}
