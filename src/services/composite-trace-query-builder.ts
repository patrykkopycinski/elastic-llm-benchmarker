import type { TraceQueryBuilder, TraceSummary } from './trace-query-builder.js';

/**
 * Tries ES-backed trace queries first; falls back to local JSONL spans when ES
 * returns empty or degraded summaries (common when EDOT is not wired to ES).
 */
export class CompositeTraceQueryBuilder implements TraceQueryBuilder {
  constructor(
    private readonly primary: TraceQueryBuilder,
    private readonly fallback: TraceQueryBuilder,
  ) {}

  async buildSummary(
    modelId: string,
    runId: string,
    timeRange: { from: string; to: string },
  ): Promise<TraceSummary> {
    const primarySummary = await this.primary.buildSummary(modelId, runId, timeRange);
    if (primarySummary.totalSpans > 0) {
      return primarySummary;
    }

    const fallbackSummary = await this.fallback.buildSummary(modelId, runId, timeRange);
    if (fallbackSummary.totalSpans > 0) {
      return fallbackSummary;
    }

    return primarySummary;
  }
}
