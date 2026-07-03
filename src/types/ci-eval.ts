/**
 * CI evaluation result stored in Elasticsearch.
 * One document per Buildkite eval build triggered by the benchmarker.
 */
export interface CIEvalResult {
  runId: string;
  modelId: string;
  buildkiteBuildUrl: string;
  buildkiteBuildNumber: number;
  pipelineSlug: string;
  status: 'passed' | 'failed' | 'error' | 'running';
  /**
   * Raw Buildkite terminal state (`passed|failed|canceled|skipped|not_run`) at the time this
   * row was persisted. Lets resume distinguish an infra outcome (skipped/canceled — the eval
   * never ran, so the suite must be re-run) from a genuine eval `failed` (a real verdict that
   * should NOT be re-run). Absent on older rows.
   */
  buildkiteState?: string;
  evalSuites: string[];
  scores?: Record<string, number>;
  artifacts?: Record<string, string>;
  startedAt: string;
  completedAt: string;
  retryCount: number;
  connectorJson: string;
}
