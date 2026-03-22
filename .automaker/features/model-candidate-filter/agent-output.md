

I'll start by exploring the codebase to understand the existing structure before implementing the model candidate filter feature.

🔧 Tool: Task
Input: {
  "description": "Explore codebase structure",
  "prompt": "Explore the codebase thoroughly to understand:\n1. The overall project structure (what kind of project is this - web app, API, CLI tool, etc.)\n2. Look for any files related to model evaluation, model selection, or model filtering\n3. Find MODEL_EVALUATION_LOG.md if it exists\n4. Look for any existing filter/validation patterns\n5. Understand the tech stack (language, framework, testing setup)\n6. Look for any configuration files related to models or deployment\n\nPlease provide a comprehensive overview of:\n- The directory structure (top-level and key subdirectories)\n- Key configuration files (package.json, tsconfig, etc.)\n- Any existing model-related code\n- The testing setup (especially Playwright)\n- Any existing filter or validation patterns\n\nBe very thorough - check for files like MODEL_EVALUATION_LOG.md, any model configs, deployment configs, etc.",
  "subagent_type": "Explore"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker -type f -name \"*.md\" | head -20",
  "description": "Find all markdown files to look for documentation like MODEL_EVALUATION_LOG.md"
}

🔧 Tool: Bash
Input: {
  "command": "ls -la /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker",
  "description": "List all files and directories in the root"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/package.json"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src -type f | head -50",
  "description": "List all source files"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker -maxdepth 1 -name \"*.md\"",
  "description": "Find markdown files in root directory"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/config -type f",
  "description": "List all config files"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/config/default.json"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/index.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/config.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/benchmark.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/agent/state.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/model-discovery.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/agent/nodes.ts"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/tests -type f -name \"*.ts\"",
  "description": "List all test files"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/tsconfig.json"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/vitest.config.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/results-store.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/agent/graph.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/playwright-verification.test.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/agent/agent.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/hardware-profiles.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/agent.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/api/routes.ts",
  "limit": 100
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/index.ts"
}

🔧 Tool: Bash
Input: {
  "command": "ls -la /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker",
  "description": "Check automaker directory contents"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/app_spec.txt"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/tests/unit/model-discovery.test.ts",
  "limit": 80
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker -name \"*filter*\" -o -name \"*evaluation*\" -o -name \"*MODEL_EVAL*\" 2>/dev/null",
  "description": "Search for filter or evaluation related files"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features -type f | head -20",
  "description": "List feature files"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features/model-evaluation-engine"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features/model-candidate-filter"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features/model-evaluation-engine/feature.json"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features/model-candidate-filter/feature.json"
}

🔧 Tool: Bash
Input: {
  "command": "find /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features -name \"feature.json\" | head -15",
  "description": "List all feature.json files"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.env.example"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/config/index.ts"
}

🔧 Tool: Bash
Input: {
  "command": "grep -r \"validator\\|filter\\|reject\\|criteria\" /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src --include=\"*.ts\" -l",
  "description": "Find files with validation or filtering logic"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/api/routes.ts",
  "offset": 100
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/ssh-client.ts",
  "limit": 80
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/utils/logger.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/api/dashboard-server.ts",
  "limit": 80
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/backlog-plan.json"
}
Excellent! Now let me read the key files I need to understand in detail before implementing the feature.

🔧 Tool: Read
Input: {
  "file_path": "/home/user/elastic-llm-benchmarker/src/services/model-discovery.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/home/user/elastic-llm-benchmarker/src/types/benchmark.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/home/user/elastic-llm-benchmarker/src/types/config.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/home/user/elastic-llm-benchmarker/src/services/hardware-profiles.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/home/user/elastic-llm-benchmarker/src/agent/nodes.ts"
}
Let me find the actual project root directory first.

🔧 Tool: Bash
Input: {
  "command": "find / -name \"package.json\" -not -path \"*/node_modules/*\" -maxdepth 5 2>/dev/null | head -20",
  "description": "Find project root by locating package.json"
}

🔧 Tool: Glob
Input: {
  "pattern": "**/.automaker/features/model-candidate-filter/**"
}
Found it. The project is at `/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/`. Let me now read the key files.

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/model-discovery.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/benchmark.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/config.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/hardware-profiles.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/agent/nodes.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/.automaker/features/model-candidate-filter/feature.json"
}
Now let me read the remaining key files to fully understand the codebase patterns.

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/agent/state.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/index.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/tests/unit/model-discovery.test.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/types/agent.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/package.json"
}
Now I have a comprehensive understanding of the codebase. Let me also check for the vitest config and existing playwright setup:

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/vitest.config.ts"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/playwright-verification.test.ts"
}

🔧 Tool: TodoWrite
Input: {
  "todos": [
    {
      "content": "Create ModelCandidateFilter service with pre-deployment filtering logic",
      "status": "in_progress",
      "activeForm": "Creating ModelCandidateFilter service"
    },
    {
      "content": "Implement context size >= 128K hard requirement filter",
      "status": "pending",
      "activeForm": "Implementing context size filter"
    },
    {
      "content": "Implement model size fits in 2x A100 80GB filter",
      "status": "pending",
      "activeForm": "Implementing model size filter"
    },
    {
      "content": "Implement vLLM architecture support filter",
      "status": "pending",
      "activeForm": "Implementing vLLM architecture filter"
    },
    {
      "content": "Implement tool calling capability filter with parser detection",
      "status": "pending",
      "activeForm": "Implementing tool calling filter"
    },
    {
      "content": "Implement known-failure skip list",
      "status": "pending",
      "activeForm": "Implementing known-failure skip list"
    },
    {
      "content": "Add types and interfaces for filter results",
      "status": "pending",
      "activeForm": "Adding types and interfaces"
    },
    {
      "content": "Export new module from index.ts",
      "status": "pending",
      "activeForm": "Exporting from index.ts"
    },
    {
      "content": "Write comprehensive unit tests",
      "status": "pending",
      "activeForm": "Writing unit tests"
    },
    {
      "content": "Verify with Playwright",
      "status": "pending",
      "activeForm": "Verifying with Playwright"
    }
  ]
}
Now I have a thorough understanding of the codebase. Let me implement the Model Candidate Pre-Filtering Engine. I'll create the main service file first:

