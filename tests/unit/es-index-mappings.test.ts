import { describe, it, expect } from 'vitest';
import {
  INDEX_NAMES,
  INDEX_MAPPINGS,
  benchmarkEvaluationsMapping,
  benchmarkStage2Mapping,
  benchmarkReasoningMapping,
} from '../../src/services/es-index-mappings.js';

describe('es-index-mappings', () => {
  it('exports all expected index names as lowercase hyphenated strings', () => {
    const values = Object.values(INDEX_NAMES);
    expect(values).toHaveLength(10);
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
      expect(entry).toHaveProperty('settings');
      expect(entry.settings!).toHaveProperty('number_of_shards');
      expect(entry.settings!).toHaveProperty('number_of_replicas');
    }
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
});
