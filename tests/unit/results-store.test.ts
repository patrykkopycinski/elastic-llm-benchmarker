import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResultsStore } from '../../src/services/results-store.js';
import type { BenchmarkResult } from '../../src/types/benchmark.js';

/**
 * Creates a mock BenchmarkResult for testing.
 */
function createMockResult(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    modelId: 'meta-llama/Llama-3-70B',
    timestamp: '2026-02-19T12:00:00Z',
    vllmVersion: '0.4.0',
    dockerCommand:
      'docker run --gpus all -v ~/.cache/huggingface:/root/.cache/huggingface -p 8000:8000 vllm/vllm-openai:v0.4.0 --model meta-llama/Llama-3-70B --tensor-parallel-size 4',
    hardwareConfig: {
      gpuType: 'NVIDIA A100',
      gpuCount: 4,
      ramGb: 320,
      cpuCores: 48,
      diskGb: 1000,
      machineType: 'a2-ultragpu-2g',
      hardwareProfileId: '2xa100-80gb',
    },
    benchmarkMetrics: [
      {
        itlMs: 12.5,
        ttftMs: 150,
        throughputTokensPerSec: 450,
        p99LatencyMs: 25,
        concurrencyLevel: 1,
      },
      {
        itlMs: 15.2,
        ttftMs: 200,
        throughputTokensPerSec: 1200,
        p99LatencyMs: 35,
        concurrencyLevel: 4,
      },
      {
        itlMs: 18.8,
        ttftMs: 350,
        throughputTokensPerSec: 3500,
        p99LatencyMs: 55,
        concurrencyLevel: 16,
      },
    ],
    toolCallResults: {
      supportsParallelCalls: true,
      maxConcurrentCalls: 4,
      avgToolCallLatencyMs: 250,
      successRate: 1.0,
      totalTests: 50,
    },
    passed: true,
    rejectionReasons: [],
    tensorParallelSize: 4,
    toolCallParser: 'hermes',
    rawOutput: 'benchmark output...',
    ...overrides,
  };
}