🔧 Tool: Write
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/services/model-candidate-filter.ts",
  "content": "import type { ModelInfo } from '../types/benchmark.js';\nimport type { VMHardwareProfile } from '../types/config.js';\nimport { createLogger } from '../utils/logger.js';\n\n// ─── Filter Result Types ─────────────────────────────────────────────────────\n\n/** Reason a model was rejected during pre-deployment filtering */\nexport interface FilterRejection {\n  /** The filter criterion that rejected the model */\n  criterion: FilterCriterion;\n  /** Human-readable explanation of why the model was rejected */\n  reason: string;\n  /** Whether this criterion is a hard requirement (vs. soft/warning) */\n  isHardRequirement: boolean;\n}\n\n/** Filter criteria identifiers */\nexport type FilterCriterion =\n  | 'context_size'\n  | 'model_size'\n  | 'vllm_architecture'\n  | 'tool_calling'\n  | 'known_failure';\n\n/** Result of filtering a single model candidate */\nexport interface FilterResult {\n  /** The model that was evaluated */\n  model: ModelInfo;\n  /** Whether the model passed all hard requirement filters */\n  passed: boolean;\n  /** Rejections (hard failures that block deployment) */\n  rejections: FilterRejection[];\n  /** Warnings (soft failures that don't block but are noteworthy) */\n  warnings: FilterRejection[];\n  /** The recommended vLLM tool call parser for this model, if applicable */\n  recommendedToolCallParser: string | null;\n  /** Estimated VRAM usage in GB (approximate) */\n  estimatedVramGb: number | null;\n}\n\n/** Result of filtering a batch of model candidates */\nexport interface BatchFilterResult {\n  /** Models that passed all hard requirement filters */\n  passed: FilterResult[];\n  /** Models that were rejected by one or more hard requirement filters */\n  rejected: FilterResult[];\n  /** Total number of models evaluated */\n  totalEvaluated: number;\n  /** Timestamp of the filter run */\n  timestamp: string;\n}\n\n/** Configuration options for the candidate filter */\nexport interface CandidateFilterOptions {\n  /** Minimum context window size in tokens (default: 128000) */\n  minContextWindow?: number;\n  /** Target hardware profile for model size fitting (default: 2x A100 80GB) */\n  targetHardwareProfile?: VMHardwareProfile;\n  /** Whether to require tool calling support (default: true) */\n  requireToolCalling?: boolean;\n  /** Whether to check against known failure list (default: true) */\n  checkKnownFailures?: boolean;\n}\n\n// ─── Constants ───────────────────────────────────────────────────────────────\n\nconst DEFAULT_MIN_CONTEXT_WINDOW = 128_000;\n\n/**\n * Default target hardware: 2x A100 80GB = 160GB total VRAM.\n * Models must fit within this VRAM budget.\n */\nconst DEFAULT_TARGET_HARDWARE: VMHardwareProfile = {\n  gpuType: 'nvidia-a100-80gb',\n  gpuCount: 2,\n  ramGb: 680,\n  cpuCores: 24,\n  diskGb: 1000,\n  machineType: 'a2-ultragpu-2g',\n};\n\n/** Bytes per parameter for different precisions */\nconst BYTES_PER_PARAM: Record<string, number> = {\n  fp32: 4,\n  fp16: 2,\n  bf16: 2,\n  fp8: 1,\n  int8: 1,\n  int4: 0.5,\n  'gptq-4bit': 0.5,\n  'gptq-8bit': 1,\n  'awq-4bit': 0.5,\n  gptq: 0.5,\n  awq: 0.5,\n  '4bit': 0.5,\n  '8bit': 1,\n};\n\n/** VRAM per GPU for known GPU types (in GB) */\nconst GPU_VRAM_GB: Record<string, number> = {\n  'nvidia-a100-80gb': 80,\n  'nvidia-a100-40gb': 40,\n  'nvidia-a100': 80,\n  'nvidia-h100': 80,\n  'nvidia-l4': 24,\n  'nvidia-t4': 16,\n  'nvidia-v100': 16,\n  'nvidia-a10g': 24,\n};\n\n/**\n * vLLM supported architectures with their corresponding tool call parser.\n * Only model families that have verified vLLM tool calling support are listed.\n */\nconst VLLM_TOOL_CALL_PARSERS: Record<string, string> = {\n  // Hermes-style tool calling (Qwen, NousResearch Hermes models)\n  qwen: 'hermes',\n  qwen2: 'hermes',\n  qwen2_moe: 'hermes',\n  // Mistral-native tool calling\n  mistral: 'mistral',\n  mixtral: 'mistral',\n  // Llama 3 JSON-based tool calling\n  llama: 'llama3_json',\n  codellama: 'llama3_json',\n};\n\n/**\n * Architectures that vLLM supports for inference (broader than tool-calling list).\n */\nconst VLLM_SUPPORTED_ARCHITECTURES = new Set([\n  'llama',\n  'mistral',\n  'mixtral',\n  'qwen',\n  'qwen2',\n  'qwen2_moe',\n  'gemma',\n  'gemma2',\n  'phi',\n  'phi3',\n  'starcoder2',\n  'codellama',\n  'deepseek',\n  'deepseek_v2',\n  'deepseek_v3',\n  'internlm',\n  'internlm2',\n  'yi',\n  'baichuan',\n  'chatglm',\n  'falcon',\n  'mpt',\n  'bloom',\n  'opt',\n  'gpt_neox',\n  'gpt2',\n  'gptj',\n  'stablelm',\n  'command-r',\n  'cohere',\n  'dbrx',\n  'jamba',\n  'olmo',\n  'arctic',\n  'exaone',\n]);\n\n/**\n * Models known to fail deployment or benchmarking.\n * These are auto-skipped during pre-filtering to save time and resources.\n *\n * Format: exact model ID or prefix pattern (ending with '*').\n */\nconst KNOWN_FAILURE_LIST: ReadonlyMap<string, string> = new Map([\n  // Models with known OOM issues on 2x A100 80GB\n  ['tiiuae/falcon-180B', 'Exceeds 2x A100 80GB VRAM even with quantization'],\n  ['bigscience/bloom', 'Exceeds 2x A100 80GB VRAM (176B parameters)'],\n  ['EleutherAI/gpt-neox-20b', 'Known vLLM compatibility issues with this specific checkpoint'],\n  // Models with broken tool calling despite claiming support\n  ['stabilityai/stablelm-2-*', 'Tool calling not reliably supported in vLLM'],\n  // Models known to produce incorrect outputs with vLLM\n  ['mosaicml/mpt-30b-*', 'Known inference issues with vLLM serving'],\n]);\n\n// ─── Model Candidate Filter Service ──────────────────────────────────────────\n\n/**\n * Pre-deployment filter service for LLM model candidates.\n *\n * Evaluates models against deployment criteria before committing\n * expensive GPU resources for benchmarking. Filters include:\n *\n * 1. **Context Size** (hard): Model must support >= 128K tokens\n * 2. **Model Size** (hard): Model must fit in target hardware (2x A100 80GB)\n * 3. **vLLM Architecture** (hard): Architecture must be supported by vLLM\n * 4. **Tool Calling** (configurable): Model family must support tool calling\n *    with a known vLLM parser (hermes, mistral, llama3_json)\n * 5. **Known Failures** (hard): Auto-skip models known to fail\n *\n * @example\n * ```typescript\n * const filter = new ModelCandidateFilter('info');\n * const result = filter.evaluate(modelInfo);\n *\n * if (result.passed) {\n *   console.log(`Model ${result.model.id} passed with parser: ${result.recommendedToolCallParser}`);\n * } else {\n *   console.log(`Rejected: ${result.rejections.map(r => r.reason).join(', ')}`);\n * }\n * ```\n */\nexport class ModelCandidateFilter {\n  private readonly logger;\n  private readonly minContextWindow: number;\n  private readonly targetHardware: VMHardwareProfile;\n  private readonly requireToolCalling: boolean;\n  private readonly checkKnownFailures: boolean;\n\n  /**\n   * Creates a new ModelCandidateFilter instance.\n   *\n   * @param logLevel - Winston log level (default: 'info')\n   * @param options - Filter configuration options\n   */\n  constructor(logLevel: string = 'info', options: CandidateFilterOptions = {}) {\n    this.logger = createLogger(logLevel);\n    this.minContextWindow = options.minContextWindow ?? DEFAULT_MIN_CONTEXT_WINDOW;\n    this.targetHardware = options.targetHardwareProfile ?? DEFAULT_TARGET_HARDWARE;\n    this.requireToolCalling = options.requireToolCalling ?? true;\n    this.checkKnownFailures = options.checkKnownFailures ?? true;\n\n    this.logger.info('ModelCandidateFilter initialized', {\n      minContextWindow: this.minContextWindow,\n      targetGpu: `${this.targetHardware.gpuCount}x ${this.targetHardware.gpuType}`,\n      requireToolCalling: this.requireToolCalling,\n    });\n  }\n\n  /**\n   * Evaluates a single model candidate against all pre-deployment filter criteria.\n   *\n   * @param model - The model candidate to evaluate\n   * @returns Filter result with pass/fail status, rejections, and warnings\n   */\n  evaluate(model: ModelInfo): FilterResult {\n    const rejections: FilterRejection[] = [];\n    const warnings: FilterRejection[] = [];\n\n    this.logger.debug(`Evaluating candidate: ${model.id}`);\n\n    // Filter 1: Known failure check (fastest, do first)\n    if (this.checkKnownFailures) {\n      const knownFailure = this.checkKnownFailureList(model);\n      if (knownFailure) {\n        rejections.push(knownFailure);\n      }\n    }\n\n    // Filter 2: Context size (hard requirement)\n    const contextResult = this.checkContextSize(model);\n    if (contextResult) {\n      rejections.push(contextResult);\n    }\n\n    // Filter 3: vLLM architecture support (hard requirement)\n    const archResult = this.checkVllmArchitecture(model);\n    if (archResult) {\n      rejections.push(archResult);\n    }\n\n    // Filter 4: Model size fits in target hardware\n    const sizeResult = this.checkModelSize(model);\n    if (sizeResult) {\n      if (sizeResult.isHardRequirement) {\n        rejections.push(sizeResult);\n      } else {\n        warnings.push(sizeResult);\n      }\n    }\n\n    // Filter 5: Tool calling capability\n    const toolResult = this.checkToolCalling(model);\n    if (toolResult) {\n      if (this.requireToolCalling) {\n        rejections.push(toolResult);\n      } else {\n        warnings.push(toolResult);\n      }\n    }\n\n    // Determine recommended tool call parser\n    const recommendedToolCallParser = this.getRecommendedToolCallParser(model);\n\n    // Estimate VRAM usage\n    const estimatedVramGb = this.estimateVramUsage(model);\n\n    const passed = rejections.length === 0;\n\n    if (passed) {\n      this.logger.info(`Model PASSED pre-deployment filter: ${model.id}`, {\n        parser: recommendedToolCallParser,\n        estimatedVramGb,\n        warnings: warnings.length,\n      });\n    } else {\n      this.logger.info(`Model REJECTED by pre-deployment filter: ${model.id}`, {\n        rejections: rejections.map((r) => r.criterion),\n      });\n    }\n\n    return {\n      model,\n      passed,\n      rejections,\n      warnings,\n      recommendedToolCallParser,\n      estimatedVramGb,\n    };\n  }\n\n  /**\n   * Evaluates a batch of model candidates and partitions them into\n   * passed and rejected groups.\n   *\n   * @param models - Array of model candidates to evaluate\n   * @returns Batch filter result with passed/rejected partitions\n   */\n  evaluateBatch(models: ModelInfo[]): BatchFilterResult {\n    this.logger.info(`Evaluating batch of ${models.length} candidates`);\n\n    const passed: FilterResult[] = [];\n    const rejected: FilterResult[] = [];\n\n    for (const model of models) {\n      const result = this.evaluate(model);\n      if (result.passed) {\n        passed.push(result);\n      } else {\n        rejected.push(result);\n      }\n    }\n\n    const batchResult: BatchFilterResult = {\n      passed,\n      rejected,\n      totalEvaluated: models.length,\n      timestamp: new Date().toISOString(),\n    };\n\n    this.logger.info(\n      `Batch filter complete: ${passed.length} passed, ${rejected.length} rejected out of ${models.length}`,\n    );\n\n    return batchResult;\n  }\n\n  /**\n   * Returns the total available VRAM for the target hardware in GB.\n   */\n  getTotalVramGb(): number {\n    return this.calculateTotalVram(this.targetHardware);\n  }\n\n  /**\n   * Returns the recommended vLLM tool call parser for a model architecture.\n   *\n   * @param model - The model to get the parser for\n   * @returns Parser name or null if no parser is available\n   */\n  getRecommendedToolCallParser(model: ModelInfo): string | null {\n    const arch = model.architecture.toLowerCase();\n\n    // Direct match\n    if (VLLM_TOOL_CALL_PARSERS[arch]) {\n      return VLLM_TOOL_CALL_PARSERS[arch]!;\n    }\n\n    // Partial match for sub-architectures (e.g., \"qwen2_moe\" contains \"qwen\")\n    for (const [archKey, parser] of Object.entries(VLLM_TOOL_CALL_PARSERS)) {\n      if (arch.includes(archKey) || archKey.includes(arch)) {\n        return parser;\n      }\n    }\n\n    // Check model ID for family hints\n    const modelId = model.id.toLowerCase();\n    if (modelId.includes('qwen')) return 'hermes';\n    if (modelId.includes('mistral') || modelId.includes('mixtral')) return 'mistral';\n    if (modelId.includes('llama') || modelId.includes('codellama')) return 'llama3_json';\n\n    return null;\n  }\n\n  /**\n   * Estimates the VRAM usage of a model in GB.\n   * Returns null if parameter count is unknown.\n   *\n   * Uses the most VRAM-efficient quantization available, with\n   * a 20% overhead factor for KV cache and runtime buffers.\n   *\n   * @param model - The model to estimate VRAM for\n   * @returns Estimated VRAM usage in GB, or null\n   */\n  estimateVramUsage(model: ModelInfo): number | null {\n    if (!model.parameterCount) {\n      return null;\n    }\n\n    // Find the most efficient quantization method\n    const bytesPerParam = this.getBestBytesPerParam(model.quantizations);\n\n    // Base model weight size in GB\n    const modelWeightGb = (model.parameterCount * bytesPerParam) / (1024 * 1024 * 1024);\n\n    // Add ~20% overhead for KV cache, activations, and runtime buffers\n    const overheadFactor = 1.2;\n\n    return Math.round(modelWeightGb * overheadFactor * 10) / 10;\n  }\n\n  // ─── Private Filter Methods ──────────────────────────────────────────────\n\n  /**\n   * Checks if the model's context window meets the minimum requirement.\n   * This is a HARD requirement - models below 128K tokens are always rejected.\n   */\n  private checkContextSize(model: ModelInfo): FilterRejection | null {\n    if (model.contextWindow >= this.minContextWindow) {\n      return null;\n    }\n\n    return {\n      criterion: 'context_size',\n      reason: `Context window ${model.contextWindow.toLocaleString()} tokens is below the minimum requirement of ${this.minContextWindow.toLocaleString()} tokens`,\n      isHardRequirement: true,\n    };\n  }\n\n  /**\n   * Checks if the model fits within the target hardware's VRAM.\n   *\n   * If the parameter count is unknown, returns a warning (not a hard rejection).\n   * If the model exceeds VRAM, returns a hard rejection.\n   */\n  private checkModelSize(model: ModelInfo): FilterRejection | null {\n    if (!model.parameterCount) {\n      return {\n        criterion: 'model_size',\n        reason: 'Parameter count unknown; cannot verify VRAM fit. Proceeding with caution.',\n        isHardRequirement: false,\n      };\n    }\n\n    const totalVramGb = this.calculateTotalVram(this.targetHardware);\n    const estimatedVramGb = this.estimateVramUsage(model);\n\n    if (estimatedVramGb === null) {\n      return null;\n    }\n\n    if (estimatedVramGb > totalVramGb) {\n      return {\n        criterion: 'model_size',\n        reason: `Estimated VRAM usage ${estimatedVramGb}GB exceeds target hardware capacity of ${totalVramGb}GB (${this.targetHardware.gpuCount}x ${this.targetHardware.gpuType})`,\n        isHardRequirement: true,\n      };\n    }\n\n    return null;\n  }\n\n  /**\n   * Checks if the model's architecture is supported by vLLM.\n   */\n  private checkVllmArchitecture(model: ModelInfo): FilterRejection | null {\n    const arch = model.architecture.toLowerCase();\n\n    // Direct match\n    if (VLLM_SUPPORTED_ARCHITECTURES.has(arch)) {\n      return null;\n    }\n\n    // Partial match for sub-architectures\n    for (const supported of VLLM_SUPPORTED_ARCHITECTURES) {\n      if (arch.includes(supported) || supported.includes(arch)) {\n        return null;\n      }\n    }\n\n    return {\n      criterion: 'vllm_architecture',\n      reason: `Architecture '${model.architecture}' is not supported by vLLM`,\n      isHardRequirement: true,\n    };\n  }\n\n  /**\n   * Checks if the model supports tool calling via a known vLLM parser.\n   *\n   * Valid tool call parsers for vLLM:\n   * - hermes: Qwen family models\n   * - mistral: Mistral/Mixtral family models\n   * - llama3_json: Llama 3 family models\n   */\n  private checkToolCalling(model: ModelInfo): FilterRejection | null {\n    // First check: does the model claim tool calling support?\n    if (!model.supportsToolCalling) {\n      return {\n        criterion: 'tool_calling',\n        reason: 'Model does not support tool/function calling',\n        isHardRequirement: true,\n      };\n    }\n\n    // Second check: do we have a known vLLM parser for this model family?\n    const parser = this.getRecommendedToolCallParser(model);\n    if (!parser) {\n      return {\n        criterion: 'tool_calling',\n        reason: `No known vLLM tool call parser for architecture '${model.architecture}'. Supported families: Qwen (hermes), Mistral/Mixtral (mistral), Llama (llama3_json)`,\n        isHardRequirement: true,\n      };\n    }\n\n    return null;\n  }\n\n  /**\n   * Checks if the model is in the known failure list.\n   * Supports exact matches and prefix patterns (ending with '*').\n   */\n  private checkKnownFailureList(model: ModelInfo): FilterRejection | null {\n    // Exact match\n    const exactReason = KNOWN_FAILURE_LIST.get(model.id);\n    if (exactReason) {\n      return {\n        criterion: 'known_failure',\n        reason: `Model is in the known failure list: ${exactReason}`,\n        isHardRequirement: true,\n      };\n    }\n\n    // Prefix pattern match\n    for (const [pattern, reason] of KNOWN_FAILURE_LIST) {\n      if (pattern.endsWith('*')) {\n        const prefix = pattern.slice(0, -1);\n        if (model.id.startsWith(prefix)) {\n          return {\n            criterion: 'known_failure',\n            reason: `Model matches known failure pattern '${pattern}': ${reason}`,\n            isHardRequirement: true,\n          };\n        }\n      }\n    }\n\n    return null;\n  }\n\n  // ─── Private Utility Methods ─────────────────────────────────────────────\n\n  /**\n   * Calculates total VRAM for a hardware profile in GB.\n   */\n  private calculateTotalVram(hardware: VMHardwareProfile): number {\n    const gpuType = hardware.gpuType.toLowerCase();\n    const perGpuVram = GPU_VRAM_GB[gpuType] ?? 0;\n\n    if (perGpuVram === 0) {\n      // Fallback: try to parse VRAM from GPU type name\n      const vramMatch = gpuType.match(/(\\d+)gb/);\n      if (vramMatch?.[1]) {\n        return parseInt(vramMatch[1], 10) * hardware.gpuCount;\n      }\n      this.logger.warn(`Unknown GPU type: ${hardware.gpuType}, cannot calculate VRAM`);\n      return 0;\n    }\n\n    return perGpuVram * hardware.gpuCount;\n  }\n\n  /**\n   * Determines the lowest bytes-per-parameter based on available quantizations.\n   * Falls back to fp16 (2 bytes) if no quantization is recognized.\n   */\n  private getBestBytesPerParam(quantizations: string[]): number {\n    let best = 2; // Default: fp16\n\n    for (const quant of quantizations) {\n      const normalized = quant.toLowerCase();\n      const bytesPerParam = BYTES_PER_PARAM[normalized];\n      if (bytesPerParam !== undefined && bytesPerParam < best) {\n        best = bytesPerParam;\n      }\n    }\n\n    return best;\n  }\n}\n"
}

