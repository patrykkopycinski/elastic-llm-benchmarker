import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connector } from './connector.js';
import type { BenchmarkResult } from '../types/benchmark.js';
import type { RecommendationReport } from '../types/recommendation.js';
import type { Stage2Result, Stage3Result } from '../scheduler/pipeline-state.js';
import { createLogger } from '../utils/logger.js';

/**
 * LocalConnector stores benchmark results as JSON files on disk.
 *
 * Designed for external users who want to run the benchmarker without
 * an Elasticsearch cluster. Results are written to a local directory
 * in a structured format that can be consumed by any tool.
 */
export class LocalConnector implements Connector {
  readonly type = 'local';
  private readonly outputDir: string;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(options: { outputDir: string; logLevel?: string }) {
    this.outputDir = options.outputDir;
    this.logger = createLogger(options.logLevel ?? 'info');
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    try {
      mkdirSync(join(this.outputDir, 'benchmarks'), { recursive: true });
      mkdirSync(join(this.outputDir, 'recommendations'), { recursive: true });
      mkdirSync(join(this.outputDir, 'stage2'), { recursive: true });
      mkdirSync(join(this.outputDir, 'stage3'), { recursive: true });
      this.logger.info('LocalConnector initialized', { outputDir: this.outputDir });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  async saveBenchmarkResult(result: BenchmarkResult): Promise<{ success: boolean; error?: string }> {
    return this.writeJson(
      join(this.outputDir, 'benchmarks', `${this.sanitize(result.modelId)}_${result.timestamp}.json`),
      result,
    );
  }

  async saveRecommendationReport(report: RecommendationReport): Promise<{ success: boolean; error?: string }> {
    const path = join(this.outputDir, 'recommendations', `${report.reportId}.json`);
    const result = this.writeJson(path, report);

    const latestPath = join(this.outputDir, 'recommendations', `${this.sanitize(report.modelId)}_latest.json`);
    this.writeJson(latestPath, report);

    this.appendToIndex(join(this.outputDir, 'recommendations', 'index.jsonl'), {
      reportId: report.reportId,
      modelId: report.modelId,
      verdict: report.verdict,
      confidence: report.confidence,
      evaluatedAt: report.evaluatedAt,
    });

    return result;
  }

  async saveStage2Result(result: Stage2Result): Promise<{ success: boolean; error?: string }> {
    return this.writeJson(
      join(this.outputDir, 'stage2', `${result.runId}.json`),
      result,
    );
  }

  async saveStage3Result(result: Stage3Result): Promise<{ success: boolean; error?: string }> {
    return this.writeJson(
      join(this.outputDir, 'stage3', `${result.runId}.json`),
      result,
    );
  }

  async close(): Promise<void> {
    this.logger.info('LocalConnector closed');
  }

  private writeJson(path: string, data: unknown): { success: boolean; error?: string } {
    try {
      writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
      this.logger.debug('Wrote file', { path });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to write file', { path, error: message });
      return { success: false, error: message };
    }
  }

  private appendToIndex(path: string, entry: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf-8') + line : line, 'utf-8');
    } catch {
      // index append is best-effort
    }
  }

  private sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  }
}
