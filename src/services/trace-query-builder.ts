import type { Client } from '@elastic/elasticsearch';
import type { Logger } from 'winston';

export interface TraceSummary {
  totalSpans: number;
  errorCount: number;
  topErrors: Array<{ operation: string; count: number; sampleMessage: string }>;
  latencyPercentiles: { p50_ms: number; p95_ms: number; p99_ms: number };
  operations: Array<{ name: string; count: number; avgDurationMs: number; errorRate: number }>;
}

export interface TraceQueryBuilder {
  buildSummary(
    modelId: string,
    runId: string,
    timeRange: { from: string; to: string },
  ): Promise<TraceSummary>;
}

const DEGRADED_SUMMARY: TraceSummary = {
  totalSpans: 0,
  errorCount: 0,
  topErrors: [],
  latencyPercentiles: { p50_ms: 0, p95_ms: 0, p99_ms: 0 },
  operations: [],
};

const DEFAULT_TRACE_INDEX_PATTERN = 'traces-*';

// ES|QL response shape from `_query` endpoint
interface EsqlColumn {
  name: string;
  type: string;
}

interface EsqlResponse {
  columns?: EsqlColumn[];
  values?: unknown[][];
}

/** Escape double quotes for safe embedding in ES|QL string literals. */
function escapeEsqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class TraceQueryBuilderImpl implements TraceQueryBuilder {
  constructor(
    private readonly client: Client,
    private readonly logger?: Logger,
    private readonly traceIndexPattern: string = DEFAULT_TRACE_INDEX_PATTERN,
  ) {}

  async buildSummary(
    modelId: string,
    runId: string,
    timeRange: { from: string; to: string },
  ): Promise<TraceSummary> {
    try {
      const [errorsResp, latencyResp] = await Promise.all([
        this.runErrorQuery(runId, timeRange),
        this.runLatencyQuery(runId, timeRange),
      ]);

      const topErrors = this.parseTopErrors(errorsResp);
      const { latencyPercentiles, operations, totalSpans, errorCount } =
        this.parseLatencyAndOperations(latencyResp);

      return {
        totalSpans,
        errorCount,
        topErrors,
        latencyPercentiles,
        operations,
      };
    } catch (err) {
      this.logger?.warn('Trace query failed, returning degraded summary', {
        error: err instanceof Error ? err.message : String(err),
        modelId,
      });
      return { ...DEGRADED_SUMMARY };
    }
  }

  private buildTimeFilter(timeRange: { from: string; to: string }): string {
    const from = escapeEsqlString(timeRange.from);
    const to = escapeEsqlString(timeRange.to);
    return `@timestamp >= "${from}" AND @timestamp <= "${to}"`;
  }

  /**
   * Narrow spans to the active benchmark run. OTel traces from EDOT use semconv
   * field names (`trace.id`, `@timestamp`, `duration`) — not PascalCase.
   */
  private buildRunFilter(runId: string): string {
    const escapedRunId = escapeEsqlString(runId);
    return `(
  trace.id == "${escapedRunId}"
  OR attributes.kibana.evals.execution_id LIKE "*${escapedRunId}*"
  OR resource.attributes.service.name == "vllm-inference"
)`;
  }

  private async runErrorQuery(
    runId: string,
    timeRange: { from: string; to: string },
  ): Promise<EsqlResponse> {
    const index = this.traceIndexPattern;
    const query = `FROM ${index}
| WHERE ${this.buildRunFilter(runId)}
| WHERE ${this.buildTimeFilter(timeRange)}
| WHERE status.code == "Error"
| STATS count = COUNT(*), sample = SAMPLE(COALESCE(status.message, attributes.error.message), 1) BY span.name
| SORT count DESC
| LIMIT 10`;

    return this.client.transport.request<EsqlResponse>({
      method: 'POST',
      path: '/_query',
      body: { query },
    });
  }

  private async runLatencyQuery(
    runId: string,
    timeRange: { from: string; to: string },
  ): Promise<EsqlResponse> {
    const index = this.traceIndexPattern;
    const query = `FROM ${index}
| WHERE ${this.buildRunFilter(runId)}
| WHERE ${this.buildTimeFilter(timeRange)}
| STATS count = COUNT(*), p50 = PERCENTILE(duration, 50), p95 = PERCENTILE(duration, 95), p99 = PERCENTILE(duration, 99), avgDur = AVG(duration), errors = COUNT(*) WHERE status.code == "Error" BY span.name
| SORT p95 DESC`;

    return this.client.transport.request<EsqlResponse>({
      method: 'POST',
      path: '/_query',
      body: { query },
    });
  }

  private parseTopErrors(resp: EsqlResponse): TraceSummary['topErrors'] {
    const cols = resp.columns ?? [];
    const rows = resp.values ?? [];

    const idxName = cols.findIndex((c) => c.name === 'span.name' || c.name === 'Name');
    const idxCount = cols.findIndex((c) => c.name === 'count');
    const idxSample = cols.findIndex((c) => c.name === 'sample');

    return rows.map((row) => ({
      operation: String(row[idxName] ?? ''),
      count: Number(row[idxCount] ?? 0),
      sampleMessage: String(row[idxSample] ?? ''),
    }));
  }

  private parseLatencyAndOperations(resp: EsqlResponse): {
    latencyPercentiles: TraceSummary['latencyPercentiles'];
    operations: TraceSummary['operations'];
    totalSpans: number;
    errorCount: number;
  } {
    const cols = resp.columns ?? [];
    const rows = resp.values ?? [];

    const idxName = cols.findIndex((c) => c.name === 'span.name' || c.name === 'Name');
    const idxCount = cols.findIndex((c) => c.name === 'count');
    const idxP50 = cols.findIndex((c) => c.name === 'p50');
    const idxP95 = cols.findIndex((c) => c.name === 'p95');
    const idxP99 = cols.findIndex((c) => c.name === 'p99');
    const idxAvgDur = cols.findIndex((c) => c.name === 'avgDur');
    const idxErrors = cols.findIndex((c) => c.name === 'errors');

    let totalSpans = 0;
    let errorCount = 0;
    let globalP50 = 0;
    let globalP95 = 0;
    let globalP99 = 0;

    const operations: TraceSummary['operations'] = rows.map((row) => {
      const count = Number(row[idxCount] ?? 0);
      const errors = Number(row[idxErrors] ?? 0);
      const p50 = Number(row[idxP50] ?? 0);
      const p95 = Number(row[idxP95] ?? 0);
      const p99 = Number(row[idxP99] ?? 0);
      const avgDurNs = Number(row[idxAvgDur] ?? 0);

      totalSpans += count;
      errorCount += errors;

      // Update global percentiles using weighted averages by count
      globalP50 += p50 * count;
      globalP95 += p95 * count;
      globalP99 += p99 * count;

      return {
        name: String(row[idxName] ?? ''),
        count,
        avgDurationMs: avgDurNs / 1_000_000,
        errorRate: count > 0 ? errors / count : 0,
      };
    });

    if (totalSpans > 0) {
      globalP50 /= totalSpans;
      globalP95 /= totalSpans;
      globalP99 /= totalSpans;
    }

    return {
      latencyPercentiles: {
        p50_ms: globalP50 / 1_000_000,
        p95_ms: globalP95 / 1_000_000,
        p99_ms: globalP99 / 1_000_000,
      },
      operations,
      totalSpans,
      errorCount,
    };
  }
}
