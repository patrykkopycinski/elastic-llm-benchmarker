/**
 * Canonical registry of vLLM-supported model architectures and their tool-call
 * parsers. Single source of truth — imported by both `model-discovery.ts`
 * (fast-reject whitelist + deep-eval compatibility check) and
 * `model-candidate-filter.ts` (pre-deployment parser resolution + arch check).
 *
 * Why this file exists: these lists used to be hand-duplicated in four places
 * across the two files above. They drifted — e.g. `mistral3` (Mistral-Small-3.x,
 * Devstral-Small-2) and bare `glm4_moe` (GLM-4.5-Air) were fast-rejected by
 * discovery's whitelist even though the candidate filter and
 * `vllm-model-params.ts` already knew how to deploy them correctly. That drift
 * produced false negatives: models silently skipped for a stale allowlist, not
 * genuine incompatibility. See AGENTS.md "Agent Builder Baseline" note on
 * parser-map accuracy.
 *
 * When adding a new architecture: add it to ONE of the sets/map below. Both
 * consumers pick it up automatically — no need to touch model-discovery.ts or
 * model-candidate-filter.ts.
 */

/**
 * Architectures with a verified vLLM tool-call parser (single-tool calling —
 * Agent Builder does not require parallel tool calls). Keys are HuggingFace
 * `model_type` (or the family alias used across the codebase); values are the
 * `--tool-call-parser` flag vLLM expects.
 */
export const VLLM_TOOL_CALL_PARSERS: Record<string, string> = {
  // Hermes-style tool calling (Qwen, NousResearch Hermes models)
  qwen: 'hermes',
  qwen2: 'hermes',
  qwen2_moe: 'hermes',
  qwen3: 'hermes',
  qwen3_moe: 'hermes',
  // Qwen3-Next (hybrid Mamba2/attention MoE, e.g. Qwen3-Next-80B-A3B) — HF
  // model_type `qwen3_next`. Grammar is Qwen3-identical (Hermes-style tool
  // calling); vLLM has native support since 0.10.2. Was previously reached
  // only via the `arch.includes('qwen')` substring fallback in both this
  // registry's consumers AND the model-id string-sniff in
  // `getRecommendedToolCallParser` — correct by luck, not by design, and
  // invisible to `TOOL_CALLING_WHITELIST`-based discovery pre-filtering.
  qwen3_next: 'hermes',
  // Qwen3.6 generation (multimodal-capable; text/tool-calling served fine by
  // vLLM — verified with Ornith-1.0-35B qwen3_5_moe SUPPORT run).
  qwen3_5: 'hermes',
  qwen3_5_moe: 'hermes',
  // Mistral-native tool calling
  mistral: 'mistral',
  // Mistral-Small-3.x / Devstral-Small-2's HF model_type (Pixtral-mapped in
  // vLLM's model registry; --tool-call-parser mistral works the same as base
  // `mistral`). Was missing here — 24B, hardware-perfect for 2xA100-80GB, and
  // silently fast-rejected by a stale discovery whitelist copy.
  mistral3: 'mistral',
  mixtral: 'mistral',
  // Llama 3 JSON-based tool calling
  llama: 'llama3_json',
  codellama: 'llama3_json',
  // GLM-4.5/4.6 (Zhipu/Z.ai) — requires --tool-call-parser glm45 --reasoning-parser glm45
  // See: https://vllm.ai/blog/2025-08-19-glm45-vllm
  glm4_moe: 'glm45',
  // Kimi K2 (Moonshot AI) — DeepseekV3ForCausalLM arch, model_type kimi_k2
  kimi_k2: 'kimi_k2',
  // Seed-OSS (ByteDance-Seed) — SeedOssForCausalLM arch, native vLLM support since 0.10.2
  seed_oss: 'seed_oss',
};

/**
 * Architectures vLLM can run inference on but without a verified tool-call
 * parser in this registry (encoder-only models, vision/embedding models,
 * or families we haven't wired a parser for yet). Broader than the
 * tool-calling set above — used only for the "can vLLM load this at all"
 * check, not for Agent Builder eligibility.
 */
const VLLM_INFERENCE_ONLY_ARCHITECTURES = new Set([
  'gemma',
  'gemma2',
  'phi',
  'phi3',
  'starcoder2',
  'deepseek',
  'deepseek_v2',
  'deepseek_v3',
  'internlm',
  'internlm2',
  'yi',
  'baichuan',
  'chatglm',
  'falcon',
  'mpt',
  'bloom',
  'opt',
  'gpt_neox',
  'gpt2',
  'gptj',
  'stablelm',
  'command-r',
  'cohere',
  'dbrx',
  'jamba',
  'olmo',
  'arctic',
  'exaone',
]);

/** All architectures vLLM supports for inference (tool-calling + inference-only). */
export const VLLM_SUPPORTED_ARCHITECTURES: ReadonlySet<string> = new Set([
  ...Object.keys(VLLM_TOOL_CALL_PARSERS),
  ...VLLM_INFERENCE_ONLY_ARCHITECTURES,
]);

/**
 * Fast-reject whitelist for discovery: only architectures with a known
 * tool-call parser are worth the expensive deep evaluation (config fetch,
 * hardware-fit check). Derived from `VLLM_TOOL_CALL_PARSERS` so it can never
 * drift out of sync with the parser map again.
 */
export const TOOL_CALLING_WHITELIST: ReadonlySet<string> = new Set(
  Object.keys(VLLM_TOOL_CALL_PARSERS),
);
