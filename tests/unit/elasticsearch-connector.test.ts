import { describe, it, expect, vi } from 'vitest';
import { ElasticsearchConnector } from '../../src/services/elasticsearch-connector.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createMockStore(overrides: Record<string, unknown> = {}): never {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue('result-id'),
    saveRecommendationReport: vi.fn().mockResolvedValue('report-id'),
    saveStage2Result: vi.fn().mockResolvedValue(undefined),
    saveReasoningResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as never;
}

describe('ElasticsearchConnector', () => {
  it('has type "elasticsearch"', () => {
    const connector = new ElasticsearchConnector(createMockStore());
    expect(connector.type).toBe('elasticsearch');
  });

  it('initialize calls ensureIndices', async () => {
    const store = createMockStore();
    const connector = new ElasticsearchConnector(store);
    const result = await connector.initialize();
    expect(result.success).toBe(true);
    expect((store as { initialize: ReturnType<typeof vi.fn> }).initialize).toHaveBeenCalledOnce();
  });

  it('initialize returns error on failure', async () => {
    const store = createMockStore({
      initialize: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    const connector = new ElasticsearchConnector(store);
    const result = await connector.initialize();
    expect(result.success).toBe(false);
    expect(result.error).toContain('connection refused');
  });

  it('saveBenchmarkResult delegates to store.save', async () => {
    const store = createMockStore();
    const connector = new ElasticsearchConnector(store);
    const result = await connector.saveBenchmarkResult({ modelId: 'test' } as never);
    expect(result.success).toBe(true);
    expect((store as { save: ReturnType<typeof vi.fn> }).save).toHaveBeenCalledWith({ modelId: 'test' });
  });

  it('saveRecommendationReport delegates to store', async () => {
    const store = createMockStore();
    const connector = new ElasticsearchConnector(store);
    const report = { reportId: 'rpt-1' } as never;
    const result = await connector.saveRecommendationReport(report);
    expect(result.success).toBe(true);
    expect((store as { saveRecommendationReport: ReturnType<typeof vi.fn> }).saveRecommendationReport).toHaveBeenCalledWith(report);
  });

  it('saveStage2Result delegates to store', async () => {
    const store = createMockStore();
    const connector = new ElasticsearchConnector(store);
    const result = await connector.saveStage2Result({ runId: 'run-1' } as never);
    expect(result.success).toBe(true);
  });

  it('saveStage3Result delegates to store.saveReasoningResult', async () => {
    const store = createMockStore();
    const connector = new ElasticsearchConnector(store);
    const result = await connector.saveStage3Result({ runId: 'run-1' } as never);
    expect(result.success).toBe(true);
    expect((store as { saveReasoningResult: ReturnType<typeof vi.fn> }).saveReasoningResult).toHaveBeenCalledWith({ runId: 'run-1' });
  });

  it('returns error on saveBenchmarkResult failure', async () => {
    const store = createMockStore({
      save: vi.fn().mockRejectedValue(new Error('bulk write failed')),
    });
    const connector = new ElasticsearchConnector(store);
    const result = await connector.saveBenchmarkResult({ modelId: 'test' } as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain('bulk write failed');
  });

  it('close completes without error', async () => {
    const connector = new ElasticsearchConnector(createMockStore());
    await expect(connector.close()).resolves.toBeUndefined();
  });
});