🔧 Tool: TodoWrite
Input: {
  "todos": [
    {
      "content": "Create ModelCandidateFilter service with pre-deployment filtering logic",
      "status": "completed",
      "activeForm": "Creating ModelCandidateFilter service"
    },
    {
      "content": "Implement context size >= 128K hard requirement filter",
      "status": "completed",
      "activeForm": "Implementing context size filter"
    },
    {
      "content": "Implement model size fits in 2x A100 80GB filter",
      "status": "completed",
      "activeForm": "Implementing model size filter"
    },
    {
      "content": "Implement vLLM architecture support filter",
      "status": "completed",
      "activeForm": "Implementing vLLM architecture filter"
    },
    {
      "content": "Implement tool calling capability filter with parser detection",
      "status": "completed",
      "activeForm": "Implementing tool calling filter"
    },
    {
      "content": "Implement known-failure skip list",
      "status": "completed",
      "activeForm": "Implementing known-failure skip list"
    },
    {
      "content": "Add types and interfaces for filter results",
      "status": "completed",
      "activeForm": "Adding types and interfaces"
    },
    {
      "content": "Export new module from index.ts",
      "status": "in_progress",
      "activeForm": "Exporting from index.ts"
    },
    {
      "content": "Write comprehensive unit tests",
      "status": "pending",
      "activeForm": "Writing unit tests"
    },
    {
      "content": "Verify with Playwright",
      "status": "pending",
      "activeForm": "Verifying with Playwright"
    }
  ]
}
Now let me export the new module from `index.ts`:

