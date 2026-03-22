import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  KibanaEvalStore,
} from '../../src/services/kibana-eval-store.js';
import type {
  KibanaEvalReport,
  KibanaEvalRunnerConfig,
} from '../../src/types/kibana-eval.js';
import { DEFAULT_KIBANA_EVAL_CONFIG } from '../../src/types/kibana-eval.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createMockEvalReport(
  overrides: Partial<KibanaEvalReport> = {},
): KibanaEvalReport {
  return {
    modelId: 'test-org/test-model',
    connectorId: 'test-connector-id',
    timestamp: new Date().toISOString(),
    classification: 'PASS',
    summary: 'Test evaluation passed',
    scoring: {
      totalScore: 6,
      maxScore: 6,
      totalWeightedScore: 4.0,
      maxWeightedScore: 4.0,
      percentageScore: 100,
      passedCount: 6,
      failedCount: 0,
      skippedCount: 0,
      erroredCount: 0,
      totalCount: 6,
    },
    taskResults: [
      {
        task: {
          id: 'connector_health_check',
          name: 'Connector Health Check',
          description: 'Test',
          category: 'connector_health',
          severity: 'CRITICAL',
          timeoutMs: 30_000,
          retryAttempts: 2,
        },
        outcome: 'PASS',
        durationMs: 150,
        message: 'Health check passed',
        error: null,
        score: 1.0,
        weightedScore: 1.0,
        attempts: 1,
        metadata: { status: 'ok' },
      },
      {
        task: {
          id: 'chat_completion_basic',
          name: 'Basic Chat Completion',
          description: 'Test',
          category: 'chat_completion',
          severity: 'CRITICAL',
          timeoutMs: 30_000,
          retryAttempts: 1,
        },
        outcome: 'PASS',
        durationMs: 200,
        message: 'Chat completion passed',
        error: null,
        score: 1.0,
        weightedScore: 1.0,
        attempts: 1,
        metadata: { contentLength: 5 },
      },
    ],
    failedTasks: [],
    totalDurationMs: 1500,
    evalConfig: DEFAULT_KIBANA_EVAL_CONFIG,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KibanaEvalStore', () => {
  let store: KibanaEvalStore;

  beforeEach(() => {
    store = new KibanaEvalStore(':memory:', 'error');
  });

  afterEach(() => {
    store.close();
  });

  describe('saveReport', () => {
    it('saves a report and returns an ID', () => {
      const report = createMockEvalReport();
      const id = store.saveReport(report);
      expect(id).toBeGreaterThan(0);
    });

    it('saves multiple reports', () => {
      const report1 = createMockEvalReport({
        timestamp: '2024-01-01T00:00:00Z',
      });
      const report2 = createMockEvalReport({
        timestamp: '2024-01-02T00:00:00Z',
      });

      const id1 = store.saveReport(report1);
      const id2 = store.saveReport(report2);

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);
    });

    it('stores task results with the report', () => {
      const report = createMockEvalReport();
      const id = store.saveReport(report);

      const retrieved = store.getById(id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.taskResults.length).toBe(2);
      expect(retrieved!.taskResults[0]!.task.id).toBe('connector_health_check');
      expect(retrieved!.taskResults[1]!.task.id).toBe('chat_completion_basic');
    });
  });

  describe('getById', () => {
    it('retrieves a report by ID', () => {
      const report = createMockEvalReport();
      const id = store.saveReport(report);

      const retrieved = store.getById(id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.modelId).toBe('test-org/test-model');
      expect(retrieved!.connectorId).toBe('test-connector-id');
      expect(retrieved!.classification).toBe('PASS');
      expect(retrieved!.scoring.percentageScore).toBe(100);
    });

    it('returns null for non-existent ID', () => {
      const retrieved = store.getById(999);
      expect(retrieved).toBeNull();
    });

    it('preserves scoring data', () => {
      const report = createMockEvalReport({
        scoring: {
          totalScore: 4,
          maxScore: 6,
          totalWeightedScore: 2.7,
          maxWeightedScore: 4.0,
          percentageScore: 67.5,
          passedCount: 4,
          failedCount: 2,
          skippedCount: 0,
          erroredCount: 0,
          totalCount: 6,
        },
      });
      const id = store.saveReport(report);

      const retrieved = store.getById(id);
      expect(retrieved!.scoring.totalScore).toBe(4);
      expect(retrieved!.scoring.maxScore).toBe(6);
      expect(retrieved!.scoring.totalWeightedScore).toBeCloseTo(2.7);
      expect(retrieved!.scoring.percentageScore).toBeCloseTo(67.5);
      expect(retrieved!.scoring.passedCount).toBe(4);
      expect(retrieved!.scoring.failedCount).toBe(2);
    });

    it('preserves task result metadata', () => {
      const report = createMockEvalReport();
      const id = store.saveReport(report);

      const retrieved = store.getById(id);
      expect(retrieved!.taskResults[0]!.metadata).toEqual({ status: 'ok' });
    });

    it('correctly identifies failed tasks', () => {
      const report = createMockEvalReport({
        classification: 'FAIL',
        taskResults: [
          {
            task: {
              id: 'connector_health_check',
              name: 'Connector Health Check',
              description: 'Test',
              category: 'connector_health',
              severity: 'CRITICAL',
              timeoutMs: 30_000,
              retryAttempts: 2,
            },
            outcome: 'FAIL',
            durationMs: 150,
            message: 'Health check failed',
            error: 'Connection refused',
            score: 0,
            weightedScore: 0,
            attempts: 3,
            metadata: {},
          },
        ],
        failedTasks: [],
      });

      const id = store.saveReport(report);
      const retrieved = store.getById(id);

      expect(retrieved!.failedTasks.length).toBe(1);
      expect(retrieved!.failedTasks[0]!.task.id).toBe('connector_health_check');
      expect(retrieved!.failedTasks[0]!.error).toBe('Connection refused');
    });
  });

  describe('query', () => {
    beforeEach(() => {
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          classification: 'PASS',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-b',
          classification: 'FAIL',
          timestamp: '2024-01-02T00:00:00Z',
        }),
      );
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          classification: 'PARTIAL',
          timestamp: '2024-01-03T00:00:00Z',
          connectorId: 'connector-2',
        }),
      );
    });

    it('returns all reports when no filters', () => {
      const results = store.query();
      expect(results.length).toBe(3);
    });

    it('filters by modelId', () => {
      const results = store.query({ modelId: 'model-a' });
      expect(results.length).toBe(2);
      expect(results.every((r) => r.modelId === 'model-a')).toBe(true);
    });

    it('filters by classification', () => {
      const results = store.query({ classification: 'FAIL' });
      expect(results.length).toBe(1);
      expect(results[0]!.modelId).toBe('model-b');
    });

    it('supports limit and offset', () => {
      const results = store.query({ limit: 1, offset: 1 });
      expect(results.length).toBe(1);
    });

    it('supports ascending order', () => {
      const results = store.query({ orderBy: 'asc' });
      expect(results[0]!.timestamp).toBe('2024-01-01T00:00:00Z');
    });

    it('defaults to descending order', () => {
      const results = store.query();
      expect(results[0]!.timestamp).toBe('2024-01-03T00:00:00Z');
    });

    it('filters by date range', () => {
      const results = store.query({
        after: '2024-01-02T00:00:00Z',
      });
      expect(results.length).toBe(2);
    });
  });

  describe('getLatestForModel', () => {
    it('returns the latest report for a model', () => {
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          timestamp: '2024-01-01T00:00:00Z',
          classification: 'FAIL',
        }),
      );
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          timestamp: '2024-01-02T00:00:00Z',
          classification: 'PASS',
          connectorId: 'connector-2',
        }),
      );

      const latest = store.getLatestForModel('model-a');
      expect(latest).not.toBeNull();
      expect(latest!.classification).toBe('PASS');
      expect(latest!.timestamp).toBe('2024-01-02T00:00:00Z');
    });

    it('returns null for non-existent model', () => {
      const latest = store.getLatestForModel('non-existent');
      expect(latest).toBeNull();
    });
  });

  describe('getModelSummary', () => {
    it('returns summary statistics', () => {
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          timestamp: '2024-01-01T00:00:00Z',
          classification: 'PASS',
          scoring: { ...createMockEvalReport().scoring, percentageScore: 90 },
        }),
      );
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          timestamp: '2024-01-02T00:00:00Z',
          classification: 'FAIL',
          connectorId: 'connector-2',
          scoring: { ...createMockEvalReport().scoring, percentageScore: 50 },
        }),
      );
      store.saveReport(
        createMockEvalReport({
          modelId: 'model-a',
          timestamp: '2024-01-03T00:00:00Z',
          classification: 'PARTIAL',
          connectorId: 'connector-3',
          scoring: { ...createMockEvalReport().scoring, percentageScore: 75 },
        }),
      );

      const summary = store.getModelSummary('model-a');
      expect(summary).not.toBeNull();
      expect(summary!.modelId).toBe('model-a');
      expect(summary!.totalEvals).toBe(3);
      expect(summary!.passCount).toBe(1);
      expect(summary!.partialCount).toBe(1);
      expect(summary!.failCount).toBe(1);
      expect(summary!.lastClassification).toBe('PARTIAL');
      expect(summary!.lastPercentageScore).toBe(75);
      expect(summary!.averagePercentageScore).toBeCloseTo((90 + 50 + 75) / 3, 0);
    });

    it('returns null for non-existent model', () => {
      const summary = store.getModelSummary('non-existent');
      expect(summary).toBeNull();
    });
  });

  describe('linkToBenchmark', () => {
    it('links an eval to a benchmark result', () => {
      const report = createMockEvalReport();
      const evalId = store.saveReport(report);

      // Should not throw
      store.linkToBenchmark(evalId, 42, 'test-org/test-model', 'test-connector-id');
    });

    it('retrieves evals linked to a benchmark', () => {
      const report = createMockEvalReport();
      const evalId = store.saveReport(report);
      store.linkToBenchmark(evalId, 42, 'test-org/test-model', 'test-connector-id');

      const linked = store.getByBenchmarkResultId(42);
      expect(linked.length).toBe(1);
      expect(linked[0]!.modelId).toBe('test-org/test-model');
    });

    it('returns empty array for unlinked benchmark', () => {
      const linked = store.getByBenchmarkResultId(999);
      expect(linked).toEqual([]);
    });
  });

  describe('count', () => {
    it('counts all reports', () => {
      store.saveReport(createMockEvalReport({ timestamp: '2024-01-01T00:00:00Z' }));
      store.saveReport(
        createMockEvalReport({
          timestamp: '2024-01-02T00:00:00Z',
          classification: 'FAIL',
        }),
      );

      expect(store.count()).toBe(2);
    });

    it('counts by classification', () => {
      store.saveReport(
        createMockEvalReport({
          classification: 'PASS',
          timestamp: '2024-01-01T00:00:00Z',
        }),
      );
      store.saveReport(
        createMockEvalReport({
          classification: 'FAIL',
          timestamp: '2024-01-02T00:00:00Z',
        }),
      );

      expect(store.count('PASS')).toBe(1);
      expect(store.count('FAIL')).toBe(1);
      expect(store.count('PARTIAL')).toBe(0);
    });
  });

  describe('delete', () => {
    it('deletes a report', () => {
      const id = store.saveReport(createMockEvalReport());
      expect(store.count()).toBe(1);

      const deleted = store.delete(id);
      expect(deleted).toBe(true);
      expect(store.count()).toBe(0);
    });

    it('returns false for non-existent report', () => {
      const deleted = store.delete(999);
      expect(deleted).toBe(false);
    });

    it('cascades to delete task results', () => {
      const id = store.saveReport(createMockEvalReport());

      // Verify task results exist
      const retrieved = store.getById(id);
      expect(retrieved!.taskResults.length).toBeGreaterThan(0);

      // Delete should cascade
      store.delete(id);
      const afterDelete = store.getById(id);
      expect(afterDelete).toBeNull();
    });
  });
});
