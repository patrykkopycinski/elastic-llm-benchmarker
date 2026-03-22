/**
 * Central resolver for vLLM deployment parameters per model.
 * Ensures evaluation uses the correct chat template, tool-call parser, and
 * any model-specific flags required by vLLM (see vLLM Tool Calling docs).
 *
 * When the model's built-in template isn't reliable, we reference Unsloth's
 * chat template list (see UNSLOTH_CHAT_TEMPLATES_URL and unslothTemplateKey).
 */

/** Unsloth docs: chat templates and model-specific guidance */
export const UNSLOTH_CHAT_TEMPLATES_URL = 'https://docs.unsloth.ai/basics/chat-templates';
/** Unsloth GitHub: full list of CHAT_TEMPLATES keys and Jinja definitions */
export const UNSLOTH_CHAT_TEMPLATES_GITHUB_URL =
  'https://github.com/unslothai/unsloth/blob/main/unsloth/chat_templates.py';

export interface VllmModelParams {
  /** Tool call parser (e.g. hermes, mistral, llama3_json). Null = no tool calling. */
  toolCallParser: string | null;
  /** Chat template path for tool calling (e.g. examples/tool_chat_template_llama3.1_json.jinja). */
  chatTemplate: string | null;
  /** Extra vLLM CLI args for this model (e.g. tokenizer_mode, config_format). */
  extraArgs: string[];
  /** Human-readable family name for logging. */
  family: string;
  /**
   * Unsloth-recommended chat template key (for get_chat_template / CHAT_TEMPLATES).
   * Use when the model's built-in template doesn't feel right; see UNSLOTH_CHAT_TEMPLATES_URL.
   */
  unslothTemplateKey: string | null;
}

/** Default: no tool calling, no template, no extra args */
const NONE: VllmModelParams = {
  toolCallParser: null,
  chatTemplate: null,
  extraArgs: [],
  family: 'unknown',
  unslothTemplateKey: null,
};

/**
 * Returns vLLM deployment parameters for the given model.
 * Uses model ID and optional architecture to pick parser, chat template, and extra args.
 * Order matters: first match wins (more specific patterns first).
 */