🔧 Tool: Edit
Input: {
  "replace_all": false,
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/index.ts",
  "old_string": "export { ModelDiscoveryService } from './services/model-discovery.js';\nexport type { ModelDiscoveryOptions, DiscoveryResult } from './services/model-discovery.js';",
  "new_string": "export { ModelDiscoveryService } from './services/model-discovery.js';\nexport type { ModelDiscoveryOptions, DiscoveryResult } from './services/model-discovery.js';\nexport { ModelCandidateFilter } from './services/model-candidate-filter.js';\nexport type {\n  FilterRejection,\n  FilterCriterion,\n  FilterResult,\n  BatchFilterResult,\n  CandidateFilterOptions,\n} from './services/model-candidate-filter.js';"
}

🔧 Tool: Read
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/index.ts"
}

🔧 Tool: Edit
Input: {
  "replace_all": false,
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/src/index.ts",
  "old_string": "export { ModelDiscoveryService } from './services/model-discovery.js';\nexport type { ModelDiscoveryOptions, DiscoveryResult } from './services/model-discovery.js';",
  "new_string": "export { ModelDiscoveryService } from './services/model-discovery.js';\nexport type { ModelDiscoveryOptions, DiscoveryResult } from './services/model-discovery.js';\nexport { ModelCandidateFilter } from './services/model-candidate-filter.js';\nexport type {\n  FilterRejection,\n  FilterCriterion,\n  FilterResult,\n  BatchFilterResult,\n  CandidateFilterOptions,\n} from './services/model-candidate-filter.js';"
}
Now let me write comprehensive unit tests:

🔧 Tool: TodoWrite
Input: {
  "todos": [
    {
      "content": "Create ModelCandidateFilter service with pre-deployment filtering logic",
      "status": "completed",
      "activeForm": "Creating ModelCandidateFilter service"
    },
    {
      "content": "Implement context size >= 128K hard requirement filter",
      "status": "completed",
      "activeForm": "Implementing context size filter"
    },
    {
      "content": "Implement model size fits in 2x A100 80GB filter",
      "status": "completed",
      "activeForm": "Implementing model size filter"
    },
    {
      "content": "Implement vLLM architecture support filter",
      "status": "completed",
      "activeForm": "Implementing vLLM architecture filter"
    },
    {
      "content": "Implement tool calling capability filter with parser detection",
      "status": "completed",
      "activeForm": "Implementing tool calling filter"
    },
    {
      "content": "Implement known-failure skip list",
      "status": "completed",
      "activeForm": "Implementing known-failure skip list"
    },
    {
      "content": "Add types and interfaces for filter results",
      "status": "completed",
      "activeForm": "Adding types and interfaces"
    },
    {
      "content": "Export new module from index.ts",
      "status": "completed",
      "activeForm": "Exporting from index.ts"
    },
    {
      "content": "Write comprehensive unit tests",
      "status": "in_progress",
      "activeForm": "Writing unit tests"
    },
    {
      "content": "Verify with Playwright",
      "status": "pending",
      "activeForm": "Verifying with Playwright"
    }
  ]
}

