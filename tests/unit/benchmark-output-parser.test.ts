import { describe, it, expect } from 'vitest';
import { parseBenchmarkOutput } from '../../src/services/benchmark-output-parser.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * Standard vllm bench serve output format
 */
function createStandardOutput(overrides: {
  itl?: number;
  ttft?: number;
  throughput?: number;
  p99Latency?: number;
} = {}): string {
  const itl = overrides.itl ?? 12.5;
  const ttft = overrides.ttft ?? 45.2;
  const throughput = overrides.throughput ?? 156.3;
  const p99Latency = overrides.p99Latency ?? 35.8;

  return [
    '============ Serving Benchmark Result ============',
    `Successful requests:                     200`,
    `Benchmark duration (s):                  128.45`,
    `Total input tokens:                      51200`,
    `Total generated tokens:                  25600`,
    `Request throughput (req/s):              1.56`,
    `Output token throughput (tok/s):          ${throughput}`,
    `Total Token throughput (tok/s):           312.6`,
    `---------------Time to First Token----------------`,
    `Mean TTFT (ms):                          ${ttft}`,
    `Median TTFT (ms):                        40.1`,
    `P99 TTFT (ms):                           89.3`,
    `-----Time per Output Token (Excluding 1st Token)---`,
    `Mean ITL (ms):                           ${itl}`,
    `Median ITL (ms):                         10.8`,
    `P99 ITL (ms):                            ${p99Latency}`,
    `==================================================`,
  ].join('\n');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseBenchmarkOutput', () => {
  describe('standard vllm bench serve output', () => {
    it('parses all metrics from standard output format', () => {
      const output = createStandardOutput({
        itl: 15.3,
        ttft: 42.1,
        throughput: 180.5,
        p99Latency: 28.9,
      });

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(15.3);
      expect(result.metrics.ttftMs).toBe(42.1);
      expect(result.metrics.throughputTokensPerSec).toBe(180.5);
      expect(result.metrics.p99LatencyMs).toBe(28.9);
      expect(result.metrics.concurrencyLevel).toBe(4);
      expect(result.errors).toHaveLength(0);
    });

    it('handles integer values', () => {
      const output = createStandardOutput({
        itl: 10,
        ttft: 30,
        throughput: 200,
        p99Latency: 25,
      });

      const result = parseBenchmarkOutput(output, 1);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(10);
      expect(result.metrics.ttftMs).toBe(30);
      expect(result.metrics.throughputTokensPerSec).toBe(200);
      expect(result.metrics.p99LatencyMs).toBe(25);
    });

    it('handles decimal values', () => {
      const output = createStandardOutput({
        itl: 12.345,
        ttft: 45.678,
        throughput: 156.789,
        p99Latency: 35.123,
      });

      const result = parseBenchmarkOutput(output, 16);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBeCloseTo(12.345);
      expect(result.metrics.ttftMs).toBeCloseTo(45.678);
      expect(result.metrics.throughputTokensPerSec).toBeCloseTo(156.789);
      expect(result.metrics.p99LatencyMs).toBeCloseTo(35.123);
    });
  });

  describe('alternative output formats', () => {
    it('parses key-value format with colons', () => {
      const output = [
        'Mean ITL (ms): 14.2',
        'Mean TTFT (ms): 50.0',
        'Output token throughput (tok/s): 175.0',
        'P99 ITL (ms): 30.0',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(14.2);
      expect(result.metrics.ttftMs).toBe(50.0);
      expect(result.metrics.throughputTokensPerSec).toBe(175.0);
      expect(result.metrics.p99LatencyMs).toBe(30.0);
    });

    it('parses output with "Avg per-token latency" format', () => {
      const output = [
        'Avg per-token latency: 11.5 ms',
        'Time to first token (ms): avg=38.2',
        'Throughput (tok/s): 195.0',
        'P99 latency (ms): 22.0',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 1);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(11.5);
      expect(result.metrics.ttftMs).toBe(38.2);
      expect(result.metrics.throughputTokensPerSec).toBe(195.0);
      expect(result.metrics.p99LatencyMs).toBe(22.0);
    });

    it('parses output with underscore-format keys', () => {
      const output = [
        'mean_itl_ms: 13.7',
        'mean_ttft_ms: 44.0',
        'output_throughput: 165.0',
        'p99_itl_ms: 32.5',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 8);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(13.7);
      expect(result.metrics.ttftMs).toBe(44.0);
      expect(result.metrics.throughputTokensPerSec).toBe(165.0);
      expect(result.metrics.p99LatencyMs).toBe(32.5);
    });
  });

  describe('JSON output parsing', () => {
    it('parses JSON output with standard keys', () => {
      const jsonOutput = JSON.stringify({
        mean_itl_ms: 11.0,
        mean_ttft_ms: 35.0,
        output_throughput: 210.0,
        p99_itl_ms: 22.0,
      });

      const result = parseBenchmarkOutput(jsonOutput, 4);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(11.0);
      expect(result.metrics.ttftMs).toBe(35.0);
      expect(result.metrics.throughputTokensPerSec).toBe(210.0);
      expect(result.metrics.p99LatencyMs).toBe(22.0);
    });

    it('parses JSON output embedded in text', () => {
      const output = [
        'Running benchmark...',
        'Results:',
        JSON.stringify({
          mean_itl_ms: 14.5,
          mean_ttft_ms: 40.0,
          output_throughput: 180.0,
          p99_itl_ms: 28.0,
        }),
        'Done.',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 1);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(14.5);
      expect(result.metrics.ttftMs).toBe(40.0);
      expect(result.metrics.throughputTokensPerSec).toBe(180.0);
      expect(result.metrics.p99LatencyMs).toBe(28.0);
    });

    it('handles JSON output with alternative key names', () => {
      const jsonOutput = JSON.stringify({
        avg_itl_ms: 12.0,
        avg_ttft_ms: 38.0,
        throughput: 190.0,
        p99_latency_ms: 25.0,
        mean_itl_ms: 12.0, // Required for JSON detection
      });

      const result = parseBenchmarkOutput(jsonOutput, 4);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(12.0);
    });
  });

  describe('partial/missing metrics', () => {
    it('succeeds with ITL and throughput even without TTFT and P99', () => {
      const output = [
        'Mean ITL (ms): 14.2',
        'Output token throughput (tok/s): 175.0',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(14.2);
      expect(result.metrics.throughputTokensPerSec).toBe(175.0);
      expect(result.metrics.ttftMs).toBe(0);
      expect(result.metrics.p99LatencyMs).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('fails when ITL is missing', () => {
      const output = [
        'Output token throughput (tok/s): 175.0',
        'Mean TTFT (ms): 40.0',
        'P99 ITL (ms): 30.0',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('ITL'))).toBe(true);
    });

    it('fails when throughput is missing', () => {
      const output = [
        'Mean ITL (ms): 14.2',
        'Mean TTFT (ms): 40.0',
        'P99 ITL (ms): 30.0',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('throughput'))).toBe(true);
    });

    it('fails when both ITL and throughput are missing', () => {
      const output = 'Running benchmark... Done.\n';

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('ITL'))).toBe(true);
      expect(result.errors.some((e) => e.includes('throughput'))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles empty output', () => {
      const result = parseBenchmarkOutput('', 1);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('handles output with noise and valid metrics', () => {
      const output = [
        'WARNING: some deprecation notice',
        'INFO: Loading model...',
        'DEBUG: Cache initialized',
        '============ Serving Benchmark Result ============',
        'Output token throughput (tok/s):          160.0',
        'Mean TTFT (ms):                          42.0',
        'Mean ITL (ms):                           13.0',
        'P99 ITL (ms):                            30.0',
        '==================================================',
        'INFO: Cleanup complete',
      ].join('\n');

      const result = parseBenchmarkOutput(output, 4);

      expect(result.success).toBe(true);
      expect(result.metrics.itlMs).toBe(13.0);
      expect(result.metrics.ttftMs).toBe(42.0);
      expect(result.metrics.throughputTokensPerSec).toBe(160.0);
      expect(result.metrics.p99LatencyMs).toBe(30.0);
    });

    it('sets the correct concurrency level', () => {
      const output = createStandardOutput();

      const result1 = parseBenchmarkOutput(output, 1);
      const result4 = parseBenchmarkOutput(output, 4);
      const result16 = parseBenchmarkOutput(output, 16);

      expect(result1.metrics.concurrencyLevel).toBe(1);
      expect(result4.metrics.concurrencyLevel).toBe(4);
      expect(result16.metrics.concurrencyLevel).toBe(16);
    });

    it('populates rawValues with extracted numbers', () => {
      const output = createStandardOutput({
        itl: 12.5,
        ttft: 45.2,
        throughput: 156.3,
        p99Latency: 35.8,
      });

      const result = parseBenchmarkOutput(output, 1);

      expect(result.rawValues['itl']).toBe(12.5);
      expect(result.rawValues['ttft']).toBe(45.2);
      expect(result.rawValues['throughput']).toBe(156.3);
      expect(result.rawValues['p99Latency']).toBe(35.8);
    });
  });
});
