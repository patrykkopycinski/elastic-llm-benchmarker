import type { BenchmarkResult } from '../types/benchmark.js';
import type { RecommendationReport } from '../types/recommendation.js';
import type { Stage2Result, Stage3Result } from '../scheduler/pipeline-state.js';

/**
 * Connector interface — abstracts the data destination for benchmark results.
 *
 * The benchmarker pipeline writes results through a Connector so external
 * users can plug in their own storage (local files, their own ES cluster,
 * a different cloud service) without modifying core pipeline code.
 */
export interface Connector {
  readonly type: string;

  initialize(): Promise<{ success: boolean; error?: string }>;

  saveBenchmarkResult(result: BenchmarkResult): Promise<{ success: boolean; error?: string }>;

  saveRecommendationReport(report: RecommendationReport): Promise<{ success: boolean; error?: string }>;

  saveStage2Result(result: Stage2Result): Promise<{ success: boolean; error?: string }>;

  saveStage3Result(result: Stage3Result): Promise<{ success: boolean; error?: string }>;

  close(): Promise<void>;
}
