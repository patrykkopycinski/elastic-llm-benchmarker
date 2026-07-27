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
export function checkModelFormatCompatibility(modelId: string): FormatCheckResult {
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

  // Reject DFlash format (proprietary, not vLLM-supported)
  if (id.includes("dflash") || id.includes("-dflash")) {
    return {
      compatible: false,
      reason: "DFlash format unsupported by vLLM. Use native .safetensors checkpoint instead.",
    };
  }

  // Warn on NVFP4 (limited vLLM support, may have loading issues)
  if (id.includes("nvfp4") || id.includes("nvfp-4")) {
    return {
      compatible: true,
      warning: "NVFP4 format has limited vLLM support and may fail to load. Proceeding with caution.",
    };
  }

  return { compatible: true };
}
