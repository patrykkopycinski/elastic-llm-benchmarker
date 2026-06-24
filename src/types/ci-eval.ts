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
  evalSuites: string[];
  scores?: Record<string, number>;
  artifacts?: Record<string, string>;
  startedAt: string;
  completedAt: string;
  retryCount: number;
  connectorJson: string;
}
