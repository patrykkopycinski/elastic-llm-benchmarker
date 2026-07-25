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

  // Reject bnb-4bit bitsandbytes (requires llama-cpp, not vLLM)
  if (id.includes("bnb-4bit") || id.includes("4bit")) {
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
