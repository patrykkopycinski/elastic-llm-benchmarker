import { describe, it, expect, vi } from 'vitest';
import { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { Client } from '@elastic/elasticsearch';

/**
 * queryModels() powers the dashboard leaderboard. It must derive the distinct
 * benchmarked models from the `benchmarker-results` index (the source of
 * truth) — NOT from the retired `benchmarker-models` catalog, which was never
 * populated and left the leaderboard permanently empty.
 */
function bucket(key: string, source?: Record<string, unknown>): Record<string, unknown> {
  return {
    key,
    doc_count: 1,
    latest: { hits: { hits: source ? [{ _source: source }] : [] } },
  };
}

describe('ElasticsearchResultsStore.queryModels', () => {
  it('aggregates distinct models and surfaces latest metadata', async () => {
    const search = vi.fn().mockResolvedValue({
      aggregations: {
        models: {
          buckets: [
            bucket('Qwen/Qwen3-Coder-30B-A3B-Instruct', {
              model_name: 'Qwen3 Coder 30B A3B Instruct',
              architecture: 'Qwen3MoeForCausalLM',
              parameter_count: 30_000_000_000,
              context_window: 262_144,
              supports_tool_calling: true,
            }),
            // Older result with no persisted metadata → blank columns, name falls back to id.
            bucket('deepreinforce-ai/Ornith-1.0-35B'),
          ],
        },
      },
    });
    const client = { search } as unknown as Client;
    const store = new ElasticsearchResultsStore(client, 'error');

    const models = await store.queryModels();

    // Reads the results index via a terms aggregation + latest top_hits.
    const arg = search.mock.calls[0][0];
    expect(arg.index).toBe('benchmarker-results');
    expect(arg.aggs.models.terms.field).toBe('model_id');
    expect(arg.aggs.models.aggs.latest.top_hits.size).toBe(1);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      modelId: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      name: 'Qwen3 Coder 30B A3B Instruct',
      architecture: 'Qwen3MoeForCausalLM',
      parameterCount: 30_000_000_000,
      contextWindow: 262_144,
      supportsToolCalling: true,
    });
    // No metadata → name falls back to modelId, columns blank.
    expect(models[1]).toMatchObject({
      modelId: 'deepreinforce-ai/Ornith-1.0-35B',
      name: 'deepreinforce-ai/Ornith-1.0-35B',
      architecture: '',
      parameterCount: null,
      supportsToolCalling: false,
    });
  });

  it('filters by architecture against the derived catalog', async () => {
    const search = vi.fn().mockResolvedValue({
      aggregations: {
        models: {
          buckets: [
            bucket('a/x', { architecture: 'LlamaForCausalLM' }),
            bucket('b/y', { architecture: 'Qwen3MoeForCausalLM' }),
          ],
        },
      },
    });
    const store = new ElasticsearchResultsStore({ search } as unknown as Client, 'error');

    const models = await store.queryModels({ architecture: 'LlamaForCausalLM' });
    expect(models).toHaveLength(1);
    expect(models[0].modelId).toBe('a/x');
  });

  it('returns an empty list when no models have been benchmarked', async () => {
    const search = vi.fn().mockResolvedValue({ aggregations: { models: { buckets: [] } } });
    const client = { search } as unknown as Client;
    const store = new ElasticsearchResultsStore(client, 'error');

    expect(await store.queryModels()).toEqual([]);
  });
});
