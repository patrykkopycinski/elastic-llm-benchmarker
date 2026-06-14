import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ONE_HOUR_MS = 3_600_000;
const MAX_CONTEXT_WINDOW = 128_000;

export interface HFCardParserOptions {
  modelId: string;
  hfApiToken?: string;
  cacheDir?: string;
}

export interface HFModelCard {
  modelId: string;
  name: string;
  architecture: string;
  contextWindow: number;
  parameterCount: number | null;
  license: string;
  quantizations: string[];
  supportedTasks: string[];
  supportsToolCalling: boolean;
}

export interface VllmConfigFlags {
  tensorParallelSize: number;
  maxModelLen?: number;
  maxNumSeqs?: number;
  quantization?: string;
  toolCallParser?: string;
  trustRemoteCode: boolean;
  additionalFlags: string[];
  gpuMemoryRequiredGb: number | null;
}

export interface ParsedHFCard {
  card: HFModelCard;
  vllmFlags: VllmConfigFlags;
  warnings: string[];
}

export class HFCardParser {
  constructor(private readonly baseCacheDir = './.hf-cache') {}

  async parse(options: HFCardParserOptions): Promise<ParsedHFCard> {
    const { modelId, hfApiToken, cacheDir } = options;
    const effectiveCacheDir = cacheDir ?? this.baseCacheDir;

    const metadataUrl = `https://huggingface.co/api/models/${modelId}`;
    const metadataCachePath = path.join(effectiveCacheDir, modelId, 'metadata.json');
    const metadataRaw = await this.fetchWithCache(metadataUrl, metadataCachePath, hfApiToken);
    const metadata = metadataRaw
      ? (this.safeJsonParse(metadataRaw) as Record<string, unknown> | null)
      : null;

    const files = await this.fetchModelFiles(modelId, hfApiToken);

    const readme = files.readme ?? '';
    const configJson = files.configJson;
    const generationConfigJson = files.generationConfigJson;

    const name = this.extractName(readme, metadata, modelId);
    const architecture = this.extractArchitecture(configJson, metadata);
    const contextWindow = this.extractContextWindow(configJson, readme);
    const parameterCount = this.extractParameterCount(configJson, readme, metadata);
    const license = this.extractLicense(metadata, readme);
    const quantizations = this.extractQuantizations(configJson, readme, metadata);
    const supportedTasks = this.extractSupportedTasks(metadata);
    const supportsToolCalling = this.detectToolCalling(readme, metadata, configJson);

    const warnings: string[] = [];
    if (files.readme === null) {
      warnings.push('README.md not found, name may be inaccurate');
    }
    if (files.configJson === null) {
      warnings.push('config.json not found, architecture and context window may be inaccurate');
    }
    if (files.generationConfigJson === null) {
      warnings.push('generation_config.json not found, vLLM flags may be incomplete');
    }
    if (parameterCount === null) {
      warnings.push('Cannot determine parameter count, using default flags');
    }
    if (contextWindow < 1_024) {
      warnings.push(`Context window is suspiciously small (${contextWindow} tokens)`);
    }

    const card: HFModelCard = {
      modelId,
      name,
      architecture,
      contextWindow,
      parameterCount,
      license,
      quantizations,
      supportedTasks,
      supportsToolCalling,
    };

    const vllmFlags = this.inferVllmFlags(configJson, generationConfigJson, card);

    return { card, vllmFlags, warnings };
  }

  private async fetchModelFiles(
    modelId: string,
    token?: string,
  ): Promise<{
    readme: string | null;
    configJson: Record<string, unknown> | null;
    generationConfigJson: Record<string, unknown> | null;
  }> {
    const cacheModelDir = path.join(this.baseCacheDir, modelId);
    const readmeUrl = `https://huggingface.co/${modelId}/raw/main/README.md`;
    const configUrl = `https://huggingface.co/${modelId}/raw/main/config.json`;
    const genConfigUrl = `https://huggingface.co/${modelId}/raw/main/generation_config.json`;

    const [readmeRaw, configRaw, genConfigRaw] = await Promise.all([
      this.fetchWithCache(readmeUrl, path.join(cacheModelDir, 'README.md'), token),
      this.fetchWithCache(configUrl, path.join(cacheModelDir, 'config.json'), token),
      this.fetchWithCache(genConfigUrl, path.join(cacheModelDir, 'generation_config.json'), token),
    ]);

    return {
      readme: readmeRaw,
      configJson: configRaw
        ? (this.safeJsonParse(configRaw) as Record<string, unknown> | null)
        : null,
      generationConfigJson: genConfigRaw
        ? (this.safeJsonParse(genConfigRaw) as Record<string, unknown> | null)
        : null,
    };
  }

