import { describe, it, expect, vi } from 'vitest';
import { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { Client } from '@elastic/elasticsearch';
import type { Stage2Result } from '../../src/scheduler/pipeline-state.js';

function createMockClient(searchHit: unknown): { client: Client; indexArgs: unknown[] } {
  const indexArgs: unknown[] = [];
  const client = {
    info: vi.fn().mockResolvedValue({ version: { build_flavor: 'default' } }),
    indices: {
      exists: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue({ acknowledged: true }),
      putIndexTemplate: vi.fn().mockResolvedValue({ acknowledged: true }),
    },
    search: vi.fn().mockResolvedValue({
      hits: { hits: searchHit ? [{ _source: searchHit }] : [] },
    }),
    index: vi.fn().mockImplementation((args: unknown) => {
      indexArgs.push(args);
      return Promise.resolve({ result: 'created' });
    }),
  } as unknown as Client;
  return { client, indexArgs };
}

describe('ElasticsearchResultsStore Stage 2 log_path round-trip', () => {
  it('persists log_path per suite result on saveStage2Result', async () => {
    const { client, indexArgs } = createMockClient(null);
    const store = new ElasticsearchResultsStore(client, 'error');
    await store.initialize();

    const result: Stage2Result = {
      runId: 'run-1',
      modelId: 'my-org/my-model',
      status: 'partial',
      scores: { 'agent-builder': 0 },
      suiteResults: [
        {
          suite: 'agent-builder',
          status: 'fail',
          score: 0,
          durationMs: 4200,
          logPath: '/tmp/agent-builder.log',
        },
      ],
      startedAt: '2026-07-20T00:00:00Z',
      completedAt: '2026-07-20T01:00:00Z',
    };

    await store.saveStage2Result(result);

    expect(indexArgs.length).toBe(1);
    const doc = (indexArgs[0] as { document: Record<string, unknown> }).document;
    const suiteResults = doc.suite_results as Array<Record<string, unknown>>;
    expect(suiteResults[0]?.log_path).toBe('/tmp/agent-builder.log');
  });

  it('maps persisted log_path back to logPath on getLatestStage2ForModel', async () => {
    const source = {
      run_id: 'run-1',
      model_id: 'my-org/my-model',
      status: 'partial',
      scores: { 'agent-builder': 0 },
      suite_results: [
        {
          suite: 'agent-builder',
          status: 'fail',
          score: 0,
          duration_ms: 4200,
          log_path: '/tmp/agent-builder.log',
        },
      ],
      started_at: '2026-07-20T00:00:00Z',
      completed_at: '2026-07-20T01:00:00Z',
    };
    const { client } = createMockClient(source);
    const store = new ElasticsearchResultsStore(client, 'error');

    const result = await store.getLatestStage2ForModel('my-org/my-model');

    expect(result?.suiteResults?.[0]?.logPath).toBe('/tmp/agent-builder.log');
  });
});
