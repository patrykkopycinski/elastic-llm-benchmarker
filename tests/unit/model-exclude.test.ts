import { describe, it, expect, vi } from 'vitest';
import {
  compileModelExcludeMatchers,
  findMatchingExcludePattern,
} from '../../src/utils/model-exclude.js';

describe('compileModelExcludeMatchers', () => {
  it('compiles case-insensitive matchers', () => {
    const matchers = compileModelExcludeMatchers(['qwen2', 'llama-2']);
    expect(matchers).toHaveLength(2);
    expect(matchers[0]!.test('Qwen/Qwen2.5-32B-Instruct')).toBe(true);
    expect(matchers[1]!.test('meta-llama/Llama-2-13b')).toBe(true);
  });

  it('returns [] for undefined or empty input', () => {
    expect(compileModelExcludeMatchers(undefined)).toEqual([]);
    expect(compileModelExcludeMatchers([])).toEqual([]);
  });

  it('drops an invalid regex and reports it via onInvalid rather than throwing', () => {
    const onInvalid = vi.fn();
    const matchers = compileModelExcludeMatchers(['qwen2', '[unterminated('], onInvalid);
    expect(matchers).toHaveLength(1);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(onInvalid.mock.calls[0]![0]).toBe('[unterminated(');
  });
});

describe('findMatchingExcludePattern', () => {
  const matchers = compileModelExcludeMatchers(['qwen2', 'llama-2', 'codellama']);

  it('returns the first matching pattern', () => {
    expect(findMatchingExcludePattern('Qwen/Qwen2.5-32B-Instruct-AWQ', matchers)?.source).toBe(
      'qwen2',
    );
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingExcludePattern('mistralai/Mistral-Small-24B-Instruct', matchers)).toBeNull();
  });

  it('does not match a newer generation (qwen3) against a qwen2 pattern', () => {
    expect(findMatchingExcludePattern('Qwen/Qwen3-30B-A3B-Instruct-2507', matchers)).toBeNull();
    expect(findMatchingExcludePattern('cyankiwi/Qwen3-30B-A3B-Instruct-2507-AWQ-4bit', matchers)).toBeNull();
  });

  // `qwen3-` (trailing dash) retires all of gen-3.0 while sparing gen-3.6:
  // the char after `qwen3` is a dash in 3.0 ids and a dot in 3.6 ids.
  describe('qwen3- retires gen-3.0 but spares gen-3.6', () => {
    const gen3Matchers = compileModelExcludeMatchers(['qwen2', 'qwen1', 'qwen3-']);

    it('matches gen-3.0 editions (30B / Next / Coder, base or quant)', () => {
      expect(findMatchingExcludePattern('Qwen/Qwen3-30B-A3B-Instruct-2507', gen3Matchers)?.source).toBe('qwen3-');
      expect(findMatchingExcludePattern('cyankiwi/Qwen3-Next-80B-A3B-Instruct-AWQ-4bit', gen3Matchers)?.source).toBe('qwen3-');
      expect(findMatchingExcludePattern('Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8', gen3Matchers)?.source).toBe('qwen3-');
    });

    it('does NOT match gen-3.6 (dot after qwen3, not dash)', () => {
      expect(findMatchingExcludePattern('Qwen/Qwen3.6-35B-A3B', gen3Matchers)).toBeNull();
      expect(findMatchingExcludePattern('someone/Qwen3.6-35B-A3B-AWQ-4bit', gen3Matchers)).toBeNull();
    });
  });

  // `qwen3-(?!coder)` is the production default (config.ts): the negative
  // lookahead carves Qwen3-Coder out of the gen-3.0 retirement so the
  // still-current Coder product line (and its quant repacks) never gets
  // silently discarded alongside legitimately-outdated Qwen3-30B/32B/8B etc.
  // Regression for the bug found 2026-07-27: QuantTrio/Qwen3-Coder-30B-A3B-
  // Instruct-AWQ was never discovered/enqueued because the old `qwen3-`
  // pattern matched it identically to a stale Qwen3-32B.
  describe('qwen3-(?!coder) spares the Qwen3-Coder product line', () => {
    const coderAwareMatchers = compileModelExcludeMatchers(['qwen2', 'qwen1', 'qwen3-(?!coder)']);

    it('does NOT match Qwen3-Coder editions, base or any repack', () => {
      expect(
        findMatchingExcludePattern('Qwen/Qwen3-Coder-30B-A3B-Instruct', coderAwareMatchers),
      ).toBeNull();
      expect(
        findMatchingExcludePattern('Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8', coderAwareMatchers),
      ).toBeNull();
      expect(
        findMatchingExcludePattern(
          'QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ',
          coderAwareMatchers,
        ),
      ).toBeNull();
    });

    it('still matches non-Coder gen-3.0 editions', () => {
      expect(
        findMatchingExcludePattern('Qwen/Qwen3-30B-A3B-Instruct-2507', coderAwareMatchers)?.source,
      ).toBe('qwen3-(?!coder)');
      expect(findMatchingExcludePattern('Qwen/Qwen3-32B', coderAwareMatchers)?.source).toBe(
        'qwen3-(?!coder)',
      );
      expect(findMatchingExcludePattern('Qwen/Qwen3-8B', coderAwareMatchers)?.source).toBe(
        'qwen3-(?!coder)',
      );
    });

    it('still spares gen-3.6', () => {
      expect(findMatchingExcludePattern('Qwen/Qwen3.6-27B-FP8', coderAwareMatchers)).toBeNull();
    });
  });
});
