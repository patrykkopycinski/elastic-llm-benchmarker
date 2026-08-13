import { describe, expect, it, vi } from 'vitest';
import {
  fetchServedWeightSize,
  summarizeServedWeightSize,
  type HfTreeFile,
  type HfFetch,
} from '../../src/services/hf-served-weight-size.js';

const GB = 1024 ** 3;

function numberedShards(prefix: string, count: number, bytesEach: number): HfTreeFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `${prefix}-${String(i + 1).padStart(5, '0')}-of-${String(count).padStart(6, '0')}.safetensors`,
    size: bytesEach,
    type: 'file',
  }));
}

describe('summarizeServedWeightSize', () => {
  it('sums a complete numbered root shard set', () => {
    const files = numberedShards('model', 3, GB);

    const result = summarizeServedWeightSize(files);

    expect(result).toMatchObject({
      bytes: 3 * GB,
      gb: 3,
      shardCount: 3,
      expectedShardCount: 3,
      family: 'model',
    });
  });

  it('rejects an incomplete numbered shard set instead of trusting a partial tree page', () => {
    const files = numberedShards('model', 3, GB).slice(0, 2);

    expect(() => summarizeServedWeightSize(files)).toThrow(/Incomplete safetensors shard set.*2\/3/);
  });

  it('selects one root family and does not double-count consolidated duplicate weights', () => {
    const files = [
      ...numberedShards('model', 2, 10 * GB),
      ...numberedShards('consolidated', 2, 10 * GB),
      { path: 'original/model-00001-of-00002.safetensors', size: 12 * GB, type: 'file' },
      { path: 'original/model-00002-of-00002.safetensors', size: 12 * GB, type: 'file' },
    ];

    const result = summarizeServedWeightSize(files);

    expect(result?.family).toBe('model');
    expect(result?.bytes).toBe(20 * GB);
    expect(result?.alternateFamilies).toEqual([
      { family: 'consolidated', shardCount: 2, bytes: 20 * GB },
    ]);
    expect(result?.ignoredPaths).toEqual([
      'original/model-00001-of-00002.safetensors',
      'original/model-00002-of-00002.safetensors',
    ]);
  });

  it('returns null when no served safetensors shards are present', () => {
    expect(
      summarizeServedWeightSize([
        { path: 'config.json', size: 100, type: 'file' },
        { path: 'model.gguf', size: 100, type: 'file' },
      ]),
    ).toBeNull();
  });
});

describe('fetchServedWeightSize', () => {
  it('paginates the HF tree API before summing physical bytes', async () => {
    const firstPage = [
      { path: 'model-00001-of-000004.safetensors', size: GB, type: 'file' },
      { path: 'model-00002-of-000004.safetensors', size: GB, type: 'file' },
    ];
    const secondPage = [
      { path: 'model-00003-of-000004.safetensors', size: GB, type: 'file' },
      { path: 'model-00004-of-000004.safetensors', size: GB, type: 'file' },
    ];
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      const isSecondPage = url.includes('cursor=');
      return {
        ok: true,
        json: async () => (isSecondPage ? secondPage : firstPage),
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'link' && !isSecondPage
              ? '<https://huggingface.co/api/models/org/model/tree/main?recursive=1&expand=1&cursor=next>; rel="next"'
              : null,
        },
      };
    });

    const result = await fetchServedWeightSize('org/model', fetchMock as unknown as HfFetch, 'token');

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain('cursor=next');
    expect(result).toMatchObject({ bytes: 4 * GB, shardCount: 4, expectedShardCount: 4 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer token' },
    });
  });
});
