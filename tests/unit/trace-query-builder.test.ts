import { describe, it, expect, vi } from 'vitest';
import { TraceQueryBuilderImpl } from '../../src/services/trace-query-builder.js';
import type { Client } from '@elastic/elasticsearch';
import type { Logger } from 'winston';

function createMockClient(
  responses: Array<unknown | Error>,
): Client {
  let callIndex = 0;
  return {
    transport: {
      request: vi.fn(async () => {
        const resp = responses[callIndex++];
        if (resp instanceof Error) throw resp;
        return resp;
      }),
    },
  } as unknown as Client;
}

function createMockLogger(): Logger {
  return {
    warn: vi.fn(),
  } as unknown as Logger;
}

const MODEL_ID = 'org/model-1';
const RUN_ID = 'run-abc';
const TIME_RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };

describe('TraceQueryBuilderImpl', () => {
  describe('buildSummary', () => {
    it('returns full TraceSummary on successful queries', async () => {
      const errorResp = {
        columns: [
          { name: 'Name', type: 'keyword' },
          { name: 'count', type: 'long' },
          { name: 'sample', type: 'keyword' },
        ],
        values: [
          ['infer', 3, 'oom'],
          ['deploy', 1, 'timeout'],
        ],
      };

      const latencyResp = {
        columns: [
          { name: 'Name', type: 'keyword' },
          { name: 'count', type: 'long' },
          { name: 'p50', type: 'long' },
          { name: 'p95', type: 'long' },
          { name: 'p99', type: 'long' },
          { name: 'avgDur', type: 'long' },
          { name: 'errors', type: 'long' },
        ],
        values: [
          ['infer', 10, 1_000_000, 2_000_000, 3_000_000, 1_500_000, 2],
          ['deploy', 5, 500_000, 1_000_000, 1_500_000, 750_000, 0],
        ],
      };

      const client = createMockClient([errorResp, latencyResp]);
      const builder = new TraceQueryBuilderImpl(client);
      const summary = await builder.buildSummary(MODEL_ID, RUN_ID, TIME_RANGE);

      expect(summary.totalSpans).toBe(15);
      expect(summary.errorCount).toBe(2);
      expect(summary.topErrors).toHaveLength(2);
      expect(summary.topErrors[0]).toEqual({ operation: 'infer', count: 3, sampleMessage: 'oom' });
      expect(summary.topErrors[1]).toEqual({ operation: 'deploy', count: 1, sampleMessage: 'timeout' });

      // Global percentiles weighted by count
      // p50: (1_000_000 * 10 + 500_000 * 5) / 15 = 833_333.33... -> ms = 0.83333...
      expect(summary.latencyPercentiles.p50_ms).toBeCloseTo(0.833333, 5);
      // p95: (2_000_000 * 10 + 1_000_000 * 5) / 15 = 1_666_666.66... -> ms = 1.66666...
      expect(summary.latencyPercentiles.p95_ms).toBeCloseTo(1.666666, 5);
      // p99: (3_000_000 * 10 + 1_500_000 * 5) / 15 = 2_500_000 -> ms = 2.5
      expect(summary.latencyPercentiles.p99_ms).toBeCloseTo(2.5, 5);

      expect(summary.operations).toHaveLength(2);
      expect(summary.operations[0]).toEqual({
        name: 'infer',
        count: 10,
        avgDurationMs: 1.5,
        errorRate: 0.2,
      });
      expect(summary.operations[1]).toEqual({
        name: 'deploy',
        count: 5,
        avgDurationMs: 0.75,
        errorRate: 0,
      });
    });

    it('returns degraded summary on query failure', async () => {
      const client = createMockClient([new Error('ES|QL parse error')]);
      const logger = createMockLogger();
      const builder = new TraceQueryBuilderImpl(client, logger);
      const summary = await builder.buildSummary(MODEL_ID, RUN_ID, TIME_RANGE);

      expect(summary).toEqual({
        totalSpans: 0,
        errorCount: 0,
        topErrors: [],
        latencyPercentiles: { p50_ms: 0, p95_ms: 0, p99_ms: 0 },
        operations: [],
      });

      expect(logger.warn).toHaveBeenCalledOnce();
      const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      expect(warnArgs[0]).toBe('Trace query failed, returning degraded summary');
      expect((warnArgs[1] as Record<string, unknown>).error).toBe('ES|QL parse error');
      expect((warnArgs[1] as Record<string, unknown>).modelId).toBe(MODEL_ID);
    });

    it('uses OTel semconv field names in ES|QL strings', async () => {
      const client = createMockClient([
        { columns: [], values: [] },
        { columns: [], values: [] },
      ]);
      const builder = new TraceQueryBuilderImpl(client, undefined, 'traces-*');
      await builder.buildSummary(MODEL_ID, RUN_ID, TIME_RANGE);

      expect(client.transport.request).toHaveBeenCalledTimes(2);
      const calls = (client.transport.request as ReturnType<typeof vi.fn>).mock.calls as Array<[
        { body: { query: string } },
      ]>;
      const q1 = calls[0][0].body.query;
      const q2 = calls[1][0].body.query;

      expect(q1).toContain('FROM traces-*');
      expect(q1).toContain('@timestamp');
      expect(q1).toContain('status.code == "Error"');
      expect(q1).toContain('trace.id');
      expect(q1).toContain('span.name');

      expect(q2).toContain('FROM traces-*');
      expect(q2).toContain('@timestamp');
      expect(q2).toContain('PERCENTILE(duration, 50)');
      expect(q2).toContain('status.code == "Error"');
    });

    it('converts Duration from nanoseconds to milliseconds', async () => {
      const latencyResp = {
        columns: [
          { name: 'Name', type: 'keyword' },
          { name: 'count', type: 'long' },
          { name: 'p50', type: 'long' },
          { name: 'p95', type: 'long' },
          { name: 'p99', type: 'long' },
          { name: 'avgDur', type: 'long' },
          { name: 'errors', type: 'long' },
        ],
        values: [
          ['op', 1, 1_000_000, 2_000_000, 3_000_000, 5_000_000, 0],
        ],
      };

      const client = createMockClient([
        { columns: [], values: [] },
        latencyResp,
      ]);
      const builder = new TraceQueryBuilderImpl(client);
      const summary = await builder.buildSummary(MODEL_ID, RUN_ID, TIME_RANGE);

      // avgDur 5_000_000 ns = 5 ms
      expect(summary.operations[0]!.avgDurationMs).toBe(5);
      // percentile values should also be divided by 1_000_000
      expect(summary.latencyPercentiles.p50_ms).toBe(1);
      expect(summary.latencyPercentiles.p95_ms).toBe(2);
      expect(summary.latencyPercentiles.p99_ms).toBe(3);
    });

    it('handles empty query results gracefully', async () => {
      const client = createMockClient([
        { columns: [], values: [] },
        { columns: [], values: [] },
      ]);
      const builder = new TraceQueryBuilderImpl(client);
      const summary = await builder.buildSummary(MODEL_ID, RUN_ID, TIME_RANGE);

      expect(summary.totalSpans).toBe(0);
      expect(summary.errorCount).toBe(0);
      expect(summary.topErrors).toEqual([]);
      expect(summary.latencyPercentiles).toEqual({ p50_ms: 0, p95_ms: 0, p99_ms: 0 });
      expect(summary.operations).toEqual([]);
    });
  });
});
