import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BenchmarkResult, BenchmarkMetrics, ToolCallResult } from '../types/benchmark.js';
import type { BenchmarkThresholds } from '../types/config.js';
import { resolveMaxITLMs } from '../types/config.js';
import { getModelParamsBillions } from './gpu-requirements.js';
import { createLogger } from '../utils/logger.js';

/**
 * Query filter options for retrieving benchmark results
 */
export interface ResultsQueryOptions {
  /** Filter by model ID (exact match) */
  modelId?: string;
  /** Filter by vLLM version */
  vllmVersion?: string;
  /** Filter results after this timestamp (ISO 8601) */
  after?: string;
  /** Filter results before this timestamp (ISO 8601) */
  before?: string;
  /** Filter by pass/fail status */
  passed?: boolean;
  /** Filter by GPU type */
  gpuType?: string;
  /** Filter by hardware profile ID */
  hardwareProfileId?: string;
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip (for pagination) */
  offset?: number;
  /** Sort order: 'asc' or 'desc' by timestamp */
  orderBy?: 'asc' | 'desc';
}

/**
 * Summary statistics for a model's benchmark history
 */
export interface ModelBenchmarkSummary {
  modelId: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  lastRunTimestamp: string;
  lastPassed: boolean;
  avgItlMs: number | null;
  avgThroughput: number | null;
  avgToolCallSuccessRate: number | null;
}

/**
 * Re-evaluates a single benchmark result against tiered ITL thresholds.
 * Returns the new passed status and rejection reasons (same logic as BenchmarkRunnerService).
 */
export function evaluateWithTieredThresholds(
  result: BenchmarkResult,
  thresholds: BenchmarkThresholds,
): { passed: boolean; rejectionReasons: string[] } {
  const reasons: string[] = [];
  const paramBillions = getModelParamsBillions(result.modelId);
  const maxITLMs = resolveMaxITLMs(thresholds, paramBillions);
  const metrics = result.benchmarkMetrics;

  if (metrics.length === 0) {
    return { passed: false, rejectionReasons: ['No benchmark metrics'] };
  }

  const singleUserRun = metrics.find((m) => m.concurrencyLevel === 1);
  if (singleUserRun && singleUserRun.itlMs > maxITLMs) {
    reasons.push(
      `ITL at concurrency=1 (${singleUserRun.itlMs.toFixed(2)}ms) exceeds threshold (${maxITLMs}ms)`,
    );
  }

  const maxP99Ms = maxITLMs * 10;
  for (const m of metrics) {
    if (m.p99LatencyMs > maxP99Ms) {
      reasons.push(
        `P99 latency at concurrency=${m.concurrencyLevel} (${m.p99LatencyMs.toFixed(2)}ms) exceeds threshold (${maxP99Ms}ms)`,
      );
    }
  }

  return {
    passed: reasons.length === 0,
    rejectionReasons: reasons,
  };
}

/**
 * SQLite-backed storage service for benchmark results.
 *
 * Provides persistent storage with full querying capabilities,
 * de-duplication support, and historical result tracking.
 */
export class ResultsStore {
  private db: Database.Database;
  private readonly logger;

  /**
   * Creates a new ResultsStore instance.
   *
   * @param dbPath - Path to the SQLite database file. Use ':memory:' for in-memory storage.
   * @param logLevel - Winston log level (default: 'info')
   */
  constructor(dbPath: string, logLevel: string = 'info') {
    this.logger = createLogger(logLevel);

    // Ensure parent directory exists for file-based databases
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.info(`Created results directory: ${dir}`);
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initializeSchema();
    this.logger.info(`ResultsStore initialized at ${dbPath}`);
  }

