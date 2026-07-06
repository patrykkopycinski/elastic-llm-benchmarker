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
});
