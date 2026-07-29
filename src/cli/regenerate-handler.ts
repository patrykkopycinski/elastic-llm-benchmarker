import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { createEsClient } from './start-handler.js';
import { output, outputError } from './output.js';
import { buildRecommendationReport } from '../services/recommendation-report-builder.js';
import { mapBuildkiteResultToStage2, mergeStage2Results } from '../services/ci-eval-stage2-mapper.js';
import type { BuildkiteBuildResult } from '../services/buildkite-eval-trigger.js';
import { parsePlaywrightSpecPassRate } from '../services/local-batch-eval-runner.js';
import type { PipelineRun, Stage2Result } from '../scheduler/pipeline-state.js';

function loadAppConfig(options: { config?: string; json?: boolean }): ReturnType<typeof loadConfig> | null {
  try {
    return loadConfig(undefined, { configPath: options.config ? resolve(process.cwd(), options.config) : undefined });
  } catch (err) {
    if (!options.json) {
      console.error(`Error loading configuration: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

// ─── Regenerate Recommendation Handler ──────────────────────────────────────────

export async function regenerateRecommendationHandler(opts: Record<string, unknown>, deps: { program: Command }): Promise<void> {
  const program = deps.program;
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const config = loadAppConfig({ config: globalOpts['config'] as string, json: jsonOutput });
    if (!config) {
      outputError('Cannot load configuration. Check --config.', jsonOutput);
      process.exit(1);
    }
    const esClient = createEsClient(config);
    if (!esClient) {
      outputError('Cannot connect to Elasticsearch. Check config.', jsonOutput);
      process.exit(1);
    }

    const store = new ElasticsearchResultsStore(esClient);
    await store.initialize();

    try {
      const modelId = opts['model'] as string;

      const prior = await store.getLatestRecommendation(modelId);
      if (!prior) {
        outputError(`No prior recommendation for ${modelId} — nothing to rebuild from`, jsonOutput);
        process.exit(1);
      }

      // Corrected Stage 2: re-derive per-suite scores from the persisted per-suite
      // CI eval builds via the (now-fixed) mapper — each suite keeps its own build.
      const ciResults = await store.getCIEvalResults(modelId, { limit: 50 });
      const runCi = ciResults.filter((r) => r.runId === prior.runId);
      const latestBySuite = new Map<string, (typeof runCi)[number]>();
      for (const r of runCi) {
        const suite = r.evalSuites?.[0];
        if (!suite || r.status === 'running') continue;
        // ciResults are sorted @timestamp desc, so the first row per suite is the latest terminal one.
        if (!latestBySuite.has(suite)) latestBySuite.set(suite, r);
      }
      const perSuiteStage2: Stage2Result[] = [];

      if (latestBySuite.size === 0) {
        // Batch/local-runner path: no per-suite CI eval builds persisted for
        // this run, but a Stage 2 doc with per-suite `logPath` values may exist.
        // Re-derive fractional scores from Playwright's own per-spec summary
        // in each suite's log (same path the batch runner uses live).
        const persistedStage2 = await store.getLatestStage2ForModel(modelId);
        if (
          persistedStage2 &&
          persistedStage2.runId === prior.runId &&
          persistedStage2.suiteResults
        ) {
          // Resolve per-suite log paths. Prefer `logPath` on each suite result
          // (persisted on save by the batch runner). Fall back to reading the
          // batch summary JSON — older Stage 2 docs were saved without
          // per-suite log paths but do carry `batchSummaryPath`, whose `results`
          // array maps each suite to its `log_file`.
          const suiteLogPaths = new Map<string, string>();
          const hasLogPaths = persistedStage2.suiteResults.some((sr) => sr.logPath);
          if (!hasLogPaths && persistedStage2.batchSummaryPath) {
            try {
              const summary = JSON.parse(readFileSync(persistedStage2.batchSummaryPath, 'utf8'));
              for (const r of summary.results ?? []) {
                if (r.suite && r.log_file) suiteLogPaths.set(r.suite, r.log_file);
              }
            } catch {
              // summary unreadable — proceed with whatever logPath values exist
            }
          }
          const recomputedScores: Record<string, number> = {};
          const recomputedSuiteResults = persistedStage2.suiteResults.map((sr) => {
            let score = sr.score;
            const logPath = sr.logPath ?? suiteLogPaths.get(sr.suite);
            if (sr.status !== 'pass' && logPath) {
              try {
                const logContent = readFileSync(logPath, 'utf8');
                const rate = parsePlaywrightSpecPassRate(logContent);
                if (rate !== undefined) score = rate;
              } catch {
                // log missing/unreadable — keep persisted score
              }
            }
            recomputedScores[sr.suite] = score ?? 0;
            return { ...sr, logPath, score };
          });
          if (!hasLogPaths && suiteLogPaths.size === 0) {
            outputError(`No terminal CI eval builds found for run ${prior.runId}`, jsonOutput);
            process.exit(1);
          }
          perSuiteStage2.push({
            ...persistedStage2,
            scores: recomputedScores,
            suiteResults: recomputedSuiteResults,
          });
        } else {
          outputError(`No terminal CI eval builds found for run ${prior.runId}`, jsonOutput);
          process.exit(1);
        }
      } else {
        for (const [suite, rec] of latestBySuite) {
          const buildResult: BuildkiteBuildResult = {
            status: rec.status === 'passed' ? 'passed' : 'failed',
            buildNumber: rec.buildkiteBuildNumber,
            buildUrl: rec.buildkiteBuildUrl,
            artifacts: rec.artifacts
              ? Object.entries(rec.artifacts).map(([filename, url]) => ({ filename, url }))
              : undefined,
          };
          perSuiteStage2.push(
            mapBuildkiteResultToStage2(prior.runId, modelId, [suite], buildResult, undefined, prior.evaluatedAt),
          );
        }
      }
      const stage2Result = mergeStage2Results(perSuiteStage2);

      const stage3Result = (await store.getLatestReasoningResult(modelId)) ?? undefined;

      // Reconstruct a minimal PipelineRun from the prior report's REAL Stage 1
      // metrics + vLLM config (persisted from the actual benchmark run).
      const m = prior.stage1Metrics;
      const stage1Base = {
        runId: prior.runId,
        modelId,
        queueEntryId: '',
        rawOutput: '',
        startedAt: prior.evaluatedAt,
        completedAt: prior.evaluatedAt,
      };
      const run: PipelineRun = {
        runId: prior.runId,
        modelId,
        queueEntryId: '',
        stage: 'done',
        startedAt: prior.evaluatedAt,
        completedAt: prior.evaluatedAt,
        benchmarkResult:
          prior.stage1Passed && m
            ? {
                ...stage1Base,
                status: 'success',
                metrics: {
                  itl_p50_ms: m.itl.p50,
                  itl_p99_ms: m.itl.p99,
                  ttft_ms: m.ttft.p50,
                  throughput_tps: m.throughputTps,
                  duration_sec: 0,
                },
              }
            : { ...stage1Base, status: 'failed', metrics: null },
        stage2Result,
        stage3Result,
        hfCard: {
          modelId,
          architecture: '',
          contextLength: prior.vllmConfigUsed.contextLength ?? 0,
          quantization: prior.vllmConfigUsed.quantization ? [prior.vllmConfigUsed.quantization] : [],
          tensorParallelSize: 0,
          vllmFlags: prior.vllmConfigUsed.flags ?? [],
          toolCallParser: prior.vllmConfigUsed.toolCallParser,
          parsedFrom: { readme: false, configJson: false, generationConfigJson: false },
          warnings: [],
        },
      };

      const report = buildRecommendationReport(run, { config, source: prior.source });
      const id = await store.saveRecommendationReport(report);

      if (jsonOutput) {
        output({ id, before: { verdict: prior.verdict, confidence: prior.confidence }, after: report }, true);
      } else {
        console.error(`\nRegenerated recommendation for ${modelId}`);
        console.error(`  verdict:    ${prior.verdict} → ${report.verdict}`);
        console.error(`  confidence: ${prior.confidence} → ${report.confidence}`);
        console.error(
          `  suites:     ${report.passingEvals
            .map((e) => `${e.suite}=${e.score}${e.passed ? ' pass' : ' FAIL'}`)
            .join(', ')}`,
        );
        console.error(`  stored id:  ${id}`);
      }
    } finally {
      await store.close();
    }
}
