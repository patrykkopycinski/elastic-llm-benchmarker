import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  KibanaEvalReport,
  KibanaEvalTaskResult,
  KibanaEvalClassification,
} from '../types/kibana-eval.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Query filter options for retrieving Kibana evaluation results.
 */
export interface KibanaEvalQueryOptions {
  /** Filter by model ID (exact match) */
  modelId?: string;
  /** Filter by connector ID */
  connectorId?: string;
  /** Filter by classification */
  classification?: KibanaEvalClassification;
  /** Filter results after this timestamp (ISO 8601) */
  after?: string;
  /** Filter results before this timestamp (ISO 8601) */
  before?: string;
  /** Maximum number of results to return */
  limit?: number;
  /** Number of results to skip (for pagination) */
  offset?: number;
  /** Sort order: 'asc' or 'desc' by timestamp */
  orderBy?: 'asc' | 'desc';
}

/**
 * Summary of a model's Kibana evaluation history.
 */
export interface KibanaEvalSummary {
  modelId: string;
  totalEvals: number;
  passCount: number;
  partialCount: number;
  failCount: number;
  lastEvalTimestamp: string;
  lastClassification: KibanaEvalClassification;
  lastPercentageScore: number;
  averagePercentageScore: number;
}

/**
 * Link between a benchmark result and its associated Kibana eval.
 */
export interface BenchmarkEvalLink {
  benchmarkResultId: number;
  kibanaEvalId: number;
  modelId: string;
  connectorId: string;
}

// ─── Internal Row Types ───────────────────────────────────────────────────────

interface EvalReportRow {
  id: number;
  model_id: string;
  connector_id: string;
  timestamp: string;
  classification: string;
  summary: string;
  percentage_score: number;
  total_score: number;
  max_score: number;
  total_weighted_score: number;
  max_weighted_score: number;
  passed_count: number;
  failed_count: number;
  skipped_count: number;
  errored_count: number;
  total_count: number;
  total_duration_ms: number;
  eval_config_json: string;
  created_at: string;
}

interface TaskResultRow {
  id: number;
  eval_id: number;
  task_id: string;
  task_name: string;
  task_category: string;
  task_severity: string;
  outcome: string;
  duration_ms: number;
  message: string;
  error: string | null;
  score: number;
  weighted_score: number;
  attempts: number;
  metadata_json: string;
}

interface SummaryRow {
  model_id: string;
  total_evals: number;
  pass_count: number;
  partial_count: number;
  fail_count: number;
  last_eval_timestamp: string;
}

// ─── Kibana Eval Store ────────────────────────────────────────────────────────

/**
 * SQLite-backed storage service for Kibana Agent builder evaluation results.
 *
 * Stores evaluation reports with individual task results, linked to
 * benchmark results for comprehensive model assessment tracking.
 *
 * @example
 * ```typescript
 * const store = new KibanaEvalStore('./data/eval-results.db');
 *
 * // Store an evaluation report
 * const evalId = store.saveReport(evalReport);
 *
 * // Link to a benchmark result
 * store.linkToBenchmark(evalId, benchmarkResultId);
 *
 * // Query by model
 * const reports = store.query({ modelId: 'meta-llama/Llama-3-70B' });
 * ```
 */
export class KibanaEvalStore {
  private db: Database.Database;
  private readonly logger;

