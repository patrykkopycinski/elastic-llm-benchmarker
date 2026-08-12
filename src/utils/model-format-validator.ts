/**
 * Model format compatibility check. Rejects formats that vLLM cannot load efficiently,
 * causing health check timeouts (30+ min waste). Better to fail fast with a clear error.
 */
export interface FormatCheckResult {
  compatible: boolean;
  reason?: string;
  /** Non-blocking warning for formats that may work but have known issues. */
  warning?: string;
}

/**
 * Check if a model ID/format is compatible with vLLM serving.
 * Returns {compatible: false} for known unsupported formats that waste GPU time.
 * Returns {compatible: true, warning: ...} for formats that may work but are risky.
 */
export function checkModelFormatCompatibility(modelId: string, gpuType?: string): FormatCheckResult {
  const id = modelId.toLowerCase();

  // Reject GGUF (quantized inference format, not vLLM-compatible)
  if (id.includes("gguf")) {
    return {
      compatible: false,
      reason: "GGUF-quantized models incompatible with vLLM. Use native FP8, NVFP8, or AWQ instead.",
    };
  }

  // Reject bnb-4bit bitsandbytes (requires llama-cpp, not vLLM).
  //
  // IMPORTANT: only reject the actual bitsandbytes packaging, not any model id
  // containing the substring "4bit". vLLM natively serves AWQ, GPTQ, and
  // compressed-tensors 4-bit formats just fine — those repos are frequently
  // named "...-AWQ-4bit" or "...-4bit-AWQ" (e.g. cyankiwi's AWQ quant line),
  // and a bare `includes('4bit')` false-positive-rejected
  // cyankiwi/Devstral-Small-2-24B-Instruct-2512-AWQ-4bit (real quant_method:
  // "awq", compressed-tensors pack-quantized) on every discovery sweep and
  // every manual enqueue. Match the bnb/bitsandbytes marker explicitly, and
  // only treat a lone "4bit"/"4-bit" token as bnb when no AWQ/GPTQ/compressed-
  // tensors marker is also present in the id.
  const isExplicitBnb = id.includes("bnb-4bit") || id.includes("bnb4bit") || id.includes("bitsandbytes");
  const hasVllmNativeQuantMarker =
    id.includes("awq") || id.includes("gptq") || id.includes("compressed-tensors") || id.includes("marlin");
  const isBareFourBit = (id.includes("4bit") || id.includes("4-bit")) && !hasVllmNativeQuantMarker;
  if (isExplicitBnb || isBareFourBit) {
    return {
      compatible: false,
      reason: "4-bit bitsandbytes require llama.cpp. Use FP8 or AWQ quantization instead.",
    };
  }

  // Reject EXL2/EXL3 (ExLlamaV2 formats — TabbyAPI/text-generation-webui only,
  // vLLM has no loader). Observed 2026-08-12: three EXL3 models each burned the
  // full 30min vLLM health-check timeout on the A100s and produced no result.
  if (/\bexl3\b|\bexl2\b|-exl3|-exl2|exllama/i.test(id)) {
    return {
      compatible: false,
      reason: "EXL2/EXL3 (ExLlamaV2) is unsupported by vLLM. Use AWQ, GPTQ, or FP8 instead.",
    };
  }

  // Reject DFlash format (proprietary, not vLLM-supported)
  if (id.includes("dflash") || id.includes("-dflash")) {
    return {
      compatible: false,
      reason: "DFlash format unsupported by vLLM. Use native .safetensors checkpoint instead.",
    };
  }

  // NVFP4 needs native FP4 tensor cores (Blackwell/Hopper-class). On Ampere
  // (A100) it either crashes the container a few minutes in or burns the full
  // vLLM health-check timeout — 5-30min of GPU time per attempt, every time.
  // Verified 2026-07-30: 2/5 deployments in a single tick failed exactly this
  // way. Warn-only was tolerable while the VRAM estimator over-rejected these
  // models anyway; now that 4-bit families are sized correctly they actually
  // reach deployment, so the warning has to become a reject on Ampere.
  if (id.includes("nvfp4") || id.includes("nvfp-4")) {
    if (gpuType && /a100|ampere|a10g|a40|v100|t4|l4/i.test(gpuType)) {
      return {
        compatible: false,
        reason: `NVFP4 requires native FP4 tensor cores; ${gpuType} (pre-Blackwell) cannot load it. Use AWQ, GPTQ, or FP8 instead.`,
      };
    }
    return {
      compatible: true,
      warning: "NVFP4 format has limited vLLM support and may fail to load. Proceeding with caution.",
    };
  }

  return { compatible: true };
}
