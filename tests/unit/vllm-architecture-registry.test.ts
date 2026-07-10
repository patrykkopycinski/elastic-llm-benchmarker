import { describe, it, expect } from 'vitest';
import {
  VLLM_TOOL_CALL_PARSERS,
  VLLM_SUPPORTED_ARCHITECTURES,
  TOOL_CALLING_WHITELIST,
} from '../../src/services/vllm-architecture-registry.js';

describe('vllm-architecture-registry', () => {
  it('registers qwen3_next explicitly (not via substring fallback) so discovery whitelisting and parser resolution never depend on match order', () => {
    // Explicit key, not merely `.includes('qwen')` — regression for the
    // Qwen3-Next-80B-A3B false-negative-by-luck gap.
    expect(VLLM_TOOL_CALL_PARSERS.qwen3_next).toBe('hermes');
    expect(TOOL_CALLING_WHITELIST.has('qwen3_next')).toBe(true);
    expect(VLLM_SUPPORTED_ARCHITECTURES.has('qwen3_next')).toBe(true);
  });
});
