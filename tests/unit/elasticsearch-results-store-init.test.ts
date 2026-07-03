import { describe, it, expect, vi } from 'vitest';
import { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { Client } from '@elastic/elasticsearch';

/**
 * Builds a mock ES client that records indices.create calls and reports a
 * configurable cluster flavor via info().
 */
function createMockClient(buildFlavor: string): {
  client: Client;
  createCalls: Array<{ index: string; settings?: Record<string, unknown> }>;
} {
  const createCalls: Array<{ index: string; settings?: Record<string, unknown> }> = [];
  const client = {
    info: vi.fn().mockResolvedValue({ version: { build_flavor: buildFlavor } }),
    indices: {
      exists: vi.fn().mockResolvedValue(false),
      create: vi.fn().mockImplementation((args: { index: string; settings?: Record<string, unknown> }) => {
        createCalls.push({ index: args.index, settings: args.settings });
        return Promise.resolve({ acknowledged: true });
      }),
      putIndexTemplate: vi.fn().mockResolvedValue({ acknowledged: true }),
    },
  } as unknown as Client;
  return { client, createCalls };
}

describe('ElasticsearchResultsStore.initialize serverless handling', () => {
  it('omits forbidden index settings on serverless clusters', async () => {
    const { client, createCalls } = createMockClient('serverless');
    const store = new ElasticsearchResultsStore(client, 'error');

    await store.initialize();

    expect(createCalls.length).toBeGreaterThan(0);
    for (const call of createCalls) {
      if (call.settings) {
        expect(call.settings).not.toHaveProperty('number_of_shards');
        expect(call.settings).not.toHaveProperty('number_of_replicas');
        expect(call.settings).not.toHaveProperty('refresh_interval');
      }
    }
  });

  it('keeps shard/replica settings on stateful (default) clusters', async () => {
    const { client, createCalls } = createMockClient('default');
    const store = new ElasticsearchResultsStore(client, 'error');

    await store.initialize();

    const withShardSettings = createCalls.filter(
      (c) => c.settings && 'number_of_shards' in c.settings,
    );
    expect(withShardSettings.length).toBeGreaterThan(0);
  });
});