  /**
   * Creates a new KibanaEvalStore instance.
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
        this.logger.info(`Created eval results directory: ${dir}`);
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initializeSchema();
    this.logger.info(`KibanaEvalStore initialized at ${dbPath}`);
  }

  /**
   * Creates the database schema if it doesn't already exist.
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kibana_eval_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        classification TEXT NOT NULL,
        summary TEXT NOT NULL,
        percentage_score REAL NOT NULL,
        total_score REAL NOT NULL,
        max_score REAL NOT NULL,
        total_weighted_score REAL NOT NULL,
        max_weighted_score REAL NOT NULL,
        passed_count INTEGER NOT NULL,
        failed_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL,
        errored_count INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        eval_config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(model_id, connector_id, timestamp)
      );

      CREATE TABLE IF NOT EXISTS kibana_eval_task_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eval_id INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        task_category TEXT NOT NULL,
        task_severity TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        message TEXT NOT NULL,
        error TEXT,
        score REAL NOT NULL,
        weighted_score REAL NOT NULL,
        attempts INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (eval_id) REFERENCES kibana_eval_reports(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS benchmark_eval_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        benchmark_result_id INTEGER NOT NULL,
        kibana_eval_id INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(benchmark_result_id, kibana_eval_id),
        FOREIGN KEY (kibana_eval_id) REFERENCES kibana_eval_reports(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_eval_reports_model_id ON kibana_eval_reports(model_id);
      CREATE INDEX IF NOT EXISTS idx_eval_reports_timestamp ON kibana_eval_reports(timestamp);
      CREATE INDEX IF NOT EXISTS idx_eval_reports_classification ON kibana_eval_reports(classification);
      CREATE INDEX IF NOT EXISTS idx_eval_task_results_eval_id ON kibana_eval_task_results(eval_id);
      CREATE INDEX IF NOT EXISTS idx_benchmark_eval_links_benchmark_id ON benchmark_eval_links(benchmark_result_id);
      CREATE INDEX IF NOT EXISTS idx_benchmark_eval_links_eval_id ON benchmark_eval_links(kibana_eval_id);
    `);
  }

  /**
   * Stores a complete Kibana evaluation report with all task results.
   *
   * @param report - The evaluation report to store
   * @returns The auto-generated ID of the stored report
   */
  saveReport(report: KibanaEvalReport): number {
    const insertReport = this.db.prepare(`
      INSERT INTO kibana_eval_reports (
        model_id, connector_id, timestamp, classification, summary,
        percentage_score, total_score, max_score,
        total_weighted_score, max_weighted_score,
        passed_count, failed_count, skipped_count, errored_count, total_count,
        total_duration_ms, eval_config_json
      ) VALUES (
        @modelId, @connectorId, @timestamp, @classification, @summary,
        @percentageScore, @totalScore, @maxScore,
        @totalWeightedScore, @maxWeightedScore,
        @passedCount, @failedCount, @skippedCount, @erroredCount, @totalCount,
        @totalDurationMs, @evalConfigJson
      )
    `);

    const insertTask = this.db.prepare(`
      INSERT INTO kibana_eval_task_results (
        eval_id, task_id, task_name, task_category, task_severity,
        outcome, duration_ms, message, error, score, weighted_score,
        attempts, metadata_json
      ) VALUES (
        @evalId, @taskId, @taskName, @taskCategory, @taskSeverity,
        @outcome, @durationMs, @message, @error, @score, @weightedScore,
        @attempts, @metadataJson
      )
    `);

    const transaction = this.db.transaction((r: KibanaEvalReport) => {
      const info = insertReport.run({
        modelId: r.modelId,
        connectorId: r.connectorId,
        timestamp: r.timestamp,
        classification: r.classification,
        summary: r.summary,
        percentageScore: r.scoring.percentageScore,
        totalScore: r.scoring.totalScore,
        maxScore: r.scoring.maxScore,
        totalWeightedScore: r.scoring.totalWeightedScore,
        maxWeightedScore: r.scoring.maxWeightedScore,
        passedCount: r.scoring.passedCount,
        failedCount: r.scoring.failedCount,
        skippedCount: r.scoring.skippedCount,
        erroredCount: r.scoring.erroredCount,
        totalCount: r.scoring.totalCount,
        totalDurationMs: r.totalDurationMs,
        evalConfigJson: JSON.stringify(r.evalConfig),
      });

      const evalId = info.lastInsertRowid as number;

      for (const taskResult of r.taskResults) {
        insertTask.run({
          evalId,
          taskId: taskResult.task.id,
          taskName: taskResult.task.name,
          taskCategory: taskResult.task.category,
          taskSeverity: taskResult.task.severity,
          outcome: taskResult.outcome,
          durationMs: taskResult.durationMs,
          message: taskResult.message,
          error: taskResult.error,
          score: taskResult.score,
          weightedScore: taskResult.weightedScore,
          attempts: taskResult.attempts,
          metadataJson: JSON.stringify(taskResult.metadata),
        });
      }

      return evalId;
    });

    const evalId = transaction(report);
    this.logger.info(`Stored Kibana eval report for ${report.modelId}`, {
      evalId,
      classification: report.classification,
    });
    return evalId;
  }