  /**
   * Creates the database schema if it doesn't already exist.
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        vllm_version TEXT NOT NULL,
        docker_command TEXT NOT NULL,
        gpu_type TEXT NOT NULL,
        gpu_count INTEGER NOT NULL,
        ram_gb INTEGER NOT NULL,
        cpu_cores INTEGER NOT NULL,
        disk_gb INTEGER NOT NULL DEFAULT 0,
        machine_type TEXT NOT NULL DEFAULT '',
        hardware_profile_id TEXT,
        passed INTEGER NOT NULL,
        rejection_reasons TEXT NOT NULL DEFAULT '[]',
        tensor_parallel_size INTEGER NOT NULL,
        tool_call_parser TEXT NOT NULL,
        raw_output TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(model_id, vllm_version, timestamp)
      );

      CREATE TABLE IF NOT EXISTS benchmark_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id INTEGER NOT NULL,
        itl_ms REAL NOT NULL,
        ttft_ms REAL NOT NULL,
        throughput_tokens_per_sec REAL NOT NULL,
        p99_latency_ms REAL NOT NULL,
        concurrency_level INTEGER NOT NULL,
        FOREIGN KEY (result_id) REFERENCES benchmark_results(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_call_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id INTEGER NOT NULL UNIQUE,
        supports_parallel_calls INTEGER NOT NULL,
        max_concurrent_calls INTEGER NOT NULL,
        avg_tool_call_latency_ms REAL NOT NULL,
        success_rate REAL NOT NULL,
        total_tests INTEGER NOT NULL,
        FOREIGN KEY (result_id) REFERENCES benchmark_results(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_results_model_id ON benchmark_results(model_id);
      CREATE INDEX IF NOT EXISTS idx_results_timestamp ON benchmark_results(timestamp);
      CREATE INDEX IF NOT EXISTS idx_results_vllm_version ON benchmark_results(vllm_version);
      CREATE INDEX IF NOT EXISTS idx_results_passed ON benchmark_results(passed);
      CREATE INDEX IF NOT EXISTS idx_results_gpu_type ON benchmark_results(gpu_type);
      CREATE INDEX IF NOT EXISTS idx_results_hardware_profile_id ON benchmark_results(hardware_profile_id);
      CREATE INDEX IF NOT EXISTS idx_metrics_result_id ON benchmark_metrics(result_id);
    `);
  }

  /**
   * Stores a complete benchmark result.
   *
   * @param result - The benchmark result to store
   * @returns The auto-generated ID of the stored result
   */
  save(result: BenchmarkResult): number {
    const insertResult = this.db.prepare(`
      INSERT INTO benchmark_results (
        model_id, timestamp, vllm_version, docker_command,
        gpu_type, gpu_count, ram_gb, cpu_cores,
        disk_gb, machine_type, hardware_profile_id,
        passed, rejection_reasons, tensor_parallel_size,
        tool_call_parser, raw_output
      ) VALUES (
        @modelId, @timestamp, @vllmVersion, @dockerCommand,
        @gpuType, @gpuCount, @ramGb, @cpuCores,
        @diskGb, @machineType, @hardwareProfileId,
        @passed, @rejectionReasons, @tensorParallelSize,
        @toolCallParser, @rawOutput
      )
    `);

    const insertMetrics = this.db.prepare(`
      INSERT INTO benchmark_metrics (
        result_id, itl_ms, ttft_ms, throughput_tokens_per_sec,
        p99_latency_ms, concurrency_level
      ) VALUES (
        @resultId, @itlMs, @ttftMs, @throughputTokensPerSec,
        @p99LatencyMs, @concurrencyLevel
      )
    `);

    const insertToolCall = this.db.prepare(`
      INSERT INTO tool_call_results (
        result_id, supports_parallel_calls, max_concurrent_calls,
        avg_tool_call_latency_ms, success_rate, total_tests
      ) VALUES (
        @resultId, @supportsParallelCalls, @maxConcurrentCalls,
        @avgToolCallLatencyMs, @successRate, @totalTests
      )
    `);

    const transaction = this.db.transaction((res: BenchmarkResult) => {
      const info = insertResult.run({
        modelId: res.modelId,
        timestamp: res.timestamp,
        vllmVersion: res.vllmVersion,
        dockerCommand: res.dockerCommand,
        gpuType: res.hardwareConfig.gpuType,
        gpuCount: res.hardwareConfig.gpuCount,
        ramGb: res.hardwareConfig.ramGb,
        cpuCores: res.hardwareConfig.cpuCores,
        diskGb: res.hardwareConfig.diskGb,
        machineType: res.hardwareConfig.machineType,
        hardwareProfileId: res.hardwareConfig.hardwareProfileId ?? null,
        passed: res.passed ? 1 : 0,
        rejectionReasons: JSON.stringify(res.rejectionReasons),
        tensorParallelSize: res.tensorParallelSize,
        toolCallParser: res.toolCallParser,
        rawOutput: res.rawOutput,
      });

      const resultId = info.lastInsertRowid as number;

      for (const metric of res.benchmarkMetrics) {
        insertMetrics.run({
          resultId,
          itlMs: metric.itlMs,
          ttftMs: metric.ttftMs,
          throughputTokensPerSec: metric.throughputTokensPerSec,
          p99LatencyMs: metric.p99LatencyMs,
          concurrencyLevel: metric.concurrencyLevel,
        });
      }

      if (res.toolCallResults) {
        insertToolCall.run({
          resultId,
          supportsParallelCalls: res.toolCallResults.supportsParallelCalls ? 1 : 0,
          maxConcurrentCalls: res.toolCallResults.maxConcurrentCalls,
          avgToolCallLatencyMs: res.toolCallResults.avgToolCallLatencyMs,
          successRate: res.toolCallResults.successRate,
          totalTests: res.toolCallResults.totalTests,
        });
      }

      return resultId;
    });

    const resultId = transaction(result);
    this.logger.info(`Stored benchmark result for ${result.modelId}`, { resultId });
    return resultId;
  }