🔧 Tool: Write
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/tests/unit/model-candidate-filter.test.ts",
  "content": "import { describe, it, expect } from 'vitest';\nimport { ModelCandidateFilter } from '../../src/services/model-candidate-filter.js';\nimport type { ModelInfo } from '../../src/types/benchmark.js';\n\n// ─── Test Helpers ─────────────────────────────────────────────────────────────\n\n/**\n * Creates a valid model candidate that passes all default filters.\n * Override individual fields to test specific filter criteria.\n */\nfunction createModelCandidate(overrides: Partial<ModelInfo> = {}): ModelInfo {\n  return {\n    id: 'test-org/test-model-instruct',\n    name: 'test-model-instruct',\n    architecture: 'llama',\n    contextWindow: 131072,\n    license: 'apache-2.0',\n    parameterCount: 70_000_000_000,\n    quantizations: ['fp16'],\n    supportsToolCalling: true,\n    ...overrides,\n  };\n}\n\n// ─── Tests ────────────────────────────────────────────────────────────────────\n\ndescribe('ModelCandidateFilter', () => {\n  describe('constructor', () => {\n    it('should initialize with default options', () => {\n      const filter = new ModelCandidateFilter('error');\n      expect(filter).toBeDefined();\n      expect(filter.getTotalVramGb()).toBe(160); // 2x A100 80GB default\n    });\n\n    it('should accept custom options', () => {\n      const filter = new ModelCandidateFilter('error', {\n        minContextWindow: 64000,\n        targetHardwareProfile: {\n          gpuType: 'nvidia-a100-80gb',\n          gpuCount: 4,\n          ramGb: 1360,\n          cpuCores: 48,\n          diskGb: 2000,\n          machineType: 'a2-ultragpu-4g',\n        },\n        requireToolCalling: false,\n      });\n      expect(filter.getTotalVramGb()).toBe(320); // 4x A100 80GB\n    });\n  });\n\n  describe('evaluate - passing model', () => {\n    it('should pass a model that meets all criteria', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate();\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(true);\n      expect(result.rejections).toHaveLength(0);\n      expect(result.model).toBe(model);\n    });\n\n    it('should return recommended tool call parser for passing models', () => {\n      const filter = new ModelCandidateFilter('error');\n\n      const llamaModel = createModelCandidate({ architecture: 'llama' });\n      expect(filter.evaluate(llamaModel).recommendedToolCallParser).toBe('llama3_json');\n\n      const qwenModel = createModelCandidate({ architecture: 'qwen2' });\n      expect(filter.evaluate(qwenModel).recommendedToolCallParser).toBe('hermes');\n\n      const mistralModel = createModelCandidate({ architecture: 'mistral' });\n      expect(filter.evaluate(mistralModel).recommendedToolCallParser).toBe('mistral');\n    });\n\n    it('should return estimated VRAM for passing models', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        parameterCount: 70_000_000_000,\n        quantizations: ['fp16'],\n      });\n      const result = filter.evaluate(model);\n\n      // 70B * 2 bytes / (1024^3) * 1.2 overhead ≈ 156.2 GB\n      expect(result.estimatedVramGb).toBeGreaterThan(0);\n      expect(result.estimatedVramGb).not.toBeNull();\n    });\n  });\n\n  describe('context size filter', () => {\n    it('should reject models with context window below 128K', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ contextWindow: 4096 });\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(false);\n      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(true);\n      expect(result.rejections.find((r) => r.criterion === 'context_size')!.isHardRequirement).toBe(\n        true,\n      );\n    });\n\n    it('should accept models with exactly 128K context window', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ contextWindow: 128000 });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(false);\n    });\n\n    it('should accept models with context window above 128K', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ contextWindow: 200000 });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(false);\n    });\n\n    it('should use custom minimum context window when provided', () => {\n      const filter = new ModelCandidateFilter('error', { minContextWindow: 64000 });\n      const model = createModelCandidate({ contextWindow: 65000 });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(false);\n    });\n\n    it('should reject context window of 0', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ contextWindow: 0 });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'context_size')).toBe(true);\n    });\n  });\n\n  describe('model size filter (VRAM fit)', () => {\n    it('should reject models that exceed 2x A100 80GB VRAM (160GB)', () => {\n      const filter = new ModelCandidateFilter('error');\n      // 180B fp16 = ~335GB, way over 160GB\n      const model = createModelCandidate({\n        parameterCount: 180_000_000_000,\n        quantizations: ['fp16'],\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(true);\n    });\n\n    it('should accept models that fit within 2x A100 80GB VRAM', () => {\n      const filter = new ModelCandidateFilter('error');\n      // 7B fp16 = ~13GB, well within 160GB\n      const model = createModelCandidate({\n        parameterCount: 7_000_000_000,\n        quantizations: ['fp16'],\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(false);\n    });\n\n    it('should consider quantization when estimating VRAM', () => {\n      const filter = new ModelCandidateFilter('error');\n      // 70B with int4 quantization: ~70B * 0.5 bytes / (1024^3) * 1.2 ≈ 39GB\n      const model = createModelCandidate({\n        parameterCount: 70_000_000_000,\n        quantizations: ['gptq', 'gptq-4bit'],\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(false);\n      expect(result.estimatedVramGb!).toBeLessThan(50);\n    });\n\n    it('should issue warning (not rejection) when parameter count is unknown', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ parameterCount: null });\n      const result = filter.evaluate(model);\n\n      // Should not be a hard rejection\n      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(false);\n      // Should be a warning\n      expect(result.warnings.some((r) => r.criterion === 'model_size')).toBe(true);\n    });\n\n    it('should use custom target hardware profile for VRAM calculation', () => {\n      const filter = new ModelCandidateFilter('error', {\n        targetHardwareProfile: {\n          gpuType: 'nvidia-l4',\n          gpuCount: 1,\n          ramGb: 64,\n          cpuCores: 8,\n          diskGb: 200,\n          machineType: 'g2-standard-8',\n        },\n      });\n      // 24GB VRAM (1x L4), so 70B fp16 (~156GB) should fail\n      const model = createModelCandidate({\n        parameterCount: 70_000_000_000,\n        quantizations: ['fp16'],\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(true);\n    });\n\n    it('should return null estimated VRAM when parameter count is null', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ parameterCount: null });\n      const result = filter.evaluate(model);\n\n      expect(result.estimatedVramGb).toBeNull();\n    });\n  });\n\n  describe('vLLM architecture filter', () => {\n    const supportedArchitectures = [\n      'llama',\n      'mistral',\n      'mixtral',\n      'qwen',\n      'qwen2',\n      'qwen2_moe',\n      'gemma',\n      'phi',\n      'deepseek',\n      'falcon',\n      'yi',\n      'codellama',\n      'command-r',\n    ];\n\n    for (const arch of supportedArchitectures) {\n      it(`should accept supported vLLM architecture: ${arch}`, () => {\n        const filter = new ModelCandidateFilter('error', { requireToolCalling: false });\n        const model = createModelCandidate({ architecture: arch });\n        const result = filter.evaluate(model);\n\n        expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(false);\n      });\n    }\n\n    it('should reject unsupported architectures', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ architecture: 'vit' });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(true);\n    });\n\n    it('should reject architecture \"unknown\"', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ architecture: 'unknown' });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(true);\n    });\n\n    it('should handle partial architecture matches', () => {\n      const filter = new ModelCandidateFilter('error', { requireToolCalling: false });\n      // \"deepseek_v2\" should match because it contains \"deepseek\"\n      const model = createModelCandidate({ architecture: 'deepseek_v2' });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'vllm_architecture')).toBe(false);\n    });\n  });\n\n  describe('tool calling filter', () => {\n    it('should reject models without tool calling support', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ supportsToolCalling: false });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(true);\n    });\n\n    it('should reject models with tool calling but no known parser', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        architecture: 'falcon',\n        supportsToolCalling: true,\n        id: 'tiiuae/falcon-40b-instruct',\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(true);\n      expect(result.rejections.find((r) => r.criterion === 'tool_calling')!.reason).toContain(\n        'No known vLLM tool call parser',\n      );\n    });\n\n    it('should accept Qwen models with hermes parser', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        architecture: 'qwen2',\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);\n      expect(result.recommendedToolCallParser).toBe('hermes');\n    });\n\n    it('should accept Mistral models with mistral parser', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        architecture: 'mistral',\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);\n      expect(result.recommendedToolCallParser).toBe('mistral');\n    });\n\n    it('should accept Llama models with llama3_json parser', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        architecture: 'llama',\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);\n      expect(result.recommendedToolCallParser).toBe('llama3_json');\n    });\n\n    it('should not reject when requireToolCalling is false', () => {\n      const filter = new ModelCandidateFilter('error', { requireToolCalling: false });\n      const model = createModelCandidate({\n        supportsToolCalling: false,\n        architecture: 'llama',\n      });\n      const result = filter.evaluate(model);\n\n      // Should be a warning, not a rejection\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(false);\n      expect(result.warnings.some((r) => r.criterion === 'tool_calling')).toBe(true);\n    });\n\n    it('should detect parser from model ID when architecture does not match', () => {\n      const filter = new ModelCandidateFilter('error', { requireToolCalling: false });\n\n      // Model ID contains \"qwen\" even though architecture is generic\n      const model = createModelCandidate({\n        id: 'Qwen/Qwen2.5-72B-Instruct',\n        architecture: 'qwen2',\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.recommendedToolCallParser).toBe('hermes');\n    });\n  });\n\n  describe('known failure list', () => {\n    it('should reject models in the exact known failure list', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'tiiuae/falcon-180B',\n        architecture: 'falcon',\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(true);\n      expect(result.rejections.find((r) => r.criterion === 'known_failure')!.reason).toContain(\n        'known failure list',\n      );\n    });\n\n    it('should reject models matching wildcard patterns in failure list', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'stabilityai/stablelm-2-12b-chat',\n        architecture: 'stablelm',\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(true);\n    });\n\n    it('should not reject models not in the known failure list', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'meta-llama/Llama-3.1-70B-Instruct',\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(false);\n    });\n\n    it('should skip known failure check when disabled', () => {\n      const filter = new ModelCandidateFilter('error', { checkKnownFailures: false });\n      const model = createModelCandidate({\n        id: 'tiiuae/falcon-180B',\n        architecture: 'falcon',\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.rejections.some((r) => r.criterion === 'known_failure')).toBe(false);\n    });\n  });\n\n  describe('evaluateBatch', () => {\n    it('should partition models into passed and rejected', () => {\n      const filter = new ModelCandidateFilter('error');\n      const models = [\n        createModelCandidate({ id: 'org/good-model-1' }),\n        createModelCandidate({ id: 'org/small-ctx', contextWindow: 4096 }),\n        createModelCandidate({ id: 'org/good-model-2' }),\n        createModelCandidate({ id: 'org/bad-arch', architecture: 'vit' }),\n      ];\n\n      const result = filter.evaluateBatch(models);\n\n      expect(result.passed).toHaveLength(2);\n      expect(result.rejected).toHaveLength(2);\n      expect(result.totalEvaluated).toBe(4);\n      expect(result.timestamp).toBeTruthy();\n    });\n\n    it('should handle empty batch', () => {\n      const filter = new ModelCandidateFilter('error');\n      const result = filter.evaluateBatch([]);\n\n      expect(result.passed).toHaveLength(0);\n      expect(result.rejected).toHaveLength(0);\n      expect(result.totalEvaluated).toBe(0);\n    });\n\n    it('should handle all models passing', () => {\n      const filter = new ModelCandidateFilter('error');\n      const models = [\n        createModelCandidate({ id: 'org/model-1' }),\n        createModelCandidate({ id: 'org/model-2' }),\n      ];\n\n      const result = filter.evaluateBatch(models);\n\n      expect(result.passed).toHaveLength(2);\n      expect(result.rejected).toHaveLength(0);\n    });\n\n    it('should handle all models rejected', () => {\n      const filter = new ModelCandidateFilter('error');\n      const models = [\n        createModelCandidate({ id: 'org/bad-1', contextWindow: 100 }),\n        createModelCandidate({ id: 'org/bad-2', architecture: 'vit' }),\n      ];\n\n      const result = filter.evaluateBatch(models);\n\n      expect(result.passed).toHaveLength(0);\n      expect(result.rejected).toHaveLength(2);\n    });\n  });\n\n  describe('getRecommendedToolCallParser', () => {\n    it('should return hermes for qwen models', () => {\n      const filter = new ModelCandidateFilter('error');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'qwen' })),\n      ).toBe('hermes');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'qwen2' })),\n      ).toBe('hermes');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'qwen2_moe' })),\n      ).toBe('hermes');\n    });\n\n    it('should return mistral for mistral/mixtral models', () => {\n      const filter = new ModelCandidateFilter('error');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'mistral' })),\n      ).toBe('mistral');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'mixtral' })),\n      ).toBe('mistral');\n    });\n\n    it('should return llama3_json for llama models', () => {\n      const filter = new ModelCandidateFilter('error');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'llama' })),\n      ).toBe('llama3_json');\n      expect(\n        filter.getRecommendedToolCallParser(createModelCandidate({ architecture: 'codellama' })),\n      ).toBe('llama3_json');\n    });\n\n    it('should return null for architectures without known parser', () => {\n      const filter = new ModelCandidateFilter('error');\n      expect(\n        filter.getRecommendedToolCallParser(\n          createModelCandidate({ architecture: 'falcon', id: 'tiiuae/falcon-40b' }),\n        ),\n      ).toBeNull();\n    });\n\n    it('should detect parser from model ID as fallback', () => {\n      const filter = new ModelCandidateFilter('error');\n      // Architecture is gemma (no parser) but model ID has llama in it\n      expect(\n        filter.getRecommendedToolCallParser(\n          createModelCandidate({\n            architecture: 'gemma',\n            id: 'org/llama-derived-model',\n          }),\n        ),\n      ).toBe('llama3_json');\n    });\n  });\n\n  describe('estimateVramUsage', () => {\n    it('should estimate VRAM for fp16 model', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        parameterCount: 7_000_000_000,\n        quantizations: ['fp16'],\n      });\n\n      const vram = filter.estimateVramUsage(model);\n\n      // 7B * 2 bytes / (1024^3) * 1.2 ≈ 15.6 GB\n      expect(vram).not.toBeNull();\n      expect(vram!).toBeGreaterThan(10);\n      expect(vram!).toBeLessThan(25);\n    });\n\n    it('should estimate lower VRAM for quantized models', () => {\n      const filter = new ModelCandidateFilter('error');\n      const fp16Model = createModelCandidate({\n        parameterCount: 70_000_000_000,\n        quantizations: ['fp16'],\n      });\n      const quantModel = createModelCandidate({\n        parameterCount: 70_000_000_000,\n        quantizations: ['gptq', 'gptq-4bit'],\n      });\n\n      const fp16Vram = filter.estimateVramUsage(fp16Model)!;\n      const quantVram = filter.estimateVramUsage(quantModel)!;\n\n      expect(quantVram).toBeLessThan(fp16Vram);\n    });\n\n    it('should return null when parameter count is null', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({ parameterCount: null });\n\n      expect(filter.estimateVramUsage(model)).toBeNull();\n    });\n\n    it('should use best available quantization for estimation', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        parameterCount: 70_000_000_000,\n        quantizations: ['fp16', 'awq', 'gptq-4bit'],\n      });\n\n      const vram = filter.estimateVramUsage(model)!;\n      // Should use gptq-4bit (0.5 bytes/param) for the best estimate\n      // 70B * 0.5 / (1024^3) * 1.2 ≈ 39GB\n      expect(vram).toBeLessThan(50);\n    });\n  });\n\n  describe('getTotalVramGb', () => {\n    it('should return correct VRAM for 2x A100 80GB (default)', () => {\n      const filter = new ModelCandidateFilter('error');\n      expect(filter.getTotalVramGb()).toBe(160);\n    });\n\n    it('should return correct VRAM for custom hardware', () => {\n      const filter = new ModelCandidateFilter('error', {\n        targetHardwareProfile: {\n          gpuType: 'nvidia-l4',\n          gpuCount: 8,\n          ramGb: 384,\n          cpuCores: 96,\n          diskGb: 1000,\n          machineType: 'g2-standard-96',\n        },\n      });\n      expect(filter.getTotalVramGb()).toBe(192); // 8x 24GB\n    });\n\n    it('should return correct VRAM for single GPU', () => {\n      const filter = new ModelCandidateFilter('error', {\n        targetHardwareProfile: {\n          gpuType: 'nvidia-a100-80gb',\n          gpuCount: 1,\n          ramGb: 340,\n          cpuCores: 12,\n          diskGb: 500,\n          machineType: 'a2-highgpu-1g',\n        },\n      });\n      expect(filter.getTotalVramGb()).toBe(80);\n    });\n  });\n\n  describe('multiple rejection reasons', () => {\n    it('should accumulate multiple rejections for a failing model', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        contextWindow: 4096,\n        architecture: 'vit',\n        supportsToolCalling: false,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(false);\n      expect(result.rejections.length).toBeGreaterThanOrEqual(3);\n\n      const criteria = result.rejections.map((r) => r.criterion);\n      expect(criteria).toContain('context_size');\n      expect(criteria).toContain('vllm_architecture');\n      expect(criteria).toContain('tool_calling');\n    });\n\n    it('should list all rejection reasons with details', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        contextWindow: 2048,\n        supportsToolCalling: false,\n      });\n      const result = filter.evaluate(model);\n\n      for (const rejection of result.rejections) {\n        expect(rejection.reason).toBeTruthy();\n        expect(rejection.criterion).toBeTruthy();\n        expect(typeof rejection.isHardRequirement).toBe('boolean');\n      }\n    });\n  });\n\n  describe('realistic model scenarios', () => {\n    it('should accept Llama-3.1-70B-Instruct', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'meta-llama/Llama-3.1-70B-Instruct',\n        name: 'Llama-3.1-70B-Instruct',\n        architecture: 'llama',\n        contextWindow: 131072,\n        license: 'llama3.1',\n        parameterCount: 70_000_000_000,\n        quantizations: ['fp16', 'gptq-4bit', 'awq'],\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(true);\n      expect(result.recommendedToolCallParser).toBe('llama3_json');\n    });\n\n    it('should accept Qwen2.5-72B-Instruct', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'Qwen/Qwen2.5-72B-Instruct',\n        name: 'Qwen2.5-72B-Instruct',\n        architecture: 'qwen2',\n        contextWindow: 131072,\n        license: 'apache-2.0',\n        parameterCount: 72_000_000_000,\n        quantizations: ['fp16', 'gptq', 'awq'],\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(true);\n      expect(result.recommendedToolCallParser).toBe('hermes');\n    });\n\n    it('should accept Mistral-Large-Instruct', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'mistralai/Mistral-Large-Instruct-2407',\n        name: 'Mistral-Large-Instruct-2407',\n        architecture: 'mistral',\n        contextWindow: 131072,\n        license: 'apache-2.0',\n        parameterCount: 123_000_000_000,\n        quantizations: ['fp16', 'gptq-4bit'],\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      // With gptq-4bit: 123B * 0.5 / (1024^3) * 1.2 ≈ 68.8GB, fits in 160GB\n      expect(result.passed).toBe(true);\n      expect(result.recommendedToolCallParser).toBe('mistral');\n    });\n\n    it('should reject a base model (no tool calling)', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'meta-llama/Llama-3.1-70B',\n        name: 'Llama-3.1-70B',\n        architecture: 'llama',\n        contextWindow: 131072,\n        license: 'llama3.1',\n        parameterCount: 70_000_000_000,\n        quantizations: ['fp16'],\n        supportsToolCalling: false,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(false);\n      expect(result.rejections.some((r) => r.criterion === 'tool_calling')).toBe(true);\n    });\n\n    it('should reject a model too large for 2x A100', () => {\n      const filter = new ModelCandidateFilter('error');\n      const model = createModelCandidate({\n        id: 'meta-llama/Llama-3.1-405B-Instruct',\n        name: 'Llama-3.1-405B-Instruct',\n        architecture: 'llama',\n        contextWindow: 131072,\n        license: 'llama3.1',\n        parameterCount: 405_000_000_000,\n        quantizations: ['fp16'],\n        supportsToolCalling: true,\n      });\n      const result = filter.evaluate(model);\n\n      expect(result.passed).toBe(false);\n      expect(result.rejections.some((r) => r.criterion === 'model_size')).toBe(true);\n    });\n  });\n});\n"
}
Now let me run the tests to make sure everything passes:

