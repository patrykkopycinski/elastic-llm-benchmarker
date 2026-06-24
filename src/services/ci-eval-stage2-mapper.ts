import type { Stage2Result } from '../scheduler/pipeline-state.js';
import type { BuildkiteBuildResult } from './buildkite-eval-trigger.js';

export interface EvalArtifactSummary {
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  passRate?: number;
  cases?: Array<{ name: string; status: string; error?: string }>;
}

/**
 * Map a completed Buildkite on-demand eval build to the pipeline Stage2Result shape.
 * Real Kibana @kbn/evals runs are the source of truth when buildkite.enabled.
 */
export function mapBuildkiteResultToStage2(
  runId: string,
  modelId: string,
  evalSuites: string[],
  buildResult: BuildkiteBuildResult,
  artifactSummary?: EvalArtifactSummary,
  startedAt?: string,
): Stage2Result {
  const now = new Date().toISOString();
  const suite = evalSuites[0] ?? 'kibana-ci-eval';

  const passRate =
    artifactSummary?.passRate ??
    (artifactSummary?.total && artifactSummary.total > 0
      ? (artifactSummary.passed ?? 0) / artifactSummary.total
      : buildResult.status === 'passed'
        ? 1
        : 0);

  const suiteResults: NonNullable<Stage2Result['suiteResults']> = [];

  if (artifactSummary?.cases && artifactSummary.cases.length > 0) {
    for (const c of artifactSummary.cases) {
      const passed = c.status === 'passed' || c.status === 'pass';
      suiteResults.push({
        suite: c.name,
        status: passed ? 'pass' : 'fail',
        score: passed ? 1 : 0,
        error: c.error,
      });
    }
  } else {
    suiteResults.push({
      suite,
      status: buildResult.status === 'passed' ? 'pass' : 'fail',
      score: passRate,
      error:
        buildResult.status === 'failed'
          ? `Buildkite eval build #${buildResult.buildNumber} failed`
          : undefined,
    });
  }

  const status =
    buildResult.status === 'passed'
      ? 'success'
      : buildResult.status === 'running'
        ? 'failed'
        : 'failed';

  const scores: Record<string, number> = { [suite]: passRate };

  return {
    runId,
    modelId,
    status,
    scores,
    suiteResults,
    reason:
      buildResult.status === 'running'
        ? 'Buildkite eval poll timed out before completion'
        : buildResult.status === 'failed'
          ? `Kibana CI eval failed (build #${buildResult.buildNumber})`
          : undefined,
    startedAt: startedAt ?? now,
    completedAt: now,
  };
}

/**
 * Best-effort parse of eval summary JSON from Buildkite artifacts.
 * Supports @kbn/evals junit-style summaries and plain JSON tallies.
 */
export function parseEvalArtifactJson(raw: string): EvalArtifactSummary | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;

      if (Array.isArray(o['tests'])) {
        const cases = o['tests'] as Array<Record<string, unknown>>;
        const passed = cases.filter((t) => t['status'] === 'passed' || t['status'] === 'pass').length;
        const failed = cases.filter((t) => t['status'] === 'failed' || t['status'] === 'fail').length;
        const total = cases.length;
        return {
          total,
          passed,
          failed,
          passRate: total > 0 ? passed / total : 0,
          cases: cases.map((t) => ({
            name: String(t['name'] ?? t['title'] ?? 'unknown'),
            status: String(t['status'] ?? 'unknown'),
            error: typeof t['error'] === 'string' ? t['error'] : undefined,
          })),
        };
      }

      const total = typeof o['total'] === 'number' ? o['total'] : undefined;
      const passed = typeof o['passed'] === 'number' ? o['passed'] : undefined;
      const failed = typeof o['failed'] === 'number' ? o['failed'] : undefined;
      if (total !== undefined && passed !== undefined) {
        return {
          total,
          passed,
          failed,
          passRate: total > 0 ? passed / total : 0,
        };
      }
    }
  } catch {
    // not JSON
  }
  return undefined;
}
