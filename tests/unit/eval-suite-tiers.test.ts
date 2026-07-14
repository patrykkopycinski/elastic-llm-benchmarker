import { describe, it, expect } from 'vitest';
import {
  resolveEvalSuiteTiers,
  tierAGatePassed,
} from '../../src/utils/eval-suite-tiers.js';

describe('eval-suite-tiers', () => {
  it('defaults tier B to all suites when tier A is empty', () => {
    const tiers = resolveEvalSuiteTiers({
      evalSuites: ['a', 'b', 'c'],
    } as never);
    expect(tiers.tierA).toEqual([]);
    expect(tiers.tierB).toEqual(['a', 'b', 'c']);
  });

  it('splits tier B as evalSuites minus tier A', () => {
    const tiers = resolveEvalSuiteTiers({
      evalSuites: ['a', 'b', 'c'],
      tierASuites: ['a', 'b'],
    } as never);
    expect(tiers.tierB).toEqual(['c']);
  });

  it('tierAGatePassed requires every tier A suite to pass', () => {
    expect(
      tierAGatePassed(
        [
          { suite: 'a', status: 'pass', durationMs: 1 },
          { suite: 'b', status: 'fail', durationMs: 1 },
        ],
        ['a', 'b'],
      ),
    ).toBe(false);
    expect(
      tierAGatePassed(
        [
          { suite: 'a', status: 'pass', durationMs: 1 },
          { suite: 'b', status: 'pass', durationMs: 1 },
        ],
        ['a', 'b'],
      ),
    ).toBe(true);
  });
});