🔧 Tool: Bash
Input: {
  "command": "npx vitest run tests/unit/model-candidate-filter.test.ts 2>&1",
  "description": "Run unit tests for model candidate filter",
  "timeout": 60000
}
All 66 tests pass. Let me also run the typecheck and the full test suite to make sure nothing is broken:

🔧 Tool: Bash
Input: {
  "command": "npx tsc --noEmit 2>&1",
  "description": "Run TypeScript type checking",
  "timeout": 60000
}

🔧 Tool: Bash
Input: {
  "command": "npx vitest run 2>&1",
  "description": "Run all unit tests",
  "timeout": 120000
}
All 293 tests pass across all 9 test files, and TypeScript type checking passes with no errors. Now let me set up Playwright verification:

🔧 Tool: TodoWrite
Input: {
  "todos": [
    {
      "content": "Create ModelCandidateFilter service with pre-deployment filtering logic",
      "status": "completed",
      "activeForm": "Creating ModelCandidateFilter service"
    },
    {
      "content": "Implement context size >= 128K hard requirement filter",
      "status": "completed",
      "activeForm": "Implementing context size filter"
    },
    {
      "content": "Implement model size fits in 2x A100 80GB filter",
      "status": "completed",
      "activeForm": "Implementing model size filter"
    },
    {
      "content": "Implement vLLM architecture support filter",
      "status": "completed",
      "activeForm": "Implementing vLLM architecture filter"
    },
    {
      "content": "Implement tool calling capability filter with parser detection",
      "status": "completed",
      "activeForm": "Implementing tool calling filter"
    },
    {
      "content": "Implement known-failure skip list",
      "status": "completed",
      "activeForm": "Implementing known-failure skip list"
    },
    {
      "content": "Add types and interfaces for filter results",
      "status": "completed",
      "activeForm": "Adding types and interfaces"
    },
    {
      "content": "Export new module from index.ts",
      "status": "completed",
      "activeForm": "Exporting from index.ts"
    },
    {
      "content": "Write comprehensive unit tests",
      "status": "completed",
      "activeForm": "Writing unit tests"
    },
    {
      "content": "Verify with Playwright",
      "status": "in_progress",
      "activeForm": "Verifying with Playwright"
    }
  ]
}