  /**
   * Links a Kibana evaluation report to a benchmark result.
   *
   * @param evalId - The Kibana evaluation report ID
   * @param benchmarkResultId - The benchmark result ID
   * @param modelId - The model ID
   * @param connectorId - The connector ID
   */
  linkToBenchmark(
    evalId: number,
    benchmarkResultId: number,
    modelId: string,
    connectorId: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO benchmark_eval_links
         (benchmark_result_id, kibana_eval_id, model_id, connector_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(benchmarkResultId, evalId, modelId, connectorId);

    this.logger.debug('Linked eval to benchmark', {
      evalId,
      benchmarkResultId,
    });
  }

  /**
   * Retrieves a single evaluation report by its ID.
   *
   * @param id - The report ID
   * @returns The evaluation report, or null if not found
   */
  getById(id: number): KibanaEvalReport | null {
    const row = this.db
      .prepare('SELECT * FROM kibana_eval_reports WHERE id = ?')
      .get(id) as EvalReportRow | undefined;

    if (!row) {
      return null;
    }

    return this.hydrateReport(row);
  }

  /**
   * Queries evaluation reports with optional filters.
   *
   * @param options - Query filter options
   * @returns Array of matching evaluation reports
   */
  query(options: KibanaEvalQueryOptions = {}): KibanaEvalReport[] {
    const { sql, params } = this.buildQuerySQL(options);
    const rows = this.db.prepare(sql).all(...params) as EvalReportRow[];
    return rows.map((row) => this.hydrateReport(row));
  }

  /**
   * Retrieves the latest evaluation report for a given model.
   *
   * @param modelId - The HuggingFace model ID
   * @returns The latest report, or null if none exists
   */
  getLatestForModel(modelId: string): KibanaEvalReport | null {
    const row = this.db
      .prepare(
        `SELECT * FROM kibana_eval_reports
         WHERE model_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(modelId) as EvalReportRow | undefined;

    if (!row) {
      return null;
    }

    return this.hydrateReport(row);
  }

  /**
   * Returns summary statistics for a model's Kibana evaluation history.
   *
   * @param modelId - The HuggingFace model ID
   * @returns Summary statistics, or null if no evaluations exist
   */
  getModelSummary(modelId: string): KibanaEvalSummary | null {
    const summaryRow = this.db
      .prepare(
        `SELECT
          model_id,
          COUNT(*) as total_evals,
          SUM(CASE WHEN classification = 'PASS' THEN 1 ELSE 0 END) as pass_count,
          SUM(CASE WHEN classification = 'PARTIAL' THEN 1 ELSE 0 END) as partial_count,
          SUM(CASE WHEN classification = 'FAIL' THEN 1 ELSE 0 END) as fail_count,
          MAX(timestamp) as last_eval_timestamp
        FROM kibana_eval_reports
        WHERE model_id = ?
        GROUP BY model_id`,
      )
      .get(modelId) as SummaryRow | undefined;

    if (!summaryRow) {
      return null;
    }

    // Get latest report for last classification and score
    const latestRow = this.db
      .prepare(
        `SELECT classification, percentage_score
         FROM kibana_eval_reports
         WHERE model_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(modelId) as
      | { classification: string; percentage_score: number }
      | undefined;

    // Get average score
    const avgRow = this.db
      .prepare(
        `SELECT AVG(percentage_score) as avg_score
         FROM kibana_eval_reports
         WHERE model_id = ?`,
      )
      .get(modelId) as { avg_score: number | null } | undefined;

    return {
      modelId: summaryRow.model_id,
      totalEvals: summaryRow.total_evals,
      passCount: summaryRow.pass_count,
      partialCount: summaryRow.partial_count,
      failCount: summaryRow.fail_count,
      lastEvalTimestamp: summaryRow.last_eval_timestamp,
      lastClassification:
        (latestRow?.classification as KibanaEvalClassification) ?? 'FAIL',
      lastPercentageScore: latestRow?.percentage_score ?? 0,
      averagePercentageScore: avgRow?.avg_score ?? 0,
    };
  }

  /**
   * Retrieves evaluation reports linked to a specific benchmark result.
   *
   * @param benchmarkResultId - The benchmark result ID
   * @returns Array of linked evaluation reports
   */
  getByBenchmarkResultId(benchmarkResultId: number): KibanaEvalReport[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM kibana_eval_reports r
         JOIN benchmark_eval_links l ON r.id = l.kibana_eval_id
         WHERE l.benchmark_result_id = ?
         ORDER BY r.timestamp DESC`,
      )
      .all(benchmarkResultId) as EvalReportRow[];

    return rows.map((row) => this.hydrateReport(row));
  }

  /**
   * Returns the total count of stored evaluation reports,
   * optionally filtered by classification.
   */
  count(classification?: KibanaEvalClassification): number {
    if (classification) {
      const row = this.db
        .prepare(
          'SELECT COUNT(*) as count FROM kibana_eval_reports WHERE classification = ?',
        )
        .get(classification) as { count: number };
      return row.count;
    }

    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM kibana_eval_reports')
      .get() as { count: number };
    return row.count;
  }

  /**
   * Deletes an evaluation report and its associated task results.
   *
   * @param id - The report ID to delete
   * @returns true if a report was deleted
   */
  delete(id: number): boolean {
    const info = this.db
      .prepare('DELETE FROM kibana_eval_reports WHERE id = ?')
      .run(id);
    return info.changes > 0;
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
    this.logger.info('KibanaEvalStore closed');
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private buildQuerySQL(options: KibanaEvalQueryOptions): {
    sql: string;
    params: unknown[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.modelId !== undefined) {
      conditions.push('model_id = ?');
      params.push(options.modelId);
    }

    if (options.connectorId !== undefined) {
      conditions.push('connector_id = ?');
      params.push(options.connectorId);
    }

    if (options.classification !== undefined) {
      conditions.push('classification = ?');
      params.push(options.classification);
    }

    if (options.after !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(options.after);
    }

    if (options.before !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(options.before);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = `ORDER BY timestamp ${options.orderBy === 'asc' ? 'ASC' : 'DESC'}`;
    const limit = options.limit !== undefined ? 'LIMIT ?' : '';
    const offset = options.offset !== undefined ? 'OFFSET ?' : '';

    if (options.limit !== undefined) {
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
    }

    const sql =
      `SELECT * FROM kibana_eval_reports ${where} ${orderBy} ${limit} ${offset}`.trim();
    return { sql, params };
  }

  /**
   * Hydrates a raw database row into a full KibanaEvalReport object,
   * including associated task results.
   */
  private hydrateReport(row: EvalReportRow): KibanaEvalReport {
    const taskRows = this.db
      .prepare(
        `SELECT * FROM kibana_eval_task_results
         WHERE eval_id = ?
         ORDER BY id ASC`,
      )
      .all(row.id) as TaskResultRow[];

    const taskResults: KibanaEvalTaskResult[] = taskRows.map((tr) => ({
      task: {
        id: tr.task_id,
        name: tr.task_name,
        description: '', // Not stored — can be recovered from task definitions
        category: tr.task_category as KibanaEvalTaskResult['task']['category'],
        severity: tr.task_severity as KibanaEvalTaskResult['task']['severity'],
        timeoutMs: 0, // Not stored — can be recovered from task definitions
        retryAttempts: 0, // Not stored — can be recovered from task definitions
      },
      outcome: tr.outcome as KibanaEvalTaskResult['outcome'],
      durationMs: tr.duration_ms,
      message: tr.message,
      error: tr.error,
      score: tr.score,
      weightedScore: tr.weighted_score,
      attempts: tr.attempts,
      metadata: JSON.parse(tr.metadata_json) as Record<string, unknown>,
    }));

    const failedTasks = taskResults.filter(
      (r) => r.outcome === 'FAIL' || r.outcome === 'ERROR',
    );

    return {
      modelId: row.model_id,
      connectorId: row.connector_id,
      timestamp: row.timestamp,
      classification: row.classification as KibanaEvalClassification,
      summary: row.summary,
      scoring: {
        totalScore: row.total_score,
        maxScore: row.max_score,
        totalWeightedScore: row.total_weighted_score,
        maxWeightedScore: row.max_weighted_score,
        percentageScore: row.percentage_score,
        passedCount: row.passed_count,
        failedCount: row.failed_count,
        skippedCount: row.skipped_count,
        erroredCount: row.errored_count,
        totalCount: row.total_count,
      },
      taskResults,
      failedTasks,
      totalDurationMs: row.total_duration_ms,
      evalConfig: JSON.parse(row.eval_config_json),
    };
  }
}
