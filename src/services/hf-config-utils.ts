/**
 * Shared HuggingFace config.json parsing helpers.
 *
 * VLM-wrapped configs (mistral3, qwen2_5_vl, llava, etc.) nest the real
 * text-model dimensions under `text_config`; the top-level fields describe
 * the multimodal wrapper and are usually absent/irrelevant for text-only
 * serving. Every consumer that reads config.json dimensions needs to check
 * both levels, or it silently mis-scores VLM-wrapped text models as having
 * 0 context / 0 params.
 *
 * This was previously duplicated (with drifted, inconsistent completeness)
 * across four files: agent-builder-baseline.ts, hf-card-parser.ts,
 * model-discovery.ts, and hardware-estimator.ts. Three of the four omitted
 * the text_config fallback entirely, causing every VLM-wrapped release
 * (Mistral-Small-3.x, Qwen3.6-*) to be mis-scored as 0-context-window and
 * silently dropped at discovery/scoring gates. See git history on this file
 * for the incident. Consolidated here as the single source of truth so a
 * fix (or a new field to check) never has to be applied in more than one
 * place again.
 */

/** Loose shape matching any raw parsed HuggingFace config.json. */
export type RawHfConfig = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Extract the effective context window (max sequence length in tokens) from
 * a HuggingFace config.json, checking `text_config` as a fallback for every
 * field. Optionally falls back to README text patterns (e.g. "context
 * window: 128k") when the config is absent or incomplete.
 */
export function extractContextWindowFromConfig(
  config: RawHfConfig | null | undefined,
  readme = '',
): number {
  if (config) {
    const tc = asRecord(config['text_config']);

    const maxPos =
      asNumber(config['max_position_embeddings']) ??
      asNumber(config['n_positions']) ??
      asNumber(config['max_sequence_length']) ??
      (tc && asNumber(tc['max_position_embeddings'])) ??
      (tc && asNumber(tc['n_positions'])) ??
      (tc && asNumber(tc['max_sequence_length']));
    let window = maxPos ?? 0;

    const slidingWindow = asNumber(config['sliding_window']) ?? (tc && asNumber(tc['sliding_window']));
    if (slidingWindow && slidingWindow > window) {
      window = slidingWindow;
    }

    const rope = asRecord(config['rope_scaling']) ?? (tc && asRecord(tc['rope_scaling']));
    if (rope) {
      const factor = asNumber(rope['factor']) ?? 1;
      const basePos =
        asNumber(rope['original_max_position_embeddings']) ??
        asNumber(config['max_position_embeddings']) ??
        (tc && asNumber(tc['max_position_embeddings'])) ??
        0;
      if (basePos > 0) {
        window = Math.floor(basePos * factor);
      }
    }

    if (window > 0) {
      return window;
    }
  }

  const regexes = [
    /context window[:\s]+(\d+[kKmM]?)/i,
    /max position embeddings[:\s]+(\d+[kKmM]?)/i,
    /sequence length[:\s]+(\d+[kKmM]?)/i,
    /(\d+[kKmM]?)\s*tokens/i,
  ];

  for (const regex of regexes) {
    const match = readme.match(regex);
    if (match?.[1]) {
      const val = parseSizeStringToTokens(match[1]);
      if (val > 0) return val;
    }
  }

  return 0;
}

function parseSizeStringToTokens(str: string): number {
  const cleaned = str.trim().toLowerCase().replace(/,/g, '');
  if (cleaned.endsWith('k')) return parseFloat(cleaned.slice(0, -1)) * 1_000;
  if (cleaned.endsWith('m')) return parseFloat(cleaned.slice(0, -1)) * 1_000_000;
  return parseFloat(cleaned) || 0;
}

/**
 * Merge `text_config` fields over the top-level config, so any downstream
 * reader of dimensional fields (hidden_size, num_hidden_layers, etc. — not
 * just context window) sees the real text-model values instead of the
 * multimodal wrapper's (usually absent) top-level fields.
 *
 * text_config wins when present since it holds the real transformer dims;
 * quantization_config is read from whichever level actually defines it
 * (quantization is typically applied to the wrapper, not nested).
 */
export function resolveEffectiveHfConfig<T extends RawHfConfig>(config: T): T {
  const tc = asRecord(config['text_config']);
  if (!tc) return config;
  return {
    ...config,
    ...tc,
    quantization_config: config['quantization_config'] ?? tc['quantization_config'],
  } as T;
}

/**
 * Classify a HuggingFace model's architecture family from config.json,
 * for vLLM param selection / baseline scoring / discovery filtering.
 *
 * `model_type` (when present) is authoritative and used as-is. Otherwise
 * falls back to substring-matching the first `architectures[]` class name
 * against known families. Previously duplicated with a narrower, drifted
 * mapping table in agent-builder-baseline.ts (missing deepseek, falcon,
 * gpt_neox, gpt2, mpt, bloom, opt, stablelm, command-r, cohere) — a model
 * could be classified differently by the discovery gate than by the Agent
 * Builder baseline check, silently causing inconsistent vLLM param/tool-call
 * parser selection depending on which code path scored it first.
 */
export function normalizeArchitectureFromConfig(config: RawHfConfig): string | null {
  const modelType = config['model_type'];
  if (typeof modelType === 'string' && modelType.length > 0) return modelType;

  const architectures = config['architectures'];
  const cls =
    Array.isArray(architectures) && typeof architectures[0] === 'string' ? architectures[0] : '';
  if (!cls) return null;

  if (cls.includes('Llama')) return 'llama';
  if (cls.includes('Mistral')) return 'mistral';
  if (cls.includes('Mixtral')) return 'mixtral';
  if (cls.includes('Qwen')) return 'qwen2';
  if (cls.includes('Gemma')) return 'gemma';
  if (cls.includes('Phi')) return 'phi3';
  if (cls.includes('Deepseek') || cls.includes('DeepSeek')) return 'deepseek';
  if (cls.includes('Falcon')) return 'falcon';
  if (cls.includes('GPTNeoX')) return 'gpt_neox';
  if (cls.includes('GPT2')) return 'gpt2';
  if (cls.includes('Mpt')) return 'mpt';
  if (cls.includes('Bloom')) return 'bloom';
  if (cls.includes('OPT')) return 'opt';
  if (cls.includes('StableLm')) return 'stablelm';
  if (cls.includes('CommandR')) return 'command-r';
  if (cls.includes('Cohere')) return 'cohere';

  return null;
}
