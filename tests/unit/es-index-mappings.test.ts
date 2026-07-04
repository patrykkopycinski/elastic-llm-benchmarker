import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import {
  INDEX_NAMES,
  INDEX_MAPPINGS,
  DATE_SUFFIXED_INDEX_BASES,
  ensureDateSuffixedTemplates,
  ensureIndices,
  benchmarkEvaluationsMapping,
  benchmarkStage2Mapping,
  benchmarkReasoningMapping,
} from '../../src/services/es-index-mappings.js';

describe('es-index-mappings', () => {
  it('exports all expected index names as lowercase hyphenated strings', () => {
    const values = Object.values(INDEX_NAMES);
    expect(values).toHaveLength(12);
    values.forEach((name) => {
      expect(name).toEqual(name.toLowerCase());
      expect(name).toMatch(/^[a-z0-9-]+$/);
    });
  });

  it('has a mapping entry for every index name', () => {
    const names = Object.values(INDEX_NAMES);
    for (const name of names) {
      expect(INDEX_MAPPINGS).toHaveProperty(name);
      const entry = INDEX_MAPPINGS[name]!;
      expect(entry).toHaveProperty('mappings');
      expect(entry.mappings).toHaveProperty('properties');
      // The daemon-lease index intentionally omits settings so the
      // non-serverless-safe `ensureIndices` can create it on Serverless.
      if (name === INDEX_NAMES.BENCHMARKER_DAEMON_LEASE) continue;
      expect(entry).toHaveProperty('settings');
      expect(entry.settings!).toHaveProperty('number_of_shards');
      expect(entry.settings!).toHaveProperty('number_of_replicas');
    }
  });

  it('maps benchmarker-daemon-lease without settings (serverless-safe) and with lease fields', () => {
    const entry = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_DAEMON_LEASE]!;
    expect(entry.settings).toBeUndefined();
    const m = entry.mappings.properties;
    expect(m).toHaveProperty('vm_host');
    expect(m).toHaveProperty('owner_hostname');
    expect(m).toHaveProperty('owner_pid');
    expect(m).toHaveProperty('heartbeat_at');
  });

  it('maps benchmarker-results with nested benchmark_metrics', () => {
    const m = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_RESULTS]!.mappings.properties;
    expect(m).toHaveProperty('@timestamp');
    expect(m).toHaveProperty('model_id');
    expect(m).toHaveProperty('benchmark_metrics');
    const bm = m['benchmark_metrics'] as { type: string; properties: Record<string, unknown> };
    expect(bm.type).toBe('nested');
    expect(bm.properties).toHaveProperty('itl_ms');
    expect(bm.properties).toHaveProperty('throughput_tokens_per_sec');
  });

  it('maps benchmarker-queue with refresh_interval', () => {
    const entry = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_QUEUE]!;
    expect(entry.settings!.refresh_interval).toBe('5s');
    expect(entry.mappings.properties).toHaveProperty('status');
    expect(entry.mappings.properties).toHaveProperty('requested_at');
  });

  it('maps benchmarker-errors with circuit_breaker fields', () => {
    const m = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_ERRORS]!.mappings.properties;
    expect(m).toHaveProperty('circuit_breaker_state');
    expect(m).toHaveProperty('circuit_breaker_old_state');
    expect(m).toHaveProperty('failure_count');
  });

  it('maps benchmark-reasoning with nested suggestions', () => {
    const m = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_REASONING]!.mappings.properties;
    expect(m).toHaveProperty('suggestions');
    const sug = m['suggestions'] as { type: string; properties: Record<string, unknown> };
    expect(sug.type).toBe('nested');
    expect(sug.properties).toHaveProperty('category');
    expect(sug.properties).toHaveProperty('estimatedImpact');
  });

  it('exposes standalone benchmarkEvaluationsMapping matching index mapping', () => {
    const fromIndex = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_EVALUATIONS]!.mappings.properties;
    expect(benchmarkEvaluationsMapping).toEqual(fromIndex);
  });

  it('exposes standalone benchmarkStage2Mapping matching index mapping', () => {
    const fromIndex = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_STAGE2]!.mappings.properties;
    expect(benchmarkStage2Mapping).toEqual(fromIndex);
  });

  it('exposes standalone benchmarkReasoningMapping matching index mapping', () => {
    const fromIndex = INDEX_MAPPINGS[INDEX_NAMES.BENCHMARKER_REASONING]!.mappings.properties;
    expect(benchmarkReasoningMapping).toEqual(fromIndex);
  });

  it('tracks the three date-suffixed index bases', () => {
    expect([...DATE_SUFFIXED_INDEX_BASES]).toEqual([
      INDEX_NAMES.BENCHMARKER_EVALUATIONS,
      INDEX_NAMES.BENCHMARKER_STAGE2,
      INDEX_NAMES.BENCHMARKER_REASONING,
    ]);
  });

  it('retries index creation without settings when the cluster is serverless', async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const create = vi
      .fn()
      // Every first attempt (with settings) fails as it would on serverless.
      .mockImplementation((arg: { settings?: unknown }) => {
        if (arg.settings) {
          return Promise.reject(
            new Error(
              'illegal_argument_exception: Settings [index.number_of_replicas,index.number_of_shards] are not available when running in serverless mode',
            ),
          );
        }
        return Promise.resolve({});
      });
    const putIndexTemplate = vi.fn().mockResolvedValue({});
    const esClient = {
      indices: { exists, create, putIndexTemplate },
    } as unknown as Client;

    await ensureIndices(esClient);

    // Any index that carries settings should have been retried mappings-only,
    // and none of the final successful creates carry a settings block.
    const settingsCreates = create.mock.calls.filter((c) => c[0].settings);
    const mappingsOnlyCreates = create.mock.calls.filter((c) => !c[0].settings);
    expect(settingsCreates.length).toBeGreaterThan(0);
    expect(mappingsOnlyCreates.length).toBeGreaterThanOrEqual(settingsCreates.length);
    for (const call of mappingsOnlyCreates) {
      expect(call[0]).toHaveProperty('mappings');
      expect(call[0].settings).toBeUndefined();
    }
  });

  it('propagates non-settings index-creation errors', async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const create = vi.fn().mockRejectedValue(new Error('resource_already_exists_exception'));
    const putIndexTemplate = vi.fn().mockResolvedValue({});
    const esClient = {
      indices: { exists, create, putIndexTemplate },
    } as unknown as Client;

    await expect(ensureIndices(esClient)).rejects.toThrow('resource_already_exists_exception');
  });

  it('installs a keyword-preserving template per date-suffixed base', async () => {
    const putIndexTemplate = vi.fn().mockResolvedValue({});
    const esClient = { indices: { putIndexTemplate } } as unknown as Client;

    await ensureDateSuffixedTemplates(esClient);

    expect(putIndexTemplate).toHaveBeenCalledTimes(DATE_SUFFIXED_INDEX_BASES.length);
    for (const base of DATE_SUFFIXED_INDEX_BASES) {
      const call = putIndexTemplate.mock.calls.find((c) => c[0].name === `${base}-template`);
      expect(call, `template for ${base}`).toBeDefined();
      const arg = call![0];
      expect(arg.index_patterns).toEqual([`${base}-*`]);
      const props = arg.template.mappings.properties as Record<string, { type: string }>;
      // The whole point: model_id / status must stay keyword, not dynamic text.
      expect(props.model_id.type).toBe('keyword');
      expect(props.status.type).toBe('keyword');
    }
  });
});
