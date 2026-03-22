import type { GpuRequirement } from '../types/benchmark.js';

const GPU_CATEGORY_THRESHOLDS: { max: number; label: string }[] = [
  { max: 16, label: '< 16 GB' },
  { max: 24, label: '16–24 GB' },
  { max: 48, label: '24–48 GB' },
  { max: 80, label: '48–80 GB' },
  { max: 160, label: '80–160 GB' },
  { max: Infinity, label: '> 160 GB' },
];

function getGpuCategory(vramGb: number): string {
  for (const cat of GPU_CATEGORY_THRESHOLDS) {
    if (vramGb <= cat.max) return cat.label;
  }
  return '> 160 GB';
}

function estimateVramGb(parameterCountB: number, bytesPerParam: number = 2): number {
  const overhead = 1.2;
  return Math.round(parameterCountB * bytesPerParam * overhead * 10) / 10;
}

function detectBytesPerParam(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes('awq') || lower.includes('4bit') || lower.includes('gptq')) return 0.5;
  if (lower.includes('fp8') || lower.includes('8bit')) return 1;
  return 2;
}

/**
 * Known parameter counts (billions) for benchmarked models.
 * For MoE models this is total params since all experts must reside in VRAM.
 */
const MODEL_PARAMS: Record<string, number> = {
  'Qwen/Qwen3-4B-Instruct-2507': 4,
  'cyankiwi/Qwen3-Next-80B-A3B-Instruct-AWQ-4bit': 80,
  'AIDXteam/Qwen3-235B-A22B-Instruct-2507-AWQ': 235,
  'arcee-ai/Trinity-Nano-Preview': 3,
  'Qwen/Qwen3-30B-A3B-Instruct-2507': 30,
  'mistralai/Devstral-Small-2-24B-Instruct-2512': 24,
  'mistralai/Ministral-3-14B-Instruct-2512': 14,
  'nvidia/Llama-3.1-Nemotron-Nano-8B-v1': 8,
  'NousResearch/Hermes-3-Llama-3.1-8B': 8,
  'Salesforce/Llama-xLAM-2-8b-fc-r': 8,
  'mistralai/Mistral-Nemo-Instruct-2407': 12,
  'zai-org/GLM-4.7-Flash': 4.7,
  'casperhansen/llama-3.3-70b-instruct-awq': 70,
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506': 24,
  'Qwen/Qwen2.5-32B-Instruct': 32,
  'ai21labs/AI21-Jamba2-3B': 3,
  'ai21labs/AI21-Jamba-Reasoning-3B': 3,
  'Alibaba-NLP/Tongyi-DeepResearch-30B-A3B': 30,
  'Qwen/Qwen3-4B-Thinking-2507': 4,
  'openbmb/AgentCPM-Explore': 8,
  'Qwen/Qwen2.5-72B-Instruct': 72,
  'LiquidAI/LFM2.5-1.2B-Instruct': 1.2,
  'openai/gpt-oss-20b': 20,
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': 30,
  'microsoft/Phi-4-mini-instruct': 4,
  'QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ': 30,
  'Qwen/Qwen3-Coder-30B-A3B-Instruct': 30,
  'casperhansen/deepseek-r1-distill-llama-70b-awq': 70,
  'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B': 8,
  'ibm-granite/granite-4.0-h-small': 8,
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B': 14,
  'deepseek-ai/DeepSeek-Coder-V2-Lite': 16,
  'mistralai/Magistral-Small-2509': 24,
  'tiiuae/Falcon-H1-34B-Instruct': 34,
  'arcee-ai/Trinity-Mini': 1.5,
  'zai-org/GLM-4-32B-0414': 32,
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B': 32,
  'microsoft/Phi-3-mini-128k-instruct': 3.8,
  'THUDM/glm-4-9b-chat-1m': 9,
  'google/gemma-3-27b-it': 27,
  'google/gemma-3-12b-it': 12,
  'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct': 16,
  'Qwen/Qwen3-235B-A22B-Instruct-2507-FP8': 235,
  'deepseek-ai/DeepSeek-V3-Base': 671,
  'deepseek-ai/DeepSeek-V3.2': 685,
  'MiniMaxAI/MiniMax-M1-40k': 456,
  'MiniMaxAI/MiniMax-Text-01-hf': 456,
  'MiniMaxAI/MiniMax-M2.1': 228,
  'XiaomiMiMo/MiMo-V2-Flash': 309,
  'Qwen/Qwen3-Next-80B-A3B-Instruct': 80,
  'meta-llama/Llama-3.3-70B-Instruct': 70,
  'moonshotai/Kimi-Linear-48B-A3B-Instruct': 48,
  'moonshotai/Kimi-K2-Instruct': 1000,
  'moonshotai/Kimi-K2-Thinking': 1000,
  'NousResearch/Hermes-4.3-36B': 36,
  'ByteDance-Seed/Seed-OSS-36B-Instruct': 36,
  '01-ai/Yi-34B-200K': 34,
  'meta-llama/Llama-4-Scout-17B-16E-Instruct': 109,
  'meta-llama/Llama-4-Maverick-17B-128E-Instruct': 400,
  'NousResearch/Meta-Llama-3.1-70B-Instruct': 70,
  'zai-org/GLM-4.7': 358,
  'meta-llama/Llama-3.1-8B-Instruct': 8,
  'CohereForAI/c4ai-command-r-08-2024': 35,
  'google/gemma-3-4b-it': 4,
  'LGAI-EXAONE/K-EXAONE-236B-A23B': 236,
  'cerebras/GLM-4.7-Flash-REAP-23B-A3B': 23,
  'Qwen/Qwen3-32B': 32,
  'Qwen/Qwen3-8B': 8,
  'Qwen/Qwen2.5-14B-Instruct': 14,
  'Qwen/Qwen2.5-72B-Instruct-AWQ': 72,
  'Qwen/Qwen2.5-Coder-32B-Instruct': 32,
  'kakaocorp/kanana-2-30b-a3b-instruct-2601': 30,
  'mistralai/Mistral-7B-Instruct-v0.2': 7,
  'mistralai/Mistral-Small-24B-Instruct-2501': 24,
  'stelterlab/Mistral-Small-24B-Instruct-2501-AWQ': 24,
  'mistralai/Codestral-22B-v0.1': 22,
  'nvidia/Nemotron-Orchestrator-8B': 8,
  'nvidia/Nemotron-Cascade-14B-Thinking': 14,
  'internlm/internlm2-chat-20b': 20,
  'google/gemma-3-1b-it': 1,
  'google/gemma-2-9b-it': 9,
  'google/gemma-2-27b-it': 27,
  'google/functiongemma-270m-it': 0.27,
  'HuggingFaceTB/SmolLM2-1.7B-Instruct': 1.7,
  'HuggingFaceTB/SmolLM3-3B': 3,
  'NousResearch/Hermes-4-14B': 14,
  'allenai/Olmo-3.1-32B-Instruct': 32,
  'allenai/OLMo-2-1124-13B-Instruct': 13,
  'stabilityai/stablelm-2-zephyr-1_6b': 1.6,
  'microsoft/Phi-4': 14,
  'LGAI-EXAONE/EXAONE-3.5-2.4B-Instruct': 2.4,
  'tencent/Hunyuan-A13B-Instruct': 53,
};

/**
 * Returns the model's parameter count in billions for known models, or null if unknown.
 * Use for tiered ITL threshold resolution when ModelInfo.parameterCount is not set (e.g. CLI --model).
 */
export function getModelParamsBillions(modelId: string): number | null {
  const paramB = MODEL_PARAMS[modelId];
  return paramB === undefined ? null : paramB;
}

/**
 * Returns GPU requirement info for a known model, or null if unknown.
 */
export function getGpuRequirement(modelId: string): GpuRequirement | null {
  const paramB = MODEL_PARAMS[modelId];
  if (paramB === undefined) return null;

  const bytesPerParam = detectBytesPerParam(modelId);
  const vramGb = estimateVramGb(paramB, bytesPerParam);

  return {
    parameterCountB: paramB,
    estimatedVramGb: vramGb,
    gpuCategory: getGpuCategory(vramGb),
  };
}
