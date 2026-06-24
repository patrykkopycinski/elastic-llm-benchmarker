import type { Stage1Result } from '../scheduler/pipeline-state.js';
import type { AppConfig } from '../types/config.js';

/**
 * Gate that decides whether a model is eligible for Stage 2 benchmarks
 * based on Stage 1 results and configured thresholds.
 */
export class Stage2Gate {
  private readonly thresholds: AppConfig['stage2Thresholds'];

  constructor(config: AppConfig) {
    this.thresholds = config.stage2Thresholds;
  }

  /**
   * Evaluate Stage 1 result against thresholds.
   *
   * Returns `{ proceed: true }` if all metrics pass the gate;
   * otherwise returns `{ proceed: false, reason: string }` describing
   * the first failing threshold.
   */
  check(result: Stage1Result): { proceed: boolean; reason: string } {
    if (!result.metrics) {
      return { proceed: false, reason: 'No metrics available' };
    }

    const { metrics } = result;
    const { maxItlP50Ms, maxTtftMs, minThroughputTps } = this.thresholds;

    if (metrics.itl_p50_ms > maxItlP50Ms) {
      return {
        proceed: false,
        reason: `ITL p50 (${metrics.itl_p50_ms}ms) exceeds threshold (${maxItlP50Ms}ms)`,
      };
    }

    // Throughput must be >= minThroughputTps.
    if (metrics.throughput_tps < minThroughputTps) {
      return {
        proceed: false,
        reason: `Throughput (${metrics.throughput_tps} tps) below threshold (${minThroughputTps} tps)`,
      };
    }

    // TTFT must be <= maxTtftMs.
    if (metrics.ttft_ms > maxTtftMs) {
      return {
        proceed: false,
        reason: `TTFT (${metrics.ttft_ms}ms) exceeds threshold (${maxTtftMs}ms)`,
      };
    }

    return { proceed: true, reason: 'All thresholds passed' };
  }
}