🔧 Tool: Bash
Input: {
  "command": "ls /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/node_modules/@playwright 2>/dev/null && echo \"Playwright installed\" || echo \"Playwright not installed\"",
  "description": "Check if Playwright is installed"
}

🔧 Tool: Glob
Input: {
  "pattern": "**/playwright.config*",
  "path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker"
}
Playwright is installed but there's no config. Since the project doesn't have a dashboard running for end-to-end API testing, and this feature is a pure service-layer module (no API endpoints), I'll create a Playwright test that verifies the module can be imported and the filter logic works correctly via a Node.js test:

🔧 Tool: Write
Input: {
  "file_path": "/Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/playwright-verification-filter.test.ts",
  "content": "/**\n * Playwright verification test for the ModelCandidateFilter feature.\n *\n * Since this feature is a service-layer module (no API endpoints),\n * this test verifies the module can be imported and the core filtering\n * logic works correctly.\n */\nimport { test, expect } from '@playwright/test';\n\ntest.describe('ModelCandidateFilter - Playwright Verification', () => {\n  test('module can be dynamically imported and filter evaluates correctly', async () => {\n    // Dynamically import the built module\n    const { ModelCandidateFilter } = await import('./src/services/model-candidate-filter.js');\n\n    const filter = new ModelCandidateFilter('error');\n\n    // Test: passing model (Llama 3.1 70B Instruct)\n    const passingResult = filter.evaluate({\n      id: 'meta-llama/Llama-3.1-70B-Instruct',\n      name: 'Llama-3.1-70B-Instruct',\n      architecture: 'llama',\n      contextWindow: 131072,\n      license: 'llama3.1',\n      parameterCount: 70_000_000_000,\n      quantizations: ['fp16', 'gptq-4bit'],\n      supportsToolCalling: true,\n    });\n\n    expect(passingResult.passed).toBe(true);\n    expect(passingResult.rejections).toHaveLength(0);\n    expect(passingResult.recommendedToolCallParser).toBe('llama3_json');\n    expect(passingResult.estimatedVramGb).toBeGreaterThan(0);\n\n    // Test: rejected model (small context window)\n    const smallContextResult = filter.evaluate({\n      id: 'org/small-model',\n      name: 'small-model',\n      architecture: 'llama',\n      contextWindow: 4096,\n      license: 'apache-2.0',\n      parameterCount: 7_000_000_000,\n      quantizations: ['fp16'],\n      supportsToolCalling: true,\n    });\n\n    expect(smallContextResult.passed).toBe(false);\n    expect(smallContextResult.rejections.some((r) => r.criterion === 'context_size')).toBe(true);\n\n    // Test: rejected model (too large for 2x A100 80GB)\n    const tooLargeResult = filter.evaluate({\n      id: 'org/huge-model-instruct',\n      name: 'huge-model-instruct',\n      architecture: 'llama',\n      contextWindow: 131072,\n      license: 'apache-2.0',\n      parameterCount: 405_000_000_000,\n      quantizations: ['fp16'],\n      supportsToolCalling: true,\n    });\n\n    expect(tooLargeResult.passed).toBe(false);\n    expect(tooLargeResult.rejections.some((r) => r.criterion === 'model_size')).toBe(true);\n\n    // Test: batch evaluation\n    const batchResult = filter.evaluateBatch([\n      {\n        id: 'Qwen/Qwen2.5-72B-Instruct',\n        name: 'Qwen2.5-72B-Instruct',\n        architecture: 'qwen2',\n        contextWindow: 131072,\n        license: 'apache-2.0',\n        parameterCount: 72_000_000_000,\n        quantizations: ['fp16', 'awq'],\n        supportsToolCalling: true,\n      },\n      {\n        id: 'org/unsupported-arch',\n        name: 'unsupported-arch',\n        architecture: 'vit',\n        contextWindow: 131072,\n        license: 'apache-2.0',\n        parameterCount: 7_000_000_000,\n        quantizations: ['fp16'],\n        supportsToolCalling: false,\n      },\n    ]);\n\n    expect(batchResult.totalEvaluated).toBe(2);\n    expect(batchResult.passed).toHaveLength(1);\n    expect(batchResult.rejected).toHaveLength(1);\n    expect(batchResult.passed[0].recommendedToolCallParser).toBe('hermes');\n  });\n\n  test('filter correctly assigns tool call parsers for all supported families', async () => {\n    const { ModelCandidateFilter } = await import('./src/services/model-candidate-filter.js');\n    const filter = new ModelCandidateFilter('error');\n\n    const families = [\n      { architecture: 'llama', expectedParser: 'llama3_json' },\n      { architecture: 'qwen2', expectedParser: 'hermes' },\n      { architecture: 'mistral', expectedParser: 'mistral' },\n      { architecture: 'mixtral', expectedParser: 'mistral' },\n      { architecture: 'codellama', expectedParser: 'llama3_json' },\n    ];\n\n    for (const { architecture, expectedParser } of families) {\n      const result = filter.evaluate({\n        id: `org/${architecture}-model-instruct`,\n        name: `${architecture}-model-instruct`,\n        architecture,\n        contextWindow: 131072,\n        license: 'apache-2.0',\n        parameterCount: 7_000_000_000,\n        quantizations: ['fp16'],\n        supportsToolCalling: true,\n      });\n\n      expect(result.recommendedToolCallParser).toBe(expectedParser);\n    }\n  });\n\n  test('filter handles known failure list correctly', async () => {\n    const { ModelCandidateFilter } = await import('./src/services/model-candidate-filter.js');\n    const filter = new ModelCandidateFilter('error');\n\n    const knownFailure = filter.evaluate({\n      id: 'tiiuae/falcon-180B',\n      name: 'falcon-180B',\n      architecture: 'falcon',\n      contextWindow: 131072,\n      license: 'apache-2.0',\n      parameterCount: 180_000_000_000,\n      quantizations: ['fp16'],\n      supportsToolCalling: true,\n    });\n\n    expect(knownFailure.passed).toBe(false);\n    expect(knownFailure.rejections.some((r) => r.criterion === 'known_failure')).toBe(true);\n  });\n\n  test('VRAM calculation matches expected values', async () => {\n    const { ModelCandidateFilter } = await import('./src/services/model-candidate-filter.js');\n\n    // Default: 2x A100 80GB = 160GB\n    const defaultFilter = new ModelCandidateFilter('error');\n    expect(defaultFilter.getTotalVramGb()).toBe(160);\n\n    // Custom: 4x A100 80GB = 320GB\n    const customFilter = new ModelCandidateFilter('error', {\n      targetHardwareProfile: {\n        gpuType: 'nvidia-a100-80gb',\n        gpuCount: 4,\n        ramGb: 1360,\n        cpuCores: 48,\n        diskGb: 2000,\n        machineType: 'a2-ultragpu-4g',\n      },\n    });\n    expect(customFilter.getTotalVramGb()).toBe(320);\n  });\n});\n"
}