  /**
   * Retrieves a single benchmark result by its ID.
   *
   * @param id - The result ID
   * @returns The benchmark result, or null if not found
   */
  getById(id: number): BenchmarkResult | null {
    const row = this.db.prepare('SELECT * FROM benchmark_results WHERE id = ?').get(id) as
      | ResultRow
      | undefined;

    if (!row) {
      return null;
    }

    return this.hydrateResult(row);
  }

  /**
   * Queries benchmark results with optional filters.
   *
   * @param options - Query filter options
   * @returns Array of matching benchmark results
   */
  query(options: ResultsQueryOptions = {}): BenchmarkResult[] {
    const { sql, params } = this.buildQuerySQL(options);

    const rows = this.db.prepare(sql).all(...params) as ResultRow[];
    return rows.map((row) => this.hydrateResult(row));
  }

  /**
   * Checks whether a model has already been benchmarked with the given
   * vLLM version and hardware configuration.
   *
   * @param modelId - The HuggingFace model ID
   * @param vllmVersion - The vLLM version
   * @param gpuType - The GPU type
   * @returns true if a result already exists
   */
  hasResult(modelId: string, vllmVersion: string, gpuType: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM benchmark_results
         WHERE model_id = ? AND vllm_version = ? AND gpu_type = ?`,
      )
      .get(modelId, vllmVersion, gpuType) as { count: number };

    return row.count > 0;
  }

  /**
   * Retrieves all model IDs that have been benchmarked.
   *
   * @returns Array of unique model IDs
   */
  getEvaluatedModelIds(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT model_id FROM benchmark_results ORDER BY model_id')
      .all() as { model_id: string }[];

    return rows.map((row) => row.model_id);
  }

  /**
   * Retrieves the latest benchmark result for a given model.
   *
   * @param modelId - The HuggingFace model ID
   * @returns The latest result, or null if none exists
   */
  getLatestForModel(modelId: string): BenchmarkResult | null {
    const row = this.db
      .prepare(
        `SELECT * FROM benchmark_results
         WHERE model_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(modelId) as ResultRow | undefined;

    if (!row) {
      return null;
    }

    return this.hydrateResult(row);
  }