export function getVllmParamsForModel(
  modelId: string,
  architecture?: string | null,
): VllmModelParams {
  const id = modelId.toLowerCase();
  const arch = (architecture ?? '').toLowerCase();

  // ─── Llama 4 (pythonic recommended) ────────────────────────────────────────
  if (id.includes('llama-4') || id.includes('llama4')) {
    return {
      toolCallParser: 'llama4_pythonic',
      chatTemplate: 'examples/tool_chat_template_llama4_pythonic.jinja',
      extraArgs: [],
      family: 'Llama 4',
      unslothTemplateKey: null, // Unsloth may add Llama 4 later
    };
  }

  // ─── Llama 3.3 (use native tokenizer template = Unsloth/Meta official) ───────
  // Llama 3.3's tokenizer_config.json ships the same template Unsloth recommends.
  // It handles builtin_tools, ipython/eom_id, and single-tool-call enforcement.
  // By NOT passing --chat-template, vLLM uses the model's native template directly,
  // which is better aligned with Llama 3.3 than the generic vLLM 3.1 template.
  // See: https://docs.unsloth.ai/basics/chat-templates
  if (id.includes('llama-3.3') || id.includes('llama3.3')) {
    return {
      toolCallParser: 'llama3_json',
      chatTemplate: null,
      extraArgs: [],
      family: 'Llama 3.3',
      unslothTemplateKey: 'llama-3.3',
    };
  }

  // ─── Llama 3.x (JSON tool calling; explicit chat template for 3.1/3.2) ──────
  // Llama 3.1/3.2 need the vLLM-bundled template because their tokenizer templates
  // may not work as well with vLLM's llama3_json parser out of the box.
  if (id.includes('llama') || id.includes('codellama')) {
    const unslothKey =
      id.includes('llama-3.2') || id.includes('llama3.2')
        ? 'llama-3.2'
        : 'llama-3.1';
    return {
      toolCallParser: 'llama3_json',
      chatTemplate: 'examples/tool_chat_template_llama3.1_json.jinja',
      extraArgs: [],
      family: 'Llama 3',
      unslothTemplateKey: unslothKey,
    };
  }

  // ─── Qwen / Hermes ─────────────────────────────────────────────────────────
  if (id.includes('qwen') || arch.includes('qwen')) {
    const unslothKey = id.includes('qwen-3') || id.includes('qwen3') ? 'qwen-3' : 'qwen-2.5';
    return {
      toolCallParser: 'hermes',
      chatTemplate: null,
      extraArgs: [],
      family: 'Qwen',
      unslothTemplateKey: unslothKey,
    };
  }

  // ─── Mistral / Mixtral ──────────────────────────────────────────────────────
  if (id.includes('mistral') || id.includes('mixtral') || arch.includes('mistral') || arch.includes('mixtral')) {
    return {
      toolCallParser: 'mistral',
      chatTemplate: 'examples/tool_chat_template_mistral_parallel.jinja',
      extraArgs: [],
      family: 'Mistral',
      unslothTemplateKey: 'mistral',
    };
  }

  // ─── IBM Granite (model-specific parsers/templates) ────────────────────────
  if (id.includes('granite-4.0') || id.includes('granite-4')) {
    return { toolCallParser: 'hermes', chatTemplate: null, extraArgs: [], family: 'Granite 4', unslothTemplateKey: null };
  }
  if (id.includes('granite-20b-functioncalling') || id.includes('granite-20b-fc')) {
    return {
      toolCallParser: 'granite-20b-fc',
      chatTemplate: 'examples/tool_chat_template_granite_20b_fc.jinja',
      extraArgs: [],
      family: 'Granite 20B FC',
      unslothTemplateKey: null,
    };
  }
  if (id.includes('granite-3.0') || id.includes('granite-3.1')) {
    const template = id.includes('granite-3.0')
      ? 'examples/tool_chat_template_granite.jinja'
      : null;
    return {
      toolCallParser: 'granite',
      chatTemplate: template,
      extraArgs: [],
      family: 'Granite',
      unslothTemplateKey: null,
    };
  }
  if (id.includes('granite')) {
    return { toolCallParser: 'hermes', chatTemplate: null, extraArgs: [], family: 'Granite', unslothTemplateKey: null };
  }

  // ─── InternLM ───────────────────────────────────────────────────────────────
  if (id.includes('internlm')) {
    return {
      toolCallParser: 'internlm',
      chatTemplate: 'examples/tool_chat_template_internlm2_tool.jinja',
      extraArgs: [],
      family: 'InternLM',
      unslothTemplateKey: null,
    };
  }

  // ─── Jamba ──────────────────────────────────────────────────────────────────
  if (id.includes('jamba')) {
    return { toolCallParser: 'jamba', chatTemplate: null, extraArgs: [], family: 'Jamba', unslothTemplateKey: null };
  }

  // ─── xLAM ───────────────────────────────────────────────────────────────────
  if (id.includes('xlam') || id.includes('xlam-')) {
    const isQwen = id.includes('qwen-xlam') || id.includes('xlam-1b') || id.includes('xlam-3b') || id.includes('qwen-xlam-32b');
    return {
      toolCallParser: 'xlam',
      chatTemplate: isQwen
        ? 'examples/tool_chat_template_xlam_qwen.jinja'
        : 'examples/tool_chat_template_xlam_llama.jinja',
      extraArgs: [],
      family: 'xLAM',
      unslothTemplateKey: null,
    };
  }

  // ─── MiniMax M1 ────────────────────────────────────────────────────────────
  if (id.includes('minimax-m1') || id.includes('minimax-m1')) {
    return {
      toolCallParser: 'minimax',
      chatTemplate: 'examples/tool_chat_template_minimax_m1.jinja',
      extraArgs: [],
      family: 'MiniMax M1',
      unslothTemplateKey: null,
    };
  }

  // ─── DeepSeek V3 / V3.1 / R1 ──────────────────────────────────────────────
  if (id.includes('deepseek-v3.1') || id.includes('deepseekv3.1')) {
    return {
      toolCallParser: 'deepseek_v31',
      chatTemplate: 'examples/tool_chat_template_deepseekv31.jinja',
      extraArgs: [],
      family: 'DeepSeek V3.1',
      unslothTemplateKey: null,
    };
  }
  if (id.includes('deepseek-r1') || id.includes('deepseekr1')) {
    return {
      toolCallParser: 'deepseek_v3',
      chatTemplate: 'examples/tool_chat_template_deepseekr1.jinja',
      extraArgs: [],
      family: 'DeepSeek R1',
      unslothTemplateKey: null,
    };
  }
  if (id.includes('deepseek-v3') || id.includes('deepseekv3')) {
    return {
      toolCallParser: 'deepseek_v3',
      chatTemplate: 'examples/tool_chat_template_deepseekv3.jinja',
      extraArgs: [],
      family: 'DeepSeek V3',
      unslothTemplateKey: null,
    };
  }

  // ─── OpenAI OSS ─────────────────────────────────────────────────────────────
  if (id.includes('gpt-oss') || id.includes('openai/gpt')) {
    return { toolCallParser: 'openai', chatTemplate: null, extraArgs: [], family: 'OpenAI OSS', unslothTemplateKey: null };
  }

  // ─── Kimi K2 ────────────────────────────────────────────────────────────────
  if (id.includes('kimi-k2') || id.includes('kimi_k2')) {
    return { toolCallParser: 'kimi_k2', chatTemplate: null, extraArgs: [], family: 'Kimi K2', unslothTemplateKey: null };
  }

  // ─── Gemma (Unsloth: gemma-3, gemma2, gemma) ───────────────────────────────
  if (id.includes('gemma-3') || id.includes('gemma3')) {
    return {
      toolCallParser: 'hermes',
      chatTemplate: null,
      extraArgs: [],
      family: 'Gemma 3',
      unslothTemplateKey: 'gemma-3',
    };
  }
  if (id.includes('gemma-2') || id.includes('gemma2')) {
    return {
      toolCallParser: 'hermes',
      chatTemplate: null,
      extraArgs: [],
      family: 'Gemma 2',
      unslothTemplateKey: 'gemma2',
    };
  }
  if (id.includes('gemma')) {
    return {
      toolCallParser: 'hermes',
      chatTemplate: null,
      extraArgs: [],
      family: 'Gemma',
      unslothTemplateKey: 'gemma',
    };
  }

  // ─── Phi (Unsloth: phi-4, phi-3) ───────────────────────────────────────────
  if (id.includes('phi-4') || id.includes('phi4')) {
    return {
      toolCallParser: 'hermes',
      chatTemplate: null,
      extraArgs: [],
      family: 'Phi 4',
      unslothTemplateKey: 'phi-4',
    };
  }
  if (id.includes('phi-3') || id.includes('phi3')) {
    return {
      toolCallParser: 'hermes',
      chatTemplate: null,
      extraArgs: [],
      family: 'Phi 3',
      unslothTemplateKey: 'phi-3',
    };
  }

  return NONE;
}

/**
 * Resolves only the tool-call parser for a model (for callers that don't need full params).
 */
export function getToolCallParserForModelId(modelId: string): string | null {
  return getVllmParamsForModel(modelId).toolCallParser;
}
