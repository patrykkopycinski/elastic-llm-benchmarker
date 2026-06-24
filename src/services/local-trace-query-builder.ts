import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OTelSpan } from '../utils/otel-span-recorder.js';
import type { TraceQueryBuilder, TraceSummary } from './trace-query-builder.js';

const DEFAULT_TRACES_DIR = '.benchmark-traces-local';

/**
 * Reads locally recorded OTel spans (JSONL) when ES trace indices are empty
 * or use a different schema than our ES|QL queries expect.
 */
export class LocalTraceQueryBuilder implements TraceQueryBuilder {
  constructor(private readonly tracesDir: string = DEFAULT_TRACES_DIR) {}

  async buildSummary(
    modelId: string,
    _runId: string,
    timeRange: { from: string; to: string },
  ): Promise<TraceSummary> {
    const fromMs = Date.parse(timeRange.from);
    const toMs = Date.parse(timeRange.to);
    const spans = this.loadSpans(modelId, fromMs, toMs);

    if (spans.length === 0) {
      return {
        totalSpans: 0,
        errorCount: 0,
        topErrors: [],
        latencyPercentiles: { p50_ms: 0, p95_ms: 0, p99_ms: 0 },
        operations: [],
      };
    }

    const errorSpans = spans.filter((s) => s.status.code === 2);
    const errorsByName = new Map<string, { count: number; sample: string }>();
    for (const span of errorSpans) {
      const name = span.name;
      const existing = errorsByName.get(name) ?? { count: 0, sample: '' };
      existing.count += 1;
      if (!existing.sample) {
        existing.sample = String(span.attributes['error'] ?? span.status.message ?? '');
      }
      errorsByName.set(name, existing);
    }

    const topErrors = [...errorsByName.entries()]
      .map(([operation, { count, sample }]) => ({
        operation,
        count,
        sampleMessage: sample,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const opsByName = new Map<
      string,
      { count: number; durationsMs: number[]; errors: number }
    >();

    for (const span of spans) {
      const start = Number(span.startTimeUnixNano) / 1_000_000;
      const end = Number(span.endTimeUnixNano) / 1_000_000;
      const durationMs = Math.max(0, end - start);
      const entry = opsByName.get(span.name) ?? { count: 0, durationsMs: [], errors: 0 };
      entry.count += 1;
      entry.durationsMs.push(durationMs);
      if (span.status.code === 2) entry.errors += 1;
      opsByName.set(span.name, entry);
    }

    const allDurations = spans.map((s) => {
      const start = Number(s.startTimeUnixNano) / 1_000_000;
      const end = Number(s.endTimeUnixNano) / 1_000_000;
      return Math.max(0, end - start);
    });
    allDurations.sort((a, b) => a - b);

    const percentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const idx = Math.ceil((p / 100) * arr.length) - 1;
      return arr[Math.max(0, idx)] ?? 0;
    };

    const operations = [...opsByName.entries()].map(([name, data]) => ({
      name,
      count: data.count,
      avgDurationMs:
        data.durationsMs.reduce((sum, d) => sum + d, 0) / Math.max(1, data.durationsMs.length),
      errorRate: data.count > 0 ? data.errors / data.count : 0,
    }));

    return {
      totalSpans: spans.length,
      errorCount: errorSpans.length,
      topErrors,
      latencyPercentiles: {
        p50_ms: percentile(allDurations, 50),
        p95_ms: percentile(allDurations, 95),
        p99_ms: percentile(allDurations, 99),
      },
      operations,
    };
  }

  private loadSpans(modelId: string, fromMs: number, toMs: number): OTelSpan[] {
    if (!existsSync(this.tracesDir)) return [];

    const files = readdirSync(this.tracesDir).filter((f) => f.endsWith('.jsonl'));
    const spans: OTelSpan[] = [];

    for (const file of files) {
      const content = readFileSync(join(this.tracesDir, file), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const span = JSON.parse(line) as OTelSpan;
          const spanModel = String(span.attributes['modelId'] ?? span.attributes['model_id'] ?? '');
          if (spanModel && spanModel !== modelId) continue;

          const startMs = Number(span.startTimeUnixNano) / 1_000_000;
          if (Number.isFinite(fromMs) && startMs < fromMs) continue;
          if (Number.isFinite(toMs) && startMs > toMs) continue;

          spans.push(span);
        } catch {
          // skip malformed lines
        }
      }
    }

    return spans;
  }
}