  /**
   * Returns summary statistics for a model's benchmark history.
   *
   * @param modelId - The HuggingFace model ID
   * @returns Summary statistics, or null if no results exist
   */
  getModelSummary(modelId: string): ModelBenchmarkSummary | null {
    const summaryRow = this.db
      .prepare(
        `SELECT
          model_id,
          COUNT(*) as total_runs,
          SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed_runs,
          SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed_runs,
          MAX(timestamp) as last_run_timestamp
        FROM benchmark_results
        WHERE model_id = ?
        GROUP BY model_id`,
      )
      .get(modelId) as SummaryRow | undefined;

    if (!summaryRow) {
      return null;
    }

    // Get the latest result's passed status
    const latestRow = this.db
      .prepare(
        `SELECT passed FROM benchmark_results
         WHERE model_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(modelId) as { passed: number } | undefined;

    // Get average metrics across all concurrency levels and runs
    const metricsRow = this.db
      .prepare(
        `SELECT
          AVG(bm.itl_ms) as avg_itl_ms,
          AVG(bm.throughput_tokens_per_sec) as avg_throughput
        FROM benchmark_metrics bm
        JOIN benchmark_results br ON bm.result_id = br.id
        WHERE br.model_id = ?`,
      )
      .get(modelId) as { avg_itl_ms: number | null; avg_throughput: number | null } | undefined;

    // Get average tool call success rate
    const toolCallRow = this.db
      .prepare(
        `SELECT AVG(tc.success_rate) as avg_success_rate
        FROM tool_call_results tc
        JOIN benchmark_results br ON tc.result_id = br.id
        WHERE br.model_id = ?`,
      )
      .get(modelId) as { avg_success_rate: number | null } | undefined;

    return {
      modelId: summaryRow.model_id,
      totalRuns: summaryRow.total_runs,
      passedRuns: summaryRow.passed_runs,
      failedRuns: summaryRow.failed_runs,
      lastRunTimestamp: summaryRow.last_run_timestamp,
      lastPassed: latestRow?.passed === 1,
      avgItlMs: metricsRow?.avg_itl_ms ?? null,
      avgThroughput: metricsRow?.avg_throughput ?? null,
      avgToolCallSuccessRate: toolCallRow?.avg_success_rate ?? null,
    };
  }

  /**
   * Returns the total count of stored benchmark results,
   * optionally filtered by pass/fail status.
   *
   * @param passed - Optional filter by pass/fail
   * @returns The count of matching results
   */
  count(passed?: boolean): number {
    if (passed !== undefined) {
      const row = this.db
        .prepare('SELECT COUNT(*) as count FROM benchmark_results WHERE passed = ?')
        .get(passed ? 1 : 0) as { count: number };
      return row.count;
    }

    const row = this.db.prepare('SELECT COUNT(*) as count FROM benchmark_results').get() as {
      count: number;
    };
    return row.count;
  }

  /**
   * Updates the passed status and rejection reasons for an existing result.
   * Used when re-evaluating stored results against updated (e.g. tiered) thresholds.
   *
   * @param id - The result ID to update
   * @param passed - New pass/fail status
   * @param rejectionReasons - New rejection reasons (JSON array of strings)
   * @returns true if a row was updated
   */
  updatePassedStatus(id: number, passed: boolean, rejectionReasons: string[]): boolean {
    const info = this.db
      .prepare(
        'UPDATE benchmark_results SET passed = ?, rejection_reasons = ? WHERE id = ?',
      )
      .run(passed ? 1 : 0, JSON.stringify(rejectionReasons), id);
    return info.changes > 0;
  }

  /**
   * Re-evaluates all stored benchmark results against tiered ITL thresholds
   * and updates each result's passed status and rejection reasons.
   *
   * @param thresholds - Benchmark threshold config (uses maxITLMsTiers + maxITLMs fallback)
   * @returns Counts of updated results and how many now pass vs fail
   */
  reevaluateAllWithTieredThresholds(thresholds: BenchmarkThresholds): {
    updated: number;
    nowPassed: number;
    nowFailed: number;
  } {
    const rows = this.db
      .prepare('SELECT id FROM benchmark_results')
      .all() as { id: number }[];
    let nowPassed = 0;
    let nowFailed = 0;

    for (const { id } of rows) {
      const result = this.getById(id);
      if (!result) continue;

      const { passed, rejectionReasons } = evaluateWithTieredThresholds(result, thresholds);
      this.updatePassedStatus(id, passed, rejectionReasons);
      if (passed) nowPassed++;
      else nowFailed++;
    }

    this.logger.info('Re-evaluated all results with tiered ITL thresholds', {
      updated: rows.length,
      nowPassed,
      nowFailed,
    });

    return { updated: rows.length, nowPassed, nowFailed };
  }

  /**
   * Deletes a benchmark result and its associated metrics by ID.
   *
   * @param id - The result ID to delete
   * @returns true if a result was deleted
   */
  delete(id: number): boolean {
    const info = this.db.prepare('DELETE FROM benchmark_results WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * Exports all results as a JSON-serializable array.
   *
   * @returns Array of all benchmark results
   */
  exportAll(): BenchmarkResult[] {
    return this.query({ orderBy: 'asc' });
  }

  /**
   * Imports benchmark results from a JSON array, skipping duplicates.
   *
   * @param results - Array of benchmark results to import
   * @returns Number of successfully imported results
   */
  importResults(results: BenchmarkResult[]): number {
    let imported = 0;
    const transaction = this.db.transaction((items: BenchmarkResult[]) => {
      for (const result of items) {
        try {
          this.save(result);
          imported++;
        } catch (err) {
          // Skip duplicates (UNIQUE constraint violations)
          if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
            this.logger.debug(`Skipping duplicate result for ${result.modelId}`);
          } else {
            throw err;
          }
        }
      }
    });

    transaction(results);
    this.logger.info(`Imported ${imported} of ${results.length} results`);
    return imported;
  }

  /**
   * Closes the database connection. Should be called when the store is no longer needed.
   */
  close(): void {
    this.db.close();
    this.logger.info('ResultsStore closed');
  }

  /**
   * Builds a SQL query string and parameter array from query options.
   */
  private buildQuerySQL(options: ResultsQueryOptions): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.modelId !== undefined) {
      conditions.push('model_id = ?');
      params.push(options.modelId);
    }

    if (options.vllmVersion !== undefined) {
      conditions.push('vllm_version = ?');
      params.push(options.vllmVersion);
    }

    if (options.after !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(options.after);
    }

    if (options.before !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(options.before);
    }

    if (options.passed !== undefined) {
      conditions.push('passed = ?');
      params.push(options.passed ? 1 : 0);
    }

    if (options.gpuType !== undefined) {
      conditions.push('gpu_type = ?');
      params.push(options.gpuType);
    }

    if (options.hardwareProfileId !== undefined) {
      conditions.push('hardware_profile_id = ?');
      params.push(options.hardwareProfileId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = `ORDER BY timestamp ${options.orderBy === 'asc' ? 'ASC' : 'DESC'}`;
    const limit = options.limit !== undefined ? `LIMIT ?` : '';
    const offset = options.offset !== undefined ? `OFFSET ?` : '';

    if (options.limit !== undefined) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const sql = `SELECT * FROM benchmark_results ${where} ${orderBy} ${limit} ${offset}`.trim();
    return { sql, params };
  }

  /**
   * Hydrates a raw database row into a full BenchmarkResult object,
   * including associated metrics and tool call results.
   */
  private hydrateResult(row: ResultRow): BenchmarkResult {
    const metrics = this.db
      .prepare(
        `SELECT itl_ms, ttft_ms, throughput_tokens_per_sec,
                p99_latency_ms, concurrency_level
         FROM benchmark_metrics WHERE result_id = ?
         ORDER BY concurrency_level ASC`,
      )
      .all(row.id) as MetricRow[];

    const toolCall = this.db
      .prepare(
        `SELECT supports_parallel_calls, max_concurrent_calls,
                avg_tool_call_latency_ms, success_rate, total_tests
         FROM tool_call_results WHERE result_id = ?`,
      )
      .get(row.id) as ToolCallRow | undefined;

    return {
      modelId: row.model_id,
      timestamp: row.timestamp,
      vllmVersion: row.vllm_version,
      dockerCommand: row.docker_command,
      hardwareConfig: {
        gpuType: row.gpu_type,
        gpuCount: row.gpu_count,
        ramGb: row.ram_gb,
        cpuCores: row.cpu_cores,
        diskGb: row.disk_gb,
        machineType: row.machine_type,
        hardwareProfileId: row.hardware_profile_id,
      },
      benchmarkMetrics: metrics.map(
        (m): BenchmarkMetrics => ({
          itlMs: m.itl_ms,
          ttftMs: m.ttft_ms,
          throughputTokensPerSec: m.throughput_tokens_per_sec,
          p99LatencyMs: m.p99_latency_ms,
          concurrencyLevel: m.concurrency_level,
        }),
      ),
      toolCallResults: toolCall
        ? ({
          supportsParallelCalls: toolCall.supports_parallel_calls === 1,
          maxConcurrentCalls: toolCall.max_concurrent_calls,
          avgToolCallLatencyMs: toolCall.avg_tool_call_latency_ms,
          successRate: toolCall.success_rate,
          totalTests: toolCall.total_tests,
        } satisfies ToolCallResult)
        : null,
      passed: row.passed === 1,
      rejectionReasons: JSON.parse(row.rejection_reasons) as string[],
      tensorParallelSize: row.tensor_parallel_size,
      toolCallParser: row.tool_call_parser,
      rawOutput: row.raw_output,
    };
  }
}

// ─── Internal Row Types ──────────────────────────────────────────────────────

interface ResultRow {
  id: number;
  model_id: string;
  timestamp: string;
  vllm_version: string;
  docker_command: string;
  gpu_type: string;
  gpu_count: number;
  ram_gb: number;
  cpu_cores: number;
  disk_gb: number;
  machine_type: string;
  hardware_profile_id: string | null;
  passed: number;
  rejection_reasons: string;
  tensor_parallel_size: number;
  tool_call_parser: string;
  raw_output: string;
  created_at: string;
}

interface MetricRow {
  itl_ms: number;
  ttft_ms: number;
  throughput_tokens_per_sec: number;
  p99_latency_ms: number;
  concurrency_level: number;
}

interface ToolCallRow {
  supports_parallel_calls: number;
  max_concurrent_calls: number;
  avg_tool_call_latency_ms: number;
  success_rate: number;
  total_tests: number;
}

interface SummaryRow {
  model_id: string;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  last_run_timestamp: string;
}