🔧 Tool: Bash
Input: {
  "command": "npx playwright test playwright-verification-filter.test.ts 2>&1",
  "description": "Run Playwright verification test for model candidate filter",
  "timeout": 120000
}
All 4 Playwright tests pass. Now let me clean up the temporary Playwright test file:

🔧 Tool: Bash
Input: {
  "command": "rm /Users/patrykkopycinski/Projects/automaker/elastic-llm-benchmarker/playwright-verification-filter.test.ts",
  "description": "Delete temporary Playwright verification test"
}

🔧 Tool: TodoWrite
Input: {
  "todos": [
    {
      "content": "Create ModelCandidateFilter service with pre-deployment filtering logic",
      "status": "completed",
      "activeForm": "Creating ModelCandidateFilter service"
    },
    {
      "content": "Implement context size >= 128K hard requirement filter",
      "status": "completed",
      "activeForm": "Implementing context size filter"
    },
    {
      "content": "Implement model size fits in 2x A100 80GB filter",
      "status": "completed",
      "activeForm": "Implementing model size filter"
    },
    {
      "content": "Implement vLLM architecture support filter",
      "status": "completed",
      "activeForm": "Implementing vLLM architecture filter"
    },
    {
      "content": "Implement tool calling capability filter with parser detection",
      "status": "completed",
      "activeForm": "Implementing tool calling filter"
    },
    {
      "content": "Implement known-failure skip list",
      "status": "completed",
      "activeForm": "Implementing known-failure skip list"
    },
    {
      "content": "Add types and interfaces for filter results",
      "status": "completed",
      "activeForm": "Adding types and interfaces"
    },
    {
      "content": "Export new module from index.ts",
      "status": "completed",
      "activeForm": "Exporting from index.ts"
    },
    {
      "content": "Write comprehensive unit tests",
      "status": "completed",
      "activeForm": "Writing unit tests"
    },
    {
      "content": "Verify with Playwright",
      "status": "completed",
      "activeForm": "Verifying with Playwright"
    }
  ]
}
Let me verify the final state of all files one more time:

🔧 Tool: Bash
Input: {
  "command": "npx vitest run 2>&1 && npx tsc --noEmit 2>&1",
  "description": "Final verification: run all tests and typecheck",
  "timeout": 120000
}
All 293 tests pass (including the 66 new ones for the model candidate filter) and TypeScript compiles without errors.

<summary>
## Summary: Model Candidate Pre-Filtering Engine

### Changes Implemented
- Created `ModelCandidateFilter` service class with 5 pre-deployment filter criteria:
  1. **Context Size (hard)**: Rejects models with context window < 128K tokens
  2. **Model Size (hard)**: Estimates VRAM usage and rejects models exceeding 2x A100 80GB (160GB) capacity, accounting for quantization (fp16, gptq-4bit, awq, int8, etc.)
  3. **vLLM Architecture (hard)**: Validates model architecture against comprehensive list of vLLM-supported architectures
  4. **Tool Calling (configurable)**: Checks model family supports tool calling with known vLLM parsers: Qwen→hermes, Mistral/Mixtral→mistral, Llama/CodeLlama→llama3_json
  5. **Known Failure List (hard)**: Auto-skips models known to fail deployment (supports exact match and wildcard prefix patterns)
- Implemented `evaluate()` for single model evaluation returning detailed `FilterResult` with rejections, warnings, recommended parser, and estimated VRAM
- Implemented `evaluateBatch()` for batch evaluation partitioning models into passed/rejected groups
- Implemented `estimateVramUsage()` with quantization-aware VRAM estimation (20% overhead for KV cache/buffers)
- Implemented `getRecommendedToolCallParser()` with architecture-based and model ID-based fallback detection
- Full type definitions: `FilterRejection`, `FilterCriterion`, `FilterResult`, `BatchFilterResult`, `CandidateFilterOptions`
- GPU VRAM lookup table for nvidia-a100-80gb, nvidia-h100, nvidia-l4, nvidia-t4, nvidia-v100, nvidia-a10g
- Exported all new types and classes from the package index

### Files Modified
- `src/services/model-candidate-filter.ts` (NEW) - Core pre-deployment filter service (~400 lines)
- `src/index.ts` - Added exports for `ModelCandidateFilter` and all related types
- `tests/unit/model-candidate-filter.test.ts` (NEW) - 66 comprehensive unit tests covering all filter criteria, edge cases, realistic model scenarios, and batch evaluation

### Notes for Developer
- The filter defaults to 2x A100 80GB (160GB VRAM) as the target hardware, matching the feature spec. This can be overridden via `CandidateFilterOptions.targetHardwareProfile`
- Tool calling is required by default (`requireToolCalling: true`). Set to `false` to make it a warning instead of a hard rejection
- The known failure list can be expanded by modifying the `KNOWN_FAILURE_LIST` map in the service
- Models with unknown parameter counts get a warning (not a hard rejection) for the VRAM fit check
- The service follows existing codebase patterns: Winston logging, JSDoc documentation, readonly data structures

### Verification Status
- **Unit tests**: 66 tests passing (vitest) covering all filter criteria, edge cases, batch evaluation, realistic model scenarios (Llama-3.1-70B, Qwen2.5-72B, Mistral-Large), and parser detection
- **Full test suite**: All 293 tests pass across 9 test files (no regressions)
- **TypeScript**: Clean compile with `tsc --noEmit` (no type errors)
- **Playwright verification**: 4 Playwright tests verified core functionality including: module import, filter evaluation, parser assignment for all families, known failure list, batch evaluation, and VRAM calculations. Test file was deleted after successful verification.
</summary>