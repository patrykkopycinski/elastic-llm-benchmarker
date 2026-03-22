import { describe, it, expect } from 'vitest';
import { ModelEvaluationEngine } from '../../src/services/model-evaluation-engine.js';
import type { BenchmarkResult, ModelInfo, ToolCallResult, BenchmarkMetrics } from '../../src/types/benchmark.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * Creates benchmark metrics at a given concurrency level.
 */
function createBenchmarkMetrics(overrides: Partial<BenchmarkMetrics> = {}): BenchmarkMetrics {
  return {
    itlMs: 15,
    ttftMs: 50,
    throughputTokensPerSec: 100,
    p99LatencyMs: 200,
    concurrencyLevel: 1,
    ...overrides,
  };
}

/**
 * Creates a tool call result that fully passes evaluation.
 */
function createToolCallResult(overrides: Partial<ToolCallResult> = {}): ToolCallResult {
  return {
    supportsParallelCalls: true,
    maxConcurrentCalls: 5,
    avgToolCallLatencyMs: 500,
    successRate: 1.0,
    totalTests: 12,
    ...overrides,
  };
}

/**
 * Creates a complete BenchmarkResult that passes all evaluation criteria.
 */
function createBenchmarkResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    modelId: 'test-org/test-model-instruct',
    timestamp: '2024-01-01T00:00:00.000Z',
    vllmVersion: '0.4.0',
    dockerCommand: 'docker run ...',
    hardwareConfig: {
      gpuType: 'nvidia-a100-80gb',
      gpuCount: 2,
      ramGb: 680,
      cpuCores: 24,
      diskGb: 1000,
      machineType: 'a2-ultragpu-2g',
      hardwareProfileId: null,
    },
    benchmarkMetrics: [createBenchmarkMetrics()],
    toolCallResults: createToolCallResult(),
    passed: true,
    rejectionReasons: [],
    tensorParallelSize: 2,
    toolCallParser: 'llama3_json',
    rawOutput: 'benchmark output...',
    ...overrides,
  };
}

/**
 * Creates a ModelInfo that passes context window requirements.
 */
function createModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'test-org/test-model-instruct',
    name: 'test-model-instruct',
    architecture: 'llama',
    contextWindow: 131072,
    license: 'apache-2.0',
    parameterCount: 70_000_000_000,
    quantizations: ['fp16'],
    supportsToolCalling: true,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ModelEvaluationEngine', () => {
  describe('constructor', () => {
    it('should initialize with default options', () => {
      const engine = new ModelEvaluationEngine('error');
      expect(engine).toBeDefined();
    });

    it('should accept custom options', () => {
      const engine = new ModelEvaluationEngine('error', {
        minContextWindow: 64000,
        minParallelToolCallSuccessRate: 0.9,
        maxITLMs: 30,
        maxToolCallLatencyMs: 2000,
      });
      expect(engine).toBeDefined();
    });
  });

  describe('fromConfig', () => {
    it('should create engine from BenchmarkThresholds config', () => {
      const engine = ModelEvaluationEngine.fromConfig(
        {
          minContextWindow: 128_000,
          maxITLMs: 20,
          maxToolCallLatencyMs: 1000,
          minToolCallSuccessRate: 1.0,
          concurrencyLevels: [1, 4, 16],
          healthCheckTimeoutSeconds: 600,
        },
        'error',
      );
      expect(engine).toBeDefined();
    });
  });

  describe('APPROVED classification', () => {
    it('should classify a model that meets ALL criteria as APPROVED', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('APPROVED');
      expect(report.failedCriteria).toHaveLength(0);
      expect(report.passedCount).toBe(4);
      expect(report.totalCount).toBe(4);
      expect(report.modelId).toBe('test-org/test-model-instruct');
    });

    it('should include all 4 criteria in report', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      const criteria = report.criteriaResults.map((c) => c.criterion);
      expect(criteria).toContain('context_window');
      expect(criteria).toContain('parallel_tool_calling');
      expect(criteria).toContain('itl_latency');
      expect(criteria).toContain('tool_call_latency');
    });

    it('should APPROVE model with exactly 128K context window', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo({ contextWindow: 128_000 });

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('APPROVED');
    });

    it('should APPROVE model with very large context window', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo({ contextWindow: 1_000_000 });

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('APPROVED');
    });

    it('should APPROVE model with ITL well below threshold', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 5 })],
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('APPROVED');
    });

    it('should APPROVE model with tool call latency well below threshold', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({ avgToolCallLatencyMs: 100 }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('APPROVED');
    });
  });

  describe('CONDITIONAL classification', () => {
    it('should classify as CONDITIONAL when ITL exceeds preferred threshold', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 25 })],
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('CONDITIONAL');
      expect(report.failedCriteria).toHaveLength(1);
      expect(report.failedCriteria[0]!.criterion).toBe('itl_latency');
      expect(report.failedCriteria[0]!.severity).toBe('PREFERRED');
    });

    it('should classify as CONDITIONAL when tool call latency exceeds preferred threshold', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({ avgToolCallLatencyMs: 1500 }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('CONDITIONAL');
      expect(report.failedCriteria).toHaveLength(1);
      expect(report.failedCriteria[0]!.criterion).toBe('tool_call_latency');
      expect(report.failedCriteria[0]!.severity).toBe('PREFERRED');
    });

    it('should classify as CONDITIONAL when both preferred criteria fail', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 30 })],
        toolCallResults: createToolCallResult({ avgToolCallLatencyMs: 2000 }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('CONDITIONAL');
      expect(report.failedCriteria).toHaveLength(2);
      expect(report.passedCount).toBe(2);
    });

    it('should use ITL at the lowest concurrency for evaluation', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        benchmarkMetrics: [
          createBenchmarkMetrics({ itlMs: 50, concurrencyLevel: 16 }),
          createBenchmarkMetrics({ itlMs: 15, concurrencyLevel: 1 }),
          createBenchmarkMetrics({ itlMs: 30, concurrencyLevel: 4 }),
        ],
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      // Should use concurrency 1 (itlMs = 15, which passes)
      expect(report.classification).toBe('APPROVED');
      const itlCriterion = report.criteriaResults.find((c) => c.criterion === 'itl_latency');
      expect(itlCriterion!.passed).toBe(true);
      expect(itlCriterion!.actualValue).toContain('15.00ms');
    });
  });

  describe('REJECTED classification', () => {
    it('should REJECT when context window is below 128K', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo({ contextWindow: 4096 });

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
      expect(report.failedCriteria.some((c) => c.criterion === 'context_window')).toBe(true);
      expect(
        report.failedCriteria.find((c) => c.criterion === 'context_window')!.severity,
      ).toBe('HARD');
    });

    it('should REJECT when parallel tool calling is not supported', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({
          supportsParallelCalls: false,
          successRate: 0.5,
        }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
      expect(
        report.failedCriteria.some((c) => c.criterion === 'parallel_tool_calling'),
      ).toBe(true);
    });

    it('should REJECT when tool call success rate is below 100%', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({
          supportsParallelCalls: true,
          successRate: 0.95,
        }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
      expect(
        report.failedCriteria.some((c) => c.criterion === 'parallel_tool_calling'),
      ).toBe(true);
    });

    it('should REJECT when no tool call data is available', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: null,
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
    });

    it('should REJECT when no model info is provided (context window unknown)', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();

      const report = engine.evaluate(result, null);

      expect(report.classification).toBe('REJECTED');
      const ctxCriterion = report.failedCriteria.find(
        (c) => c.criterion === 'context_window',
      );
      expect(ctxCriterion).toBeDefined();
      expect(ctxCriterion!.actualValue).toBe('unknown');
    });

    it('should REJECT with multiple hard failures', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({
          supportsParallelCalls: false,
          successRate: 0.5,
        }),
      });
      const modelInfo = createModelInfo({ contextWindow: 4096 });

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
      const hardFailures = report.failedCriteria.filter((c) => c.severity === 'HARD');
      expect(hardFailures.length).toBeGreaterThanOrEqual(2);
    });

    it('should REJECT even when preferred criteria pass but hard criteria fail', () => {
      const engine = new ModelEvaluationEngine('error');
      // Excellent latency but bad tool calling
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 5 })],
        toolCallResults: createToolCallResult({
          supportsParallelCalls: false,
          avgToolCallLatencyMs: 200,
        }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
    });
  });

  describe('edge cases', () => {
    it('should handle empty benchmark metrics array', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({ benchmarkMetrics: [] });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      // ITL criterion should fail (no data) but it's PREFERRED, so not REJECTED
      const itlCriterion = report.criteriaResults.find((c) => c.criterion === 'itl_latency');
      expect(itlCriterion!.passed).toBe(false);
      expect(itlCriterion!.actualValue).toBe('no benchmark data');
    });

    it('should handle context window of exactly 0', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo({ contextWindow: 0 });

      const report = engine.evaluate(result, modelInfo);

      expect(report.classification).toBe('REJECTED');
    });

    it('should handle ITL at exactly the threshold', () => {
      const engine = new ModelEvaluationEngine('error');
      // ITL = 20ms, threshold is < 20ms, so this should FAIL
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 20 })],
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      const itlCriterion = report.criteriaResults.find((c) => c.criterion === 'itl_latency');
      expect(itlCriterion!.passed).toBe(false);
      expect(report.classification).toBe('CONDITIONAL');
    });

    it('should handle tool call latency at exactly the threshold', () => {
      const engine = new ModelEvaluationEngine('error');
      // Latency = 1000ms, threshold is < 1000ms, so this should FAIL
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({ avgToolCallLatencyMs: 1000 }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      const latencyCriterion = report.criteriaResults.find(
        (c) => c.criterion === 'tool_call_latency',
      );
      expect(latencyCriterion!.passed).toBe(false);
      expect(report.classification).toBe('CONDITIONAL');
    });

    it('should use custom thresholds when provided', () => {
      const engine = new ModelEvaluationEngine('error', {
        minContextWindow: 64_000,
        maxITLMs: 50,
        maxToolCallLatencyMs: 5000,
        minParallelToolCallSuccessRate: 0.9,
      });

      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 40 })],
        toolCallResults: createToolCallResult({
          avgToolCallLatencyMs: 3000,
          successRate: 0.95,
        }),
      });
      const modelInfo = createModelInfo({ contextWindow: 65_000 });

      const report = engine.evaluate(result, modelInfo);

      // All custom thresholds should be met
      expect(report.classification).toBe('APPROVED');
    });

    it('should handle success rate of exactly 1.0', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({ successRate: 1.0 }),
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      const toolCriterion = report.criteriaResults.find(
        (c) => c.criterion === 'parallel_tool_calling',
      );
      expect(toolCriterion!.passed).toBe(true);
    });
  });

  describe('evaluateBatch', () => {
    it('should evaluate multiple benchmark results', () => {
      const engine = new ModelEvaluationEngine('error');

      const results = [
        createBenchmarkResult({ modelId: 'org/model-approved' }),
        createBenchmarkResult({
          modelId: 'org/model-conditional',
          benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 30 })],
        }),
        createBenchmarkResult({
          modelId: 'org/model-rejected',
          toolCallResults: createToolCallResult({ supportsParallelCalls: false }),
        }),
      ];

      const modelInfoMap = new Map<string, ModelInfo>();
      modelInfoMap.set('org/model-approved', createModelInfo({ id: 'org/model-approved' }));
      modelInfoMap.set(
        'org/model-conditional',
        createModelInfo({ id: 'org/model-conditional' }),
      );
      modelInfoMap.set(
        'org/model-rejected',
        createModelInfo({ id: 'org/model-rejected' }),
      );

      const reports = engine.evaluateBatch(results, modelInfoMap);

      expect(reports).toHaveLength(3);
      expect(reports[0]!.classification).toBe('APPROVED');
      expect(reports[1]!.classification).toBe('CONDITIONAL');
      expect(reports[2]!.classification).toBe('REJECTED');
    });

    it('should handle empty batch', () => {
      const engine = new ModelEvaluationEngine('error');
      const reports = engine.evaluateBatch([]);
      expect(reports).toHaveLength(0);
    });

    it('should work without modelInfoMap', () => {
      const engine = new ModelEvaluationEngine('error');
      const results = [createBenchmarkResult()];

      // Without modelInfo, context window will be unknown → REJECTED
      const reports = engine.evaluateBatch(results);
      expect(reports).toHaveLength(1);
      expect(reports[0]!.classification).toBe('REJECTED');
    });
  });

  describe('formatReport', () => {
    it('should produce formatted text for APPROVED model', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);
      const formatted = engine.formatReport(report);

      expect(formatted).toContain('MODEL EVALUATION REPORT');
      expect(formatted).toContain('APPROVED');
      expect(formatted).toContain('test-org/test-model-instruct');
      expect(formatted).toContain('4/4 criteria passed');
      expect(formatted).toContain('✓ PASS');
      expect(formatted).not.toContain('FAILED CRITERIA');
    });

    it('should produce formatted text for CONDITIONAL model', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 25 })],
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);
      const formatted = engine.formatReport(report);

      expect(formatted).toContain('CONDITIONAL');
      expect(formatted).toContain('✗ FAIL');
      expect(formatted).toContain('[PREF]');
      expect(formatted).toContain('FAILED CRITERIA');
    });

    it('should produce formatted text for REJECTED model', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        toolCallResults: createToolCallResult({ supportsParallelCalls: false }),
      });
      const modelInfo = createModelInfo({ contextWindow: 4096 });

      const report = engine.evaluate(result, modelInfo);
      const formatted = engine.formatReport(report);

      expect(formatted).toContain('REJECTED');
      expect(formatted).toContain('[HARD]');
      expect(formatted).toContain('FAILED CRITERIA');
    });

    it('should include severity tags for all criteria', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);
      const formatted = engine.formatReport(report);

      // 2 hard criteria + 2 preferred criteria
      const hardCount = (formatted.match(/\[HARD\]/g) || []).length;
      const prefCount = (formatted.match(/\[PREF\]/g) || []).length;
      expect(hardCount).toBe(2);
      expect(prefCount).toBe(2);
    });
  });

  describe('summary generation', () => {
    it('should generate correct APPROVED summary', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.summary).toContain('APPROVED');
      expect(report.summary).toContain('All 4 evaluation criteria met');
    });

    it('should generate correct CONDITIONAL summary with limitation details', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult({
        benchmarkMetrics: [createBenchmarkMetrics({ itlMs: 25 })],
      });
      const modelInfo = createModelInfo();

      const report = engine.evaluate(result, modelInfo);

      expect(report.summary).toContain('CONDITIONALLY APPROVED');
      expect(report.summary).toContain('itl_latency');
    });

    it('should generate correct REJECTED summary with failure reasons', () => {
      const engine = new ModelEvaluationEngine('error');
      const result = createBenchmarkResult();
      const modelInfo = createModelInfo({ contextWindow: 4096 });

      const report = engine.evaluate(result, modelInfo);

      expect(report.summary).toContain('REJECTED');
      expect(report.summary).toContain('context_window');
    });
  });

  describe('realistic model scenarios', () => {
    it('should APPROVE Llama-3.1-70B-Instruct with good benchmarks', () => {
      const engine = new ModelEvaluationEngine('error');

      const result = createBenchmarkResult({
        modelId: 'meta-llama/Llama-3.1-70B-Instruct',
        benchmarkMetrics: [
          createBenchmarkMetrics({ itlMs: 12, concurrencyLevel: 1 }),
          createBenchmarkMetrics({ itlMs: 18, concurrencyLevel: 4 }),
          createBenchmarkMetrics({ itlMs: 35, concurrencyLevel: 16 }),
        ],
        toolCallResults: createToolCallResult({
          avgToolCallLatencyMs: 450,
          successRate: 1.0,
        }),
      });

      const modelInfo = createModelInfo({
        id: 'meta-llama/Llama-3.1-70B-Instruct',
        contextWindow: 131_072,
      });

      const report = engine.evaluate(result, modelInfo);
      expect(report.classification).toBe('APPROVED');
    });

    it('should classify slow but functional model as CONDITIONAL', () => {
      const engine = new ModelEvaluationEngine('error');

      const result = createBenchmarkResult({
        modelId: 'org/slow-but-accurate-model',
        benchmarkMetrics: [
          createBenchmarkMetrics({ itlMs: 28, concurrencyLevel: 1 }),
        ],
        toolCallResults: createToolCallResult({
          avgToolCallLatencyMs: 1200,
          successRate: 1.0,
        }),
      });

      const modelInfo = createModelInfo({
        id: 'org/slow-but-accurate-model',
        contextWindow: 131_072,
      });

      const report = engine.evaluate(result, modelInfo);
      expect(report.classification).toBe('CONDITIONAL');
      expect(report.failedCriteria).toHaveLength(2);
    });

    it('should REJECT model with broken tool calling', () => {
      const engine = new ModelEvaluationEngine('error');

      const result = createBenchmarkResult({
        modelId: 'org/broken-tools-model',
        benchmarkMetrics: [
          createBenchmarkMetrics({ itlMs: 10, concurrencyLevel: 1 }),
        ],
        toolCallResults: createToolCallResult({
          supportsParallelCalls: true,
          successRate: 0.75,
          avgToolCallLatencyMs: 300,
        }),
      });

      const modelInfo = createModelInfo({
        id: 'org/broken-tools-model',
        contextWindow: 131_072,
      });

      const report = engine.evaluate(result, modelInfo);
      expect(report.classification).toBe('REJECTED');
    });
  });
});
