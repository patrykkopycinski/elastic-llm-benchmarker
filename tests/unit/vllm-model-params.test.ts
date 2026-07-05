import { describe, it, expect } from 'vitest';
import { getVllmParamsForModel } from '../../src/services/vllm-model-params.js';

describe('getVllmParamsForModel', () => {
  describe('Llama-derived fine-tunes without "llama" in the id', () => {
    // Regression: fdtn-ai/Foundation-Sec-8B-Instruct is LlamaForCausalLM (normalized
    // to "llama" by the card parser) but its id has no "llama" substring. Before the
    // arch-based match, it resolved to NONE (no tool parser), so the deploy omitted
    // --enable-auto-tool-choice / --tool-call-parser and every Agent Builder converse
    // (tool_choice=auto) failed with vLLM 400 — silently failing all Stage 2 suites.
    it('resolves llama3_json via architecture when the id lacks "llama"', () => {
      const params = getVllmParamsForModel('fdtn-ai/Foundation-Sec-8B-Instruct', 'llama');
      expect(params.toolCallParser).toBe('llama3_json');
      expect(params.chatTemplate).toBe('examples/tool_chat_template_llama3.1_json.jinja');
      expect(params.family).toBe('Llama 3');
    });

    it('also matches the raw LlamaForCausalLM architecture string', () => {
      const params = getVllmParamsForModel('some-org/security-model-8b', 'LlamaForCausalLM');
      expect(params.toolCallParser).toBe('llama3_json');
    });

    it('returns no parser when neither id nor arch indicate a known family', () => {
      const params = getVllmParamsForModel('some-org/mystery-model', 'unknown');
      expect(params.toolCallParser).toBeNull();
    });
  });

  describe('does not hijack other families via the llama arch match', () => {
    it('keeps Llama 4 on its pythonic parser even when arch contains "llama"', () => {
      const params = getVllmParamsForModel('meta-llama/Llama-4-Scout', 'llama4');
      expect(params.toolCallParser).toBe('llama4_pythonic');
    });

    it('does not resolve a Llama-4-arch fine-tune to llama3_json', () => {
      const params = getVllmParamsForModel('some-org/scout-derivative', 'llama4');
      expect(params.toolCallParser).not.toBe('llama3_json');
    });

    it('keeps Qwen on hermes', () => {
      expect(getVllmParamsForModel('Qwen/Qwen2.5-7B-Instruct').toolCallParser).toBe('hermes');
    });
  });
});
