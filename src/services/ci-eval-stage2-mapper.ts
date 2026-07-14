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
 * Build the Stage2Result for the "resume" fast-path, where every suite
 * already completed in a prior partial run and nothing needs to re-run.
 * Must set score: 1 (not leave it undefined) — elasticsearch-results-store
 * persists an undefined score as `null`, which recommendation-report-builder
 * then defaults to 0, turning an all-suites-passed resume into a false
 * "investigate"/"reject" verdict (regression: Qwen3-Next-80B-A3B 2026-07-06
 * resume run scored 0 on every suite despite Buildkite passing all of them).
 */
export function buildResumeStage2Result(
  runId: string,
  modelId: string,
  evalSuites: string[],
  startedAt: string,
): Stage2Result {
  return {
    runId,
    modelId,
    status: 'success',
    scores: Object.fromEntries(evalSuites.map((suite) => [suite, 1])),
    suiteResults: evalSuites.map((suite) => ({ suite, status: 'pass', score: 1 })),
    reason: 'All suites completed before resume',
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

/** Merge per-suite on-demand Buildkite results into one Stage2Result for the matrix. */
export function mergeStage2Results(results: Stage2Result[]): Stage2Result {
  if (results.length === 0) {
    throw new Error('mergeStage2Results requires at least one Stage2Result');
  }
  if (results.length === 1) {
    return results[0]!;
  }

  const first = results[0]!;
  const scores: Record<string, number> = {};
  const suiteResults: NonNullable<Stage2Result['suiteResults']> = [];
  for (const result of results) {
    if (result.scores) {
      Object.assign(scores, result.scores);
    }
    if (result.suiteResults) {
      suiteResults.push(...result.suiteResults);
    }
  }

  const failed = results.filter((r) => r.status !== 'success' && r.status !== 'partial');
  const hasPartial = results.some((r) => r.status === 'partial');
  const status = failed.length === 0 ? (hasPartial ? 'partial' : 'success') : 'failed';
  const reason =
    failed.length === 0
      ? undefined
      : failed
          .map((r) => r.reason ?? `${r.modelId} suite failed`)
          .filter(Boolean)
          .join('; ');

  return {
    runId: first.runId,
    modelId: first.modelId,
    status,
    scores,
    suiteResults,
    reason,
    startedAt: first.startedAt,
    completedAt: results[results.length - 1]!.completedAt,
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
