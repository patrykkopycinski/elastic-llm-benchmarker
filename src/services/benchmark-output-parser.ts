import type { BenchmarkMetrics } from '../types/benchmark.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of parsing vllm bench serve output */
export interface BenchmarkOutputParseResult {
  /** Whether parsing was successful */
  success: boolean;
  /** Parsed metrics (valid only if success is true) */
  metrics: BenchmarkMetrics;
  /** Parse errors encountered */
  errors: string[];
  /** Raw extracted values before conversion */
  rawValues: Record<string, number>;
}

// ─── Metric Patterns ─────────────────────────────────────────────────────────

/**
 * Regular expression patterns for extracting metrics from vllm bench serve output.
 *
 * vllm bench serve outputs metrics in various formats including:
 * - Tabular summaries with labeled rows
 * - Key-value pairs
 * - JSON-formatted output
 *
 * These patterns cover the known output formats of vllm bench serve.
 */
const METRIC_PATTERNS = {
  // ─── ITL (Inter-Token Latency) ─────────────────────────────────────────
  itl: [
    // Pattern: "Mean ITL (ms):                    12.34"
    /Mean\s+ITL\s*\(ms\)\s*:\s*([\d.]+)/i,
    // Pattern: "Avg per-token latency: 12.34 ms"
    /Avg\s+per[- ]token\s+latency\s*:\s*([\d.]+)\s*ms/i,
    // Pattern: "Inter-token latency (ms): avg=12.34"
    /[Ii]nter[- ][Tt]oken\s+[Ll]atency\s*\(ms\)\s*:?\s*(?:avg\s*=\s*)?([\d.]+)/,
    // Pattern: "ITL (ms):                          avg: 12.34"
    /ITL\s*\(ms\)\s*:\s*(?:.*?)avg\s*:?\s*([\d.]+)/i,
    // Pattern: "mean_itl_ms: 12.34" or "mean_itl_ms":12.34
    /mean_itl_ms["\s:]+\s*([\d.]+)/,
    // Pattern: "  Inter-token Latency    | avg    12.34"
    /[Ii]nter[- ][Tt]oken\s+[Ll]atency\s*\|?\s*avg\s*([\d.]+)/,
  ],

  // ─── TTFT (Time To First Token) ────────────────────────────────────────
  ttft: [
    // Pattern: "Mean TTFT (ms):                    45.67"
    /Mean\s+TTFT\s*\(ms\)\s*:\s*([\d.]+)/i,
    // Pattern: "Time to first token (ms): avg=45.67"
    /[Tt]ime\s+[Tt]o\s+[Ff]irst\s+[Tt]oken\s*\(ms\)\s*:?\s*(?:avg\s*=\s*)?([\d.]+)/,
    // Pattern: "TTFT (ms):                          avg: 45.67"
    /TTFT\s*\(ms\)\s*:\s*(?:.*?)avg\s*:?\s*([\d.]+)/i,
    // Pattern: "mean_ttft_ms: 45.67" or "mean_ttft_ms":45.67
    /mean_ttft_ms["\s:]+\s*([\d.]+)/,
    // Pattern: "  Time to First Token    | avg    45.67"
    /[Tt]ime\s+[Tt]o\s+[Ff]irst\s+[Tt]oken\s*\|?\s*avg\s*([\d.]+)/,
  ],

  // ─── Throughput (tokens per second) ────────────────────────────────────
  throughput: [
    // Pattern: "Output token throughput (tok/s):    123.45"
    /[Oo]utput\s+[Tt]oken\s+[Tt]hroughput\s*\(tok\/s\)\s*:\s*([\d.]+)/,
    // Pattern: "Throughput (tok/s): 123.45"
    /[Tt]hroughput\s*\(tok(?:ens)?\/s\)\s*:\s*([\d.]+)/,
    // Pattern: "output_throughput: 123.45" or "output_throughput":123.45
    /output_throughput["\s:]+\s*([\d.]+)/,
    // Pattern: "Total throughput: 123.45 tokens/s"
    /[Tt]otal\s+[Tt]hroughput\s*:\s*([\d.]+)\s*tokens?\/s/,
    // Pattern: "Token throughput: 123.45 tok/s"
    /[Tt]oken\s+[Tt]hroughput\s*:\s*([\d.]+)\s*tok(?:ens)?\/s/,
    // Pattern: "Output token throughput   | 123.45"
    /[Oo]utput\s+[Tt]oken\s+[Tt]hroughput\s*\|?\s*([\d.]+)/,
  ],

  // ─── P99 Latency ──────────────────────────────────────────────────────
  p99Latency: [
    // Pattern: "P99 ITL (ms):                      56.78"
    /P99\s+ITL\s*\(ms\)\s*:\s*([\d.]+)/i,
    // Pattern: "P99 latency (ms): 56.78"
    /P99\s+(?:latency|Latency)\s*\(ms\)\s*:\s*([\d.]+)/,
    // Pattern: "p99_latency_ms: 56.78"
    /p99_latency_ms["\s:]+\s*([\d.]+)/,
    // Pattern: "p99_itl_ms: 56.78"
    /p99_itl_ms["\s:]+\s*([\d.]+)/,
    // Pattern: "ITL (ms): ... p99: 56.78"
    /ITL\s*\(ms\)\s*:.*?p99\s*:?\s*([\d.]+)/i,
    // Pattern: "  P99 Inter-token Latency | 56.78"
    /P99\s+[Ii]nter[- ][Tt]oken\s+[Ll]atency\s*\|?\s*([\d.]+)/,
    // Pattern: "  Inter-token Latency  | ... p99    56.78"
    /[Ii]nter[- ][Tt]oken\s+[Ll]atency\s*\|?.*?p99\s*([\d.]+)/,
  ],
};

// ─── Parser Functions ─────────────────────────────────────────────────────────

/**
 * Parses the raw output from `vllm bench serve` to extract benchmark metrics.
 *
 * Handles multiple output formats that vllm bench serve may produce:
 * - Human-readable tabular output
 * - JSON-formatted output
 * - Key-value pair output
 *
 * @param output - Raw stdout/stderr from vllm bench serve
 * @param concurrencyLevel - The concurrency level used for this run
 * @returns Parse result with metrics and any errors
 */
export function parseBenchmarkOutput(
  output: string,
  concurrencyLevel: number,
): BenchmarkOutputParseResult {
  const errors: string[] = [];
  const rawValues: Record<string, number> = {};

  // First, try JSON parsing if the output looks like JSON
  const jsonMetrics = tryParseJsonOutput(output, concurrencyLevel);
  if (jsonMetrics) {
    return jsonMetrics;
  }

  // Fall back to regex-based parsing
  const itl = extractMetric(output, METRIC_PATTERNS.itl, 'ITL');
  const ttft = extractMetric(output, METRIC_PATTERNS.ttft, 'TTFT');
  const throughput = extractMetric(output, METRIC_PATTERNS.throughput, 'throughput');
  const p99Latency = extractMetric(output, METRIC_PATTERNS.p99Latency, 'P99 latency');

  if (itl === null) {
    errors.push('Could not extract ITL (Inter-Token Latency) from output');
  } else {
    rawValues['itl'] = itl;
  }

  if (ttft === null) {
    errors.push('Could not extract TTFT (Time To First Token) from output');
  } else {
    rawValues['ttft'] = ttft;
  }

  if (throughput === null) {
    errors.push('Could not extract throughput from output');
  } else {
    rawValues['throughput'] = throughput;
  }

  if (p99Latency === null) {
    errors.push('Could not extract P99 latency from output');
  } else {
    rawValues['p99Latency'] = p99Latency;
  }

  // Require at least ITL and throughput for a valid result
  const hasMinimumMetrics = itl !== null && throughput !== null;

  if (!hasMinimumMetrics) {
    return {
      success: false,
      metrics: {
        itlMs: itl ?? 0,
        ttftMs: ttft ?? 0,
        throughputTokensPerSec: throughput ?? 0,
        p99LatencyMs: p99Latency ?? 0,
        concurrencyLevel,
      },
      errors,
      rawValues,
    };
  }

  return {
    success: true,
    metrics: {
      itlMs: itl ?? 0,
      ttftMs: ttft ?? 0,
      throughputTokensPerSec: throughput ?? 0,
      p99LatencyMs: p99Latency ?? 0,
      concurrencyLevel,
    },
    errors,
    rawValues,
  };
}

/**
 * Attempts to parse the output as JSON and extract metrics from it.
 *
 * vllm bench serve can output JSON when configured to do so.
 * The JSON output may contain nested metric objects.
 *
 * @param output - Raw output string
 * @param concurrencyLevel - The concurrency level
 * @returns Parse result if JSON parsing succeeds, null otherwise
 */
function tryParseJsonOutput(
  output: string,
  concurrencyLevel: number,
): BenchmarkOutputParseResult | null {
  // Look for JSON blocks in the output
  const jsonMatch = output.match(/\{[\s\S]*"mean_itl_ms"[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const data = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const rawValues: Record<string, number> = {};
    const errors: string[] = [];

    const itl = extractNumber(data, ['mean_itl_ms', 'avg_itl_ms', 'itl_ms']);
    const ttft = extractNumber(data, ['mean_ttft_ms', 'avg_ttft_ms', 'ttft_ms']);
    const throughput = extractNumber(data, [
      'output_throughput',
      'throughput',
      'tokens_per_second',
    ]);
    const p99Latency = extractNumber(data, [
      'p99_itl_ms',
      'p99_latency_ms',
      'p99_ttft_ms',
    ]);

    if (itl !== null) rawValues['itl'] = itl;
    if (ttft !== null) rawValues['ttft'] = ttft;
    if (throughput !== null) rawValues['throughput'] = throughput;
    if (p99Latency !== null) rawValues['p99Latency'] = p99Latency;

    if (itl === null) errors.push('JSON: missing ITL metric');
    if (throughput === null) errors.push('JSON: missing throughput metric');

    const hasMinimumMetrics = itl !== null && throughput !== null;

    return {
      success: hasMinimumMetrics,
      metrics: {
        itlMs: itl ?? 0,
        ttftMs: ttft ?? 0,
        throughputTokensPerSec: throughput ?? 0,
        p99LatencyMs: p99Latency ?? 0,
        concurrencyLevel,
      },
      errors,
      rawValues,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts a numeric metric from the output text using a list of regex patterns.
 * Returns the first match found.
 *
 * @param output - Raw text output
 * @param patterns - Array of regex patterns to try
 * @param _metricName - Name of the metric (for logging)
 * @returns The extracted numeric value, or null if no pattern matched
 */
function extractMetric(
  output: string,
  patterns: RegExp[],
  _metricName: string,
): number | null {
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      const value = parseFloat(match[1]);
      if (!isNaN(value) && isFinite(value)) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Extracts a numeric value from a JSON object by trying multiple key names.
 *
 * @param data - The JSON object
 * @param keys - Array of key names to try
 * @returns The numeric value, or null if not found
 */
function extractNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
      return value;
    }
  }
  return null;
}
