import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../src/utils/failure-classifier.js';

describe('classifyFailure', () => {
  it('returns unknown (non-retriable) for empty/null messages', () => {
    for (const m of [null, undefined, '', '   ']) {
      const c = classifyFailure(m);
      expect(c.category).toBe('unknown');
      expect(c.retriable).toBe(false);
    }
  });

  it('classifies unrecognised messages as unknown, non-retriable', () => {
    const c = classifyFailure('some totally novel error nobody has a rule for');
    expect(c.category).toBe('unknown');
    expect(c.retriable).toBe(false);
  });

  describe('transient-infra (retriable)', () => {
    const cases = [
      'Insufficient disk space on the host',
      'no space left on device',
      'Health check timed out after 604162ms for model Qwen/Qwen3.6-35B-A3B',
      "OCI runtime exec failed: cannot exec in a stopped container",
      "Docker run failed for container 'vllm-model-qwen'",
      'fetch failed',
      'ECONNRESET while polling',
      'read ETIMEDOUT',
      'ssh connection refused',
      'Build was skipped by Buildkite before running',
      'Stage 2 aborted: shared-VM takeover — container removed',
      'Orphaned active entry — previous daemon exited before completing',
      'CI smoke test failed at tier health',
      'CI smoke test failed at tier inference',
    ];
    for (const msg of cases) {
      it(`transient: ${msg.slice(0, 40)}`, () => {
        const c = classifyFailure(msg);
        expect(c.category).toBe('transient-infra');
        expect(c.retriable).toBe(true);
      });
    }
  });

  describe('resource-fit (retriable)', () => {
    const cases = [
      'CUDA out of memory',
      'torch.OutOfMemoryError: OOM when allocating',
      'Benchmark failed at concurrency level(s): 4, 16',
      'KV cache is too small for the requested context',
    ];
    for (const msg of cases) {
      it(`resource-fit: ${msg.slice(0, 40)}`, () => {
        const c = classifyFailure(msg);
        expect(c.category).toBe('resource-fit');
        expect(c.retriable).toBe(true);
      });
    }
  });

  describe('model-arch / eval-quality (NOT retriable)', () => {
    const cases = [
      'Model architectures are not supported by vLLM',
      'unsupported model architecture: MambaForCausalLM',
      'no known tool-call parser for this model',
      'Tokenizer class LlamaTokenizer does not exist',
      'quantization method awq is not supported',
      'Kibana CI eval failed (build #126)',
      'eval scores below the pass gate',
      'Stage 1 benchmark did not pass threshold',
    ];
    for (const msg of cases) {
      it(`model-arch: ${msg.slice(0, 40)}`, () => {
        const c = classifyFailure(msg);
        expect(c.category).toBe('model-arch');
        expect(c.retriable).toBe(false);
      });
    }
  });

  it('prioritises permanent model-arch over broad transient patterns', () => {
    // Contains both "failed" and an arch signal — arch rule must win (it's checked first).
    const c = classifyFailure('docker run failed: model architectures are not supported');
    expect(c.category).toBe('model-arch');
    expect(c.retriable).toBe(false);
  });
});