describe('ResultsStore', () => {
  let store: ResultsStore;

  beforeEach(() => {
    store = new ResultsStore(':memory:', 'error');
  });

  afterEach(() => {
    store.close();
  });

  describe('save and getById', () => {
    it('should save a benchmark result and retrieve it by ID', () => {
      const result = createMockResult();
      const id = store.save(result);

      expect(id).toBe(1);

      const retrieved = store.getById(id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.modelId).toBe('meta-llama/Llama-3-70B');
      expect(retrieved!.vllmVersion).toBe('0.4.0');
      expect(retrieved!.passed).toBe(true);
      expect(retrieved!.rejectionReasons).toEqual([]);
    });

    it('should preserve hardware config', () => {
      const result = createMockResult();
      const id = store.save(result);
      const retrieved = store.getById(id)!;

      expect(retrieved.hardwareConfig).toEqual({
        gpuType: 'NVIDIA A100',
        gpuCount: 4,
        ramGb: 320,
        cpuCores: 48,
        diskGb: 1000,
        machineType: 'a2-ultragpu-2g',
        hardwareProfileId: '2xa100-80gb',
      });
    });

    it('should preserve benchmark metrics at all concurrency levels', () => {
      const result = createMockResult();
      const id = store.save(result);
      const retrieved = store.getById(id)!;

      expect(retrieved.benchmarkMetrics).toHaveLength(3);
      expect(retrieved.benchmarkMetrics[0]!.concurrencyLevel).toBe(1);
      expect(retrieved.benchmarkMetrics[0]!.itlMs).toBe(12.5);
      expect(retrieved.benchmarkMetrics[1]!.concurrencyLevel).toBe(4);
      expect(retrieved.benchmarkMetrics[2]!.concurrencyLevel).toBe(16);
      expect(retrieved.benchmarkMetrics[2]!.throughputTokensPerSec).toBe(3500);
    });

    it('should preserve tool call results', () => {
      const result = createMockResult();
      const id = store.save(result);
      const retrieved = store.getById(id)!;

      expect(retrieved.toolCallResults).not.toBeNull();
      expect(retrieved.toolCallResults!.supportsParallelCalls).toBe(true);
      expect(retrieved.toolCallResults!.maxConcurrentCalls).toBe(4);
      expect(retrieved.toolCallResults!.avgToolCallLatencyMs).toBe(250);
      expect(retrieved.toolCallResults!.successRate).toBe(1.0);
      expect(retrieved.toolCallResults!.totalTests).toBe(50);
    });

    it('should handle null tool call results', () => {
      const result = createMockResult({ toolCallResults: null });
      const id = store.save(result);
      const retrieved = store.getById(id)!;

      expect(retrieved.toolCallResults).toBeNull();
    });

    it('should preserve rejection reasons', () => {
      const result = createMockResult({
        passed: false,
        rejectionReasons: ['ITL exceeds threshold', 'Tool call latency too high'],
      });
      const id = store.save(result);
      const retrieved = store.getById(id)!;

      expect(retrieved.passed).toBe(false);
      expect(retrieved.rejectionReasons).toEqual([
        'ITL exceeds threshold',
        'Tool call latency too high',
      ]);
    });

    it('should return null for non-existent ID', () => {
      const retrieved = store.getById(999);
      expect(retrieved).toBeNull();
    });

    it('should preserve docker command and raw output', () => {
      const result = createMockResult();
      const id = store.save(result);
      const retrieved = store.getById(id)!;

      expect(retrieved.dockerCommand).toBe(result.dockerCommand);
      expect(retrieved.rawOutput).toBe('benchmark output...');
      expect(retrieved.tensorParallelSize).toBe(4);
      expect(retrieved.toolCallParser).toBe('hermes');
    });
  });

  describe('query', () => {
    it('should return all results when no filters specified', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T13:00:00Z' }));

      const results = store.query();
      expect(results).toHaveLength(2);
    });

    it('should filter by modelId', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T13:00:00Z' }));

      const results = store.query({ modelId: 'model-a' });
      expect(results).toHaveLength(1);
      expect(results[0]!.modelId).toBe('model-a');
    });

    it('should filter by vllmVersion', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          vllmVersion: '0.4.0',
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-a',
          vllmVersion: '0.5.0',
          timestamp: '2026-02-19T13:00:00Z',
        }),
      );

      const results = store.query({ vllmVersion: '0.5.0' });
      expect(results).toHaveLength(1);
      expect(results[0]!.vllmVersion).toBe('0.5.0');
    });

    it('should filter by passed status', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          passed: true,
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-b',
          passed: false,
          rejectionReasons: ['Failed'],
          timestamp: '2026-02-19T13:00:00Z',
        }),
      );

      const passed = store.query({ passed: true });
      expect(passed).toHaveLength(1);
      expect(passed[0]!.modelId).toBe('model-a');

      const failed = store.query({ passed: false });
      expect(failed).toHaveLength(1);
      expect(failed[0]!.modelId).toBe('model-b');
    });

    it('should filter by GPU type', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          hardwareConfig: { gpuType: 'NVIDIA A100', gpuCount: 4, ramGb: 320, cpuCores: 48, diskGb: 1000, machineType: 'a2-ultragpu-2g', hardwareProfileId: '2xa100-80gb' },
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-b',
          hardwareConfig: { gpuType: 'NVIDIA H100', gpuCount: 8, ramGb: 640, cpuCores: 96, diskGb: 2000, machineType: 'a3-highgpu-8g', hardwareProfileId: null },
          timestamp: '2026-02-19T13:00:00Z',
        }),
      );

      const results = store.query({ gpuType: 'NVIDIA H100' });
      expect(results).toHaveLength(1);
      expect(results[0]!.hardwareConfig.gpuType).toBe('NVIDIA H100');
    });

    it('should filter by timestamp range', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-18T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-c', timestamp: '2026-02-20T12:00:00Z' }));

      const results = store.query({
        after: '2026-02-19T00:00:00Z',
        before: '2026-02-19T23:59:59Z',
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.modelId).toBe('model-b');
    });

    it('should support limit and offset', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-18T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-c', timestamp: '2026-02-20T12:00:00Z' }));

      const page1 = store.query({ limit: 2, orderBy: 'asc' });
      expect(page1).toHaveLength(2);
      expect(page1[0]!.modelId).toBe('model-a');

      const page2 = store.query({ limit: 2, offset: 2, orderBy: 'asc' });
      expect(page2).toHaveLength(1);
      expect(page2[0]!.modelId).toBe('model-c');
    });

    it('should sort by timestamp descending by default', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-18T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-20T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-c', timestamp: '2026-02-19T12:00:00Z' }));

      const results = store.query();
      expect(results[0]!.modelId).toBe('model-b');
      expect(results[1]!.modelId).toBe('model-c');
      expect(results[2]!.modelId).toBe('model-a');
    });

    it('should support ascending sort', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-18T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-20T12:00:00Z' }));

      const results = store.query({ orderBy: 'asc' });
      expect(results[0]!.modelId).toBe('model-a');
      expect(results[1]!.modelId).toBe('model-b');
    });

    it('should combine multiple filters', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          passed: true,
          vllmVersion: '0.4.0',
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-a',
          passed: false,
          vllmVersion: '0.4.0',
          rejectionReasons: ['Failed'],
          timestamp: '2026-02-19T13:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-b',
          passed: true,
          vllmVersion: '0.5.0',
          timestamp: '2026-02-19T14:00:00Z',
        }),
      );

      const results = store.query({ modelId: 'model-a', passed: true });
      expect(results).toHaveLength(1);
      expect(results[0]!.modelId).toBe('model-a');
      expect(results[0]!.passed).toBe(true);
    });
  });

  describe('hasResult', () => {
    it('should return true when a matching result exists', () => {
      store.save(createMockResult());

      expect(store.hasResult('meta-llama/Llama-3-70B', '0.4.0', 'NVIDIA A100')).toBe(true);
    });

    it('should return false when no matching result exists', () => {
      store.save(createMockResult());

      expect(store.hasResult('meta-llama/Llama-3-70B', '0.5.0', 'NVIDIA A100')).toBe(false);
      expect(store.hasResult('meta-llama/Llama-3-70B', '0.4.0', 'NVIDIA H100')).toBe(false);
      expect(store.hasResult('other-model', '0.4.0', 'NVIDIA A100')).toBe(false);
    });
  });

  describe('getEvaluatedModelIds', () => {
    it('should return empty array when no results', () => {
      const ids = store.getEvaluatedModelIds();
      expect(ids).toEqual([]);
    });

    it('should return unique model IDs sorted alphabetically', () => {
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-19T13:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T14:00:00Z' }));

      const ids = store.getEvaluatedModelIds();
      expect(ids).toEqual(['model-a', 'model-b']);
    });
  });

  describe('getLatestForModel', () => {
    it('should return the latest result for a model', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          vllmVersion: '0.4.0',
          timestamp: '2026-02-18T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-a',
          vllmVersion: '0.5.0',
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );

      const latest = store.getLatestForModel('model-a');
      expect(latest).not.toBeNull();
      expect(latest!.vllmVersion).toBe('0.5.0');
      expect(latest!.timestamp).toBe('2026-02-19T12:00:00Z');
    });

    it('should return null for a model with no results', () => {
      const latest = store.getLatestForModel('nonexistent');
      expect(latest).toBeNull();
    });
  });

  describe('getModelSummary', () => {
    it('should return summary statistics for a model', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          passed: true,
          timestamp: '2026-02-18T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-a',
          passed: false,
          rejectionReasons: ['ITL too high'],
          vllmVersion: '0.5.0',
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );

      const summary = store.getModelSummary('model-a');
      expect(summary).not.toBeNull();
      expect(summary!.modelId).toBe('model-a');
      expect(summary!.totalRuns).toBe(2);
      expect(summary!.passedRuns).toBe(1);
      expect(summary!.failedRuns).toBe(1);
      expect(summary!.lastRunTimestamp).toBe('2026-02-19T12:00:00Z');
      expect(summary!.lastPassed).toBe(false);
      expect(summary!.avgItlMs).toBeTypeOf('number');
      expect(summary!.avgThroughput).toBeTypeOf('number');
      expect(summary!.avgToolCallSuccessRate).toBe(1.0);
    });

    it('should return null for non-existent model', () => {
      const summary = store.getModelSummary('nonexistent');
      expect(summary).toBeNull();
    });

    it('should handle models with no tool call results', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          toolCallResults: null,
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );

      const summary = store.getModelSummary('model-a');
      expect(summary).not.toBeNull();
      expect(summary!.avgToolCallSuccessRate).toBeNull();
    });
  });

  describe('count', () => {
    it('should return 0 when no results', () => {
      expect(store.count()).toBe(0);
    });

    it('should return total count', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T13:00:00Z' }));

      expect(store.count()).toBe(2);
    });

    it('should filter count by passed status', () => {
      store.save(
        createMockResult({
          modelId: 'model-a',
          passed: true,
          timestamp: '2026-02-19T12:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-b',
          passed: false,
          rejectionReasons: ['Failed'],
          timestamp: '2026-02-19T13:00:00Z',
        }),
      );
      store.save(
        createMockResult({
          modelId: 'model-c',
          passed: true,
          timestamp: '2026-02-19T14:00:00Z',
        }),
      );

      expect(store.count(true)).toBe(2);
      expect(store.count(false)).toBe(1);
    });
  });

  describe('delete', () => {
    it('should delete a result and return true', () => {
      const id = store.save(createMockResult());

      expect(store.delete(id)).toBe(true);
      expect(store.getById(id)).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      expect(store.delete(999)).toBe(false);
    });

    it('should cascade delete metrics and tool call results', () => {
      const id = store.save(createMockResult());
      store.delete(id);

      // Verify no orphaned records remain
      expect(store.count()).toBe(0);
      expect(store.getById(id)).toBeNull();
    });
  });

  describe('exportAll and importResults', () => {
    it('should export all results ordered by timestamp ascending', () => {
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-20T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-18T12:00:00Z' }));

      const exported = store.exportAll();
      expect(exported).toHaveLength(2);
      expect(exported[0]!.modelId).toBe('model-a');
      expect(exported[1]!.modelId).toBe('model-b');
    });

    it('should import results into a new store', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ modelId: 'model-b', timestamp: '2026-02-19T13:00:00Z' }));

      const exported = store.exportAll();

      const newStore = new ResultsStore(':memory:', 'error');
      const imported = newStore.importResults(exported);

      expect(imported).toBe(2);
      expect(newStore.count()).toBe(2);

      const retrieved = newStore.getById(1);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.modelId).toBe('model-a');

      newStore.close();
    });

    it('should skip duplicates during import', () => {
      store.save(createMockResult({ modelId: 'model-a', timestamp: '2026-02-19T12:00:00Z' }));

      const exported = store.exportAll();
      const imported = store.importResults(exported);

      expect(imported).toBe(0);
      expect(store.count()).toBe(1);
    });
  });

  describe('unique constraint enforcement', () => {
    it('should reject duplicate model_id + vllm_version + timestamp', () => {
      store.save(createMockResult());

      expect(() => store.save(createMockResult())).toThrow();
    });

    it('should allow same model with different timestamps', () => {
      store.save(createMockResult({ timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ timestamp: '2026-02-19T13:00:00Z' }));

      expect(store.count()).toBe(2);
    });

    it('should allow same model with different vllm versions', () => {
      store.save(createMockResult({ vllmVersion: '0.4.0', timestamp: '2026-02-19T12:00:00Z' }));
      store.save(createMockResult({ vllmVersion: '0.5.0', timestamp: '2026-02-19T12:00:00Z' }));

      expect(store.count()).toBe(2);
    });
  });

  describe('round-trip data integrity', () => {
    it('should perfectly round-trip a complete benchmark result', () => {
      const original = createMockResult();
      const id = store.save(original);
      const retrieved = store.getById(id)!;

      expect(retrieved.modelId).toBe(original.modelId);
      expect(retrieved.timestamp).toBe(original.timestamp);
      expect(retrieved.vllmVersion).toBe(original.vllmVersion);
      expect(retrieved.dockerCommand).toBe(original.dockerCommand);
      expect(retrieved.hardwareConfig).toEqual(original.hardwareConfig);
      expect(retrieved.benchmarkMetrics).toEqual(original.benchmarkMetrics);
      expect(retrieved.toolCallResults).toEqual(original.toolCallResults);
      expect(retrieved.passed).toBe(original.passed);
      expect(retrieved.rejectionReasons).toEqual(original.rejectionReasons);
      expect(retrieved.tensorParallelSize).toBe(original.tensorParallelSize);
      expect(retrieved.toolCallParser).toBe(original.toolCallParser);
      expect(retrieved.rawOutput).toBe(original.rawOutput);
    });

    it('should round-trip a failed result with multiple rejection reasons', () => {
      const original = createMockResult({
        passed: false,
        rejectionReasons: ['ITL exceeds 20ms', 'Tool call success rate below 100%', 'TTFT too high'],
        toolCallResults: {
          supportsParallelCalls: false,
          maxConcurrentCalls: 1,
          avgToolCallLatencyMs: 1500,
          successRate: 0.8,
          totalTests: 100,
        },
      });

      const id = store.save(original);
      const retrieved = store.getById(id)!;

      expect(retrieved.passed).toBe(false);
      expect(retrieved.rejectionReasons).toEqual(original.rejectionReasons);
      expect(retrieved.toolCallResults!.supportsParallelCalls).toBe(false);
      expect(retrieved.toolCallResults!.successRate).toBe(0.8);
    });
  });
});