  private inferVllmFlags(
    configJson: Record<string, unknown> | null,
    generationConfigJson: Record<string, unknown> | null,
    card: HFModelCard,
  ): VllmConfigFlags {
    let tensorParallelSize = 1;
    if (card.parameterCount !== null) {
      if (card.parameterCount > 80) {
        tensorParallelSize = 4;
      } else if (card.parameterCount > 40) {
        tensorParallelSize = 2;
      }
    }

    let maxModelLen: number | undefined;
    const maxPos =
      configJson?.['max_position_embeddings'] ?? configJson?.['n_positions'];
    if (typeof maxPos === 'number') {
      maxModelLen = Math.min(maxPos, MAX_CONTEXT_WINDOW);
    }

    let quantization: string | undefined;
    const quantConfig = configJson?.['quantization_config'];
    if (
      quantConfig &&
      typeof quantConfig === 'object' &&
      'quant_method' in quantConfig &&
      typeof (quantConfig as Record<string, unknown>).quant_method === 'string'
    ) {
      quantization = (quantConfig as Record<string, unknown>).quant_method as string;
    } else if (typeof configJson?.['torch_dtype'] === 'string') {
      quantization = configJson['torch_dtype'];
    }

    const archLower = card.architecture.toLowerCase();
    const trustRemoteCode =
      archLower === 'custom' || archLower === 'mpt' || archLower === 'falcon';

    let toolCallParser: string | undefined;
    const idLower = card.modelId.toLowerCase();
    if (idLower.includes('hermes')) {
      toolCallParser = 'hermes';
    } else if (idLower.includes('llama-3')) {
      toolCallParser = 'llama3';
    } else if (generationConfigJson) {
      const tp =
        generationConfigJson['tool_parser'] ?? generationConfigJson['tool_call_parser'];
      if (typeof tp === 'string') {
        toolCallParser = tp;
      }
    }

    const additionalFlags: string[] = [];
    if (card.supportsToolCalling) {
      additionalFlags.push('--enable-auto-tool-choice');
    }

    const gpuMemoryRequiredGb = this.estimateGpuMemory(card.parameterCount, quantization);

    return {
      tensorParallelSize,
      maxModelLen,
      quantization,
      toolCallParser,
      trustRemoteCode,
      additionalFlags,
      gpuMemoryRequiredGb,
    };
  }

  private estimateGpuMemory(
    parameterCountB: number | null,
    quantization?: string,
  ): number | null {
    if (parameterCountB === null) return null;

    const q = (quantization ?? '').toLowerCase();
    let bytesPerParam = 2.0;
    if (
      q.includes('int4') ||
      q.includes('4bit') ||
      q.includes('bnb') ||
      q.includes('gguf')
    ) {
      bytesPerParam = 0.5;
    } else if (
      q.includes('fp8') ||
      q.includes('int8') ||
      q.includes('8bit') ||
      q.includes('awq') ||
      q.includes('gptq')
    ) {
      bytesPerParam = 1.0;
    } else if (q.includes('fp16') || q.includes('bf16')) {
      bytesPerParam = 2.0;
    }

    const mem = parameterCountB * bytesPerParam * 1.2;
    return Math.ceil(mem);
  }

