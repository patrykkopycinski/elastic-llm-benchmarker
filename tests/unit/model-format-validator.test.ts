import { describe, it, expect } from 'vitest';
import { checkModelFormatCompatibility } from '../../src/utils/model-format-validator.js';

describe('checkModelFormatCompatibility', () => {
  describe('GGUF', () => {
    it('rejects GGUF-quantized models', () => {
      const result = checkModelFormatCompatibility('TheBloke/Llama-2-7B-Chat-GGUF');
      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/GGUF/);
    });
  });

  describe('bitsandbytes 4-bit (real rejection)', () => {
    it('rejects explicit bnb-4bit models', () => {
      const result = checkModelFormatCompatibility('unsloth/Llama-3.2-11B-Vision-Instruct-bnb-4bit');
      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/bitsandbytes/);
    });

    it('rejects models with a bare "4bit"/"4-bit" token and no vLLM-native quant marker', () => {
      // e.g. MLX quants like unsloth/Qwen3-30B-A3B-bnb-4bit style ids without AWQ/GPTQ markers
      const result = checkModelFormatCompatibility('some-org/Some-Model-4bit');
      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/bitsandbytes/);
    });

    it('rejects "bitsandbytes" spelled out explicitly', () => {
      const result = checkModelFormatCompatibility('org/Model-bitsandbytes-quantized');
      expect(result.compatible).toBe(false);
    });
  });

  describe('AWQ / GPTQ / compressed-tensors 4-bit (must NOT be rejected — regression guard)', () => {
    // Regression test: cyankiwi/Devstral-Small-2-24B-Instruct-2512-AWQ-4bit was
    // false-positive rejected by a bare `id.includes('4bit')` check even though
    // its real quant_method is "awq" (compressed-tensors pack-quantized), which
    // vLLM natively serves. See feedback in session history 2026-07-27.
    it('accepts cyankiwi Devstral AWQ-4bit', () => {
      const result = checkModelFormatCompatibility(
        'cyankiwi/Devstral-Small-2-24B-Instruct-2512-AWQ-4bit',
      );
      expect(result.compatible).toBe(true);
    });

    it('accepts cyankiwi Qwen3-30B-A3B AWQ-4bit', () => {
      const result = checkModelFormatCompatibility(
        'cyankiwi/Qwen3-30B-A3B-Instruct-2507-AWQ-4bit',
      );
      expect(result.compatible).toBe(true);
    });

    it('accepts a "4-bit-AWQ" ordering variant', () => {
      const result = checkModelFormatCompatibility('org/Some-Model-4-bit-AWQ');
      expect(result.compatible).toBe(true);
    });

    it('accepts GPTQ 4-bit', () => {
      const result = checkModelFormatCompatibility('org/Some-Model-GPTQ-4bit');
      expect(result.compatible).toBe(true);
    });

    it('accepts compressed-tensors 4-bit', () => {
      const result = checkModelFormatCompatibility('org/Some-Model-compressed-tensors-4bit');
      expect(result.compatible).toBe(true);
    });

    it('accepts Marlin-kernel 4-bit', () => {
      const result = checkModelFormatCompatibility('org/Some-Model-marlin-4bit');
      expect(result.compatible).toBe(true);
    });
  });

  describe('DFlash', () => {
    it('rejects DFlash format', () => {
      const result = checkModelFormatCompatibility('org/Some-Model-dflash');
      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/DFlash/);
    });
  });

  describe('NVFP4', () => {
    it('warns but accepts NVFP4', () => {
      const result = checkModelFormatCompatibility('nvidia/Qwen3.6-27B-NVFP4');
      expect(result.compatible).toBe(true);
      expect(result.warning).toMatch(/NVFP4/);
    });
  });

  describe('plain/unquantized models', () => {
    it('accepts a model with no quantization markers', () => {
      const result = checkModelFormatCompatibility('mistralai/Mistral-Small-3.2-24B-Instruct-2506');
      expect(result.compatible).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('NVFP4 on pre-Blackwell GPUs (wasted-GPU-time regression)', () => {
    it('rejects NVFP4 on A100/Ampere, which lacks native FP4 tensor cores', () => {
      const r = checkModelFormatCompatibility('RedHatAI/Some-Model-NVFP4', 'nvidia-a100-80gb');
      expect(r.compatible).toBe(false);
      expect(r.reason).toMatch(/FP4 tensor cores/i);
    });

    it('rejects NVFP4 on L4 as well', () => {
      expect(checkModelFormatCompatibility('x/y-nvfp4', 'nvidia-l4').compatible).toBe(false);
    });

    it('still allows NVFP4 on Blackwell-class hardware', () => {
      const r = checkModelFormatCompatibility('x/y-nvfp4', 'nvidia-b200');
      expect(r.compatible).toBe(true);
      expect(r.warning).toBeDefined();
    });

    it('preserves warn-only behaviour when gpuType is unknown', () => {
      const r = checkModelFormatCompatibility('x/y-nvfp4');
      expect(r.compatible).toBe(true);
      expect(r.warning).toBeDefined();
    });

    it('does not affect AWQ models on A100', () => {
      expect(checkModelFormatCompatibility('x/y-AWQ', 'nvidia-a100-80gb').compatible).toBe(true);
    });
  });


  describe('EXL2/EXL3 rejection (vLLM has no ExLlamaV2 loader)', () => {
    it('rejects the exact EXL3 models that burned 30min each on the A100s', () => {
      for (const id of [
        'ekozzer/Mistral-Small-3.2-24B-Instruct-EXL3-4.0bpw-HQ',
        'ekozzer/Mistral-Small-3.2-24B-Instruct-EXL3-4.5bpw-HQ',
      ]) {
        const r = checkModelFormatCompatibility(id, 'nvidia-a100-80gb');
        expect(r.compatible).toBe(false);
        expect(r.reason).toMatch(/ExLlamaV2/i);
      }
    });

    it('does not reject unrelated models that merely contain similar text', () => {
      expect(checkModelFormatCompatibility('org/Mistral-Small-24B-AWQ', 'nvidia-a100-80gb').compatible).toBe(true);
    });
  });

});
