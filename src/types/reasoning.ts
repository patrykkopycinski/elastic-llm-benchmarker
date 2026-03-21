/**
 * Reasoning benchmark types for testing model reasoning capabilities.
 * Supports quality/latency trade-off analysis for reasoning-enabled models.
 */

/**
 * A single test case for reasoning evaluation.
 * Tests multi-step logical reasoning capabilities.
 */
export interface ReasoningTestCase {
  /** Input prompt for the reasoning task */
  prompt: string;
  /** Expected correct answer for evaluation */
  expectedAnswer: string;
  /** Category of reasoning task */
  category: 'math' | 'logic' | 'multi_step';
}

/**
 * Results from executing a single reasoning test case.
 * Captures both quality (correctness) and performance metrics.
 */
export interface ReasoningTestResult {
  /** The test case that was executed */
  testCase: ReasoningTestCase;
  /** Whether reasoning was enabled for this test */
  reasoningEnabled: boolean;
  /** Whether the model's answer was correct */
  answerCorrect: boolean;
  /** Time To First Token in milliseconds */
  ttftMs: number;
  /** Inter-Token Latency in milliseconds */
  itlMs: number;
  /** Total tokens used (input + output) */
  totalTokens: number;
  /** Reasoning tokens used (only available when reasoning is enabled) */
  reasoningTokens?: number;
  /** Total latency in milliseconds */
  latencyMs: number;
}

/**
 * Complete benchmark results for reasoning evaluation.
 * Compares performance with and without reasoning enabled.
 */
export interface ReasoningBenchmarkResult {
  /** HuggingFace model ID */
  modelId: string;
  /** Whether the model supports native reasoning */
  reasoningSupported: boolean;
  /** Test results without reasoning enabled */
  resultsWithoutReasoning: ReasoningTestResult[];
  /** Test results with reasoning enabled */
  resultsWithReasoning: ReasoningTestResult[];
  /** Quality improvement percentage (0-100) */
  qualityImprovement: number;
  /** Latency impact metrics */
  latencyImpact: { ttftMs: number; itlMs: number };
  /** Token overhead percentage (0-100) */
  tokenOverhead: number;
  /** Recommendation for reasoning usage */
  recommendation: 'enable' | 'skip';
  /** Explanation for the recommendation */
  reasoning: string;
}

/**
 * Model capability detection results.
 * Describes what features a model supports and how to configure them.
 */
export interface ModelCapabilities {
  /** Tool calling capability information */
  toolCalling: {
    /** Whether tool calling is supported */
    supported: boolean;
    /** Parser to use for tool calls (e.g., 'hermes', 'mistral', 'llama3_json') */
    parser: string | null;
  };
  /** Reasoning capability information */
  reasoning: {
    /** Whether reasoning is supported */
    supported: boolean;
    /** Method used for reasoning */
    method: 'native' | 'prompt-based';
  };
  /** Whether parallel tool calls are supported */
  parallelToolCalls: boolean;
}

/**
 * Enhanced vLLM configuration with auto-detected capabilities.
 * Extends basic vLLM config with model-specific optimizations.
 */
export interface EnhancedVllmConfig {
  /** Tool call parser to use (e.g., 'hermes', 'mistral', 'llama3_json') */
  toolCallParser: string | null;
  /** Chat template override for vLLM */
  chatTemplate: string | null;
  /** Additional vLLM arguments to pass */
  extraArgs: string[];
  /** Model family identifier (e.g., 'llama', 'mistral', 'qwen') */
  family: string;
  /** Unsloth template key for known model families */
  unslothTemplateKey: string | null;
  /** Tensor parallel size for multi-GPU deployment */
  tensorParallelSize: number;
  /** Maximum model length override */
  maxModelLen: number;
  /** Detected model capabilities */
  capabilities: ModelCapabilities;
  /** Reasoning for configuration choices */
  reasoning: string;
  /** Data source used for configuration research */
  dataSource: 'hf_api' | 'fallback';
}