  private extractName(
    readme: string,
    metadata: Record<string, unknown> | null,
    modelId: string,
  ): string {
    const h1Match = readme.match(/^# (.+)$/m);
    if (h1Match?.[1]) {
      return h1Match[1].trim();
    }

    if (metadata && typeof metadata.id === 'string') {
      const parts = metadata.id.split('/');
      const last = parts.pop();
      if (last) return last;
      return metadata.id;
    }

    const parts = modelId.split('/');
    const last = parts.pop();
    return last ?? modelId;
  }

  private extractArchitecture(
    configJson: Record<string, unknown> | null,
    metadata: Record<string, unknown> | null,
  ): string {
    if (configJson) {
      const archs = configJson['architectures'];
      if (Array.isArray(archs) && archs.length > 0 && typeof archs[0] === 'string') {
        return this.normalizeArchitecture(archs[0]);
      }
    }

    if (metadata) {
      const cfg = metadata['config'];
      if (cfg && typeof cfg === 'object') {
        const cfgObj = cfg as Record<string, unknown>;
        const archs = cfgObj['architectures'];
        if (Array.isArray(archs) && archs.length > 0 && typeof archs[0] === 'string') {
          return this.normalizeArchitecture(archs[0]);
        }
      }
      if (typeof metadata['model_type'] === 'string') {
        return metadata['model_type'];
      }
    }

    return 'unknown';
  }

  private normalizeArchitecture(name: string): string {
    return name
      .replace(/ForCausalLM$/i, '')
      .replace(/ForConditionalGeneration$/i, '')
      .replace(/Model$/i, '')
      .replace(/LMHead$/i, '')
      .toLowerCase();
  }

  private extractContextWindow(
    configJson: Record<string, unknown> | null,
    readme: string,
  ): number {
    if (configJson) {
      const maxPos =
        configJson['max_position_embeddings'] ??
        configJson['n_positions'] ??
        configJson['max_sequence_length'];
      if (typeof maxPos === 'number') {
        return maxPos;
      }

      const rope = configJson['rope_scaling'];
      if (rope && typeof rope === 'object') {
        const ropeObj = rope as Record<string, unknown>;
        const factor = typeof ropeObj.factor === 'number' ? ropeObj.factor : 1;
        const basePos =
          typeof ropeObj.original_max_position_embeddings === 'number'
            ? ropeObj.original_max_position_embeddings
            : typeof configJson['max_position_embeddings'] === 'number'
              ? configJson['max_position_embeddings']
              : 0;
        if (basePos > 0) {
          return Math.floor(basePos * factor);
        }
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
        const val = this.parseSizeString(match[1]);
        if (val > 0) return val;
      }
    }

    return 0;
  }

  private parseSizeString(str: string): number {
    const cleaned = str.trim().toLowerCase().replace(/,/g, '');
    if (cleaned.endsWith('k')) return parseFloat(cleaned.slice(0, -1)) * 1_000;
    if (cleaned.endsWith('m')) return parseFloat(cleaned.slice(0, -1)) * 1_000_000;
    return parseFloat(cleaned) || 0;
  }

  private extractParameterCount(
    configJson: Record<string, unknown> | null,
    readme: string,
    metadata: Record<string, unknown> | null,
  ): number | null {
    if (metadata?.['tags'] && Array.isArray(metadata['tags'])) {
      for (const tag of metadata['tags']) {
        if (typeof tag !== 'string') continue;
        const match = tag.match(/^params:(\d+(\.\d+)?)$/i);
        if (match?.[1]) {
          return parseFloat(match[1]);
        }
        const matchB = tag.match(/^(\d+(\.\d+)?)[bB]$/i);
        if (matchB?.[1]) {
          return parseFloat(matchB[1]);
        }
      }
    }

    const readmeMatch = readme.match(/(\d+\.?\d*)\s*([BM])\s*parameters/i);
    if (readmeMatch?.[1] && readmeMatch[2]) {
      const val = parseFloat(readmeMatch[1]);
      const unit = readmeMatch[2].toUpperCase();
      if (unit === 'B') return val;
      if (unit === 'M') return val / 1_000;
    }

    if (typeof configJson?.['num_parameters'] === 'number') {
      const np = configJson['num_parameters'] as number;
      return np > 1_000_000_000 ? np / 1_000_000_000 : np;
    }

    if (
      configJson &&
      typeof configJson['hidden_size'] === 'number' &&
      typeof configJson['num_hidden_layers'] === 'number'
    ) {
      const h = configJson['hidden_size'] as number;
      const l = configJson['num_hidden_layers'] as number;
      const v =
        typeof configJson['vocab_size'] === 'number'
          ? (configJson['vocab_size'] as number)
          : 0;
      const i =
        typeof configJson['intermediate_size'] === 'number'
          ? (configJson['intermediate_size'] as number)
          : h * 4;
      const estimate = v * h + l * (4 * h * h + 3 * h * i);
      return estimate / 1_000_000_000;
    }

    if (metadata && typeof metadata.id === 'string') {
      const match = metadata.id.match(/(\d+(\.\d+)?)[bB]/);
      if (match?.[1]) {
        return parseFloat(match[1]);
      }
    }

    const idMatch = readme.match(/(\d+(\.\d+)?)[bB]/);
    if (idMatch?.[1]) {
      return parseFloat(idMatch[1]);
    }

    return null;
  }

  private extractLicense(
    metadata: Record<string, unknown> | null,
    readme: string,
  ): string {
    if (metadata?.['tags'] && Array.isArray(metadata['tags'])) {
      for (const tag of metadata['tags']) {
        if (typeof tag !== 'string') continue;
        if (tag.toLowerCase().startsWith('license:')) {
          const parts = tag.split(':');
          const lic = parts[1];
          if (lic) return lic.toLowerCase();
        }
      }
    }

    const match = readme.match(/license[:\s]+([^\s\n]+)/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }

    return 'unknown';
  }

  private extractQuantizations(
    configJson: Record<string, unknown> | null,
    readme: string,
    metadata: Record<string, unknown> | null,
  ): string[] {
    const quants = new Set<string>();

    if (
      configJson?.['quantization_config'] &&
      typeof configJson['quantization_config'] === 'object'
    ) {
      const qc = configJson['quantization_config'] as Record<string, unknown>;
      if (typeof qc.quant_method === 'string') {
        quants.add(qc.quant_method);
      }
      if (typeof qc.bits === 'number') {
        quants.add(`${qc.quant_method}-${qc.bits}bit`);
      }
    }

    if (typeof configJson?.['torch_dtype'] === 'string') {
      quants.add(configJson['torch_dtype']);
    }

    if (metadata?.['tags'] && Array.isArray(metadata['tags'])) {
      for (const tag of metadata['tags']) {
        if (typeof tag !== 'string') continue;
        const lower = tag.toLowerCase();
        if (
          lower.includes('gptq') ||
          lower.includes('awq') ||
          lower.includes('gguf') ||
          lower.includes('bnb') ||
          lower.includes('fp16') ||
          lower.includes('bf16') ||
          lower.includes('fp8') ||
          lower.includes('int8') ||
          lower.includes('int4') ||
          lower.includes('4bit') ||
          lower.includes('8bit')
        ) {
          quants.add(lower);
        }
      }
    }

    const readmeLower = readme.toLowerCase();
    const keywords = [
      'gptq',
      'awq',
      'gguf',
      'bnb',
      'fp8',
      'fp16',
      'bf16',
      'int8',
      'int4',
      '4bit',
      '8bit',
    ];
    for (const kw of keywords) {
      if (readmeLower.includes(kw)) {
        quants.add(kw);
      }
    }

    if (metadata?.['siblings'] && Array.isArray(metadata['siblings'])) {
      for (const sib of metadata['siblings']) {
        if (
          sib &&
          typeof sib === 'object' &&
          'rfilename' in sib &&
          typeof (sib as Record<string, unknown>).rfilename === 'string'
        ) {
          const fname = ((sib as Record<string, unknown>).rfilename as string).toLowerCase();
          if (fname.includes('gptq')) quants.add('gptq');
          if (fname.includes('awq')) quants.add('awq');
          if (fname.endsWith('.gguf')) quants.add('gguf');
        }
      }
    }

    if (quants.size === 0) {
      quants.add('fp16');
    }

    return Array.from(quants).sort();
  }

  private extractSupportedTasks(metadata: Record<string, unknown> | null): string[] {
    const tasks: string[] = [];
    if (metadata && typeof metadata['pipeline_tag'] === 'string') {
      tasks.push(metadata['pipeline_tag']);
    }
    if (metadata?.['tags'] && Array.isArray(metadata['tags'])) {
      for (const tag of metadata['tags']) {
        if (typeof tag === 'string' && tag.startsWith('task:')) {
          tasks.push(tag.replace('task:', ''));
        }
      }
    }
    return tasks;
  }

  private detectToolCalling(
    readme: string,
    metadata: Record<string, unknown> | null,
    configJson: Record<string, unknown> | null,
  ): boolean {
    const idLower =
      metadata && typeof metadata.id === 'string' ? metadata.id.toLowerCase() : '';
    const readmeLower = readme.toLowerCase();

    if (configJson?.['tool_parser'] || configJson?.['tool_call_parser']) {
      return true;
    }

    if (metadata?.['tags'] && Array.isArray(metadata['tags'])) {
      for (const tag of metadata['tags']) {
        if (typeof tag !== 'string') continue;
        const t = tag.toLowerCase();
        if (
          t.includes('tool-calling') ||
          t.includes('function-calling') ||
          t.includes('tool_use') ||
          t.includes('tool-use') ||
          t.includes('tools') ||
          t.includes('functioncalling')
        ) {
          return true;
        }
      }
    }

    const indicators = [
      'tool-calling',
      'function-calling',
      'tool_use',
      'tool-use',
      'tools',
      'functioncalling',
      'hermes',
    ];
    for (const ind of indicators) {
      if (idLower.includes(ind) || readmeLower.includes(ind)) return true;
    }

    return false;
  }

  private async fetchWithCache(
    url: string,
    cacheFile: string,
    token?: string,
  ): Promise<string | null> {
    const now = Date.now();

    try {
      const stats = await fs.stat(cacheFile);
      if (now - stats.mtimeMs < ONE_HOUR_MS) {
        return await fs.readFile(cacheFile, 'utf-8');
      }
    } catch {
      // Cache miss or unreadable
    }

    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const response = await fetch(url, { headers });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, text, 'utf-8');
      return text;
    } catch {
      return null;
    }
  }

  private safeJsonParse(text: string | null): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
