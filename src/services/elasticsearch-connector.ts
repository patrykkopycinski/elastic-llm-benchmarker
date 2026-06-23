import type { Connector } from './connector.js';
import type { BenchmarkResult } from '../types/benchmark.js';
import type { RecommendationReport } from '../types/recommendation.js';
import type { Stage2Result, Stage3Result } from '../scheduler/pipeline-state.js';
import type { ElasticsearchResultsStore } from './elasticsearch-results-store.js';
import { createLogger } from '../utils/logger.js';

/**
 * ElasticsearchConnector wraps the existing ElasticsearchResultsStore
 * to conform to the Connector interface. This is the default connector
 * for Elastic-internal use.
 */
export class ElasticsearchConnector implements Connector {
  readonly type = 'elasticsearch';
  private readonly store: ElasticsearchResultsStore;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(store: ElasticsearchResultsStore, logLevel?: string) {
    this.store = store;
    this.logger = createLogger(logLevel ?? 'info');
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.store.initialize();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  async saveBenchmarkResult(result: BenchmarkResult): Promise<{ success: boolean; error?: string }> {
    try {
      await this.store.save(result);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to save benchmark result via ES connector', { error: message });
      return { success: false, error: message };
    }
  }

  async saveRecommendationReport(report: RecommendationReport): Promise<{ success: boolean; error?: string }> {
    try {
      await this.store.saveRecommendationReport(report);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to save recommendation report via ES connector', { error: message });
      return { success: false, error: message };
    }
  }

  async saveStage2Result(result: Stage2Result): Promise<{ success: boolean; error?: string }> {
    try {
      await this.store.saveStage2Result(result);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to save stage2 result via ES connector', { error: message });
      return { success: false, error: message };
    }
  }

  async saveStage3Result(result: Stage3Result): Promise<{ success: boolean; error?: string }> {
    try {
      await this.store.saveReasoningResult(result);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Failed to save stage3 result via ES connector', { error: message });
      return { success: false, error: message };
    }
  }

  async close(): Promise<void> {
    this.logger.info('ElasticsearchConnector closed');
  }
}
