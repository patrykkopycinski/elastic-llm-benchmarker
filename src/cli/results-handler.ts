import type { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { ModelBenchmarkSummary } from '../services/elasticsearch-results-store.js';
import { createEsClient } from './start-handler.js';
import { output, outputError } from './output.js';

function loadAppConfig(options: { config?: string; json?: boolean }): ReturnType<typeof loadConfig> | null {
  try {
    const configPath = options.config
      ? resolve(process.cwd(), options.config)
      : undefined;
    return loadConfig(undefined, { configPath });
  } catch (err) {
    if (!options.json) {
      console.error(`Error loading configuration: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

// ─── Results Handler ────────────────────────────────────────────────────────────

export async function resultsHandler(opts: Record<string, unknown>, deps: { program: Command }): Promise<void> {
  void opts; // opts param retained for signature consistency; actual opts read from closure below
    const globalOpts = deps.program.opts();
    const jsonOutput = globalOpts['json'] as boolean;

    const config = loadAppConfig({
      config: globalOpts['config'] as string,
      json: jsonOutput,
    });

    const esClient = createEsClient(config);
    if (!esClient) {
      outputError('Cannot connect to Elasticsearch. Check config.', jsonOutput);
      process.exit(1);
    }

    const store = new ElasticsearchResultsStore(esClient);
    await store.initialize();

    try {
      const showSummary = opts['summary'] as boolean;
      const modelId = opts['model'] as string | undefined;

      if (showSummary) {
        // Batch fetch in a single ES query (avoids N+1: one getModelSummary per model)
        const summaries: ModelBenchmarkSummary[] = modelId
          ? ((await store.getModelSummary(modelId)) ? [(await store.getModelSummary(modelId))!] : [])
          : await store.getAllModelSummaries();

        if (jsonOutput) {
          output({ total: summaries.length, data: summaries }, true);
        } else {
          if (summaries.length === 0) {
            console.error('No benchmark results found.');
            return;
          }

          console.error(`Found ${summaries.length} model(s):\n`);

          for (const s of summaries) {
            console.error(`  ${s.modelId}`);
            console.error(`    Runs: ${s.totalRuns} (${s.passedRuns} passed, ${s.failedRuns} failed)`);
            console.error(`    Last Run: ${s.lastRunTimestamp} (${s.lastPassed ? 'PASSED' : 'FAILED'})`);
            if (s.avgItlMs !== null) {
              console.error(`    Avg ITL: ${s.avgItlMs.toFixed(2)}ms`);
            }
            if (s.avgThroughput !== null) {
              console.error(`    Avg Throughput: ${s.avgThroughput.toFixed(2)} tok/s`);
            }
            if (s.avgToolCallSuccessRate !== null) {
              console.error(`    Avg Tool Call Success: ${(s.avgToolCallSuccessRate * 100).toFixed(1)}%`);
            }
            console.error('');
          }
        }
      } else {
        const statusFilter = opts['status'] as string | undefined;
        const limit = parseInt(opts['limit'] as string, 10);
        const offset = parseInt(opts['offset'] as string, 10);
        const orderBy = (opts['order'] as string) === 'asc' ? ('asc' as const) : ('desc' as const);

        const results = await store.query({
          modelId,
          passed: statusFilter === 'passed' ? true : statusFilter === 'failed' ? false : undefined,
          after: opts['after'] as string | undefined,
          before: opts['before'] as string | undefined,
          gpuType: opts['gpuType'] as string | undefined,
          limit,
          offset,
          orderBy,
        });

        const stats = await store.getStats();
        const totalCount =
          statusFilter === 'passed' ? stats.passed : statusFilter === 'failed' ? stats.failed : stats.total;

        if (jsonOutput) {
          output({ total: totalCount, offset, limit, data: results }, true);
        } else {
          if (results.length === 0) {
            console.error('No benchmark results found matching the filters.');
            return;
          }

          console.error(`Showing ${results.length} of ${totalCount} result(s):\n`);

          for (const r of results) {
            const status = r.passed ? '\x1b[32mPASSED\x1b[0m' : '\x1b[31mFAILED\x1b[0m';
            console.error(`  [${status}] ${r.modelId}`);
            console.error(`    Timestamp: ${r.timestamp}`);
            console.error(`    vLLM: ${r.vllmVersion}`);
            console.error(`    GPU: ${r.hardwareConfig.gpuType} x${r.hardwareConfig.gpuCount}`);

            if (r.benchmarkMetrics.length > 0) {
              for (const m of r.benchmarkMetrics) {
                console.error(
                  `    [Concurrency ${m.concurrencyLevel}] ITL: ${m.itlMs.toFixed(2)}ms, ` +
                    `Throughput: ${m.throughputTokensPerSec.toFixed(2)} tok/s, ` +
                    `P99: ${m.p99LatencyMs.toFixed(2)}ms`,
                );
              }
            }

            if (r.toolCallResults) {
              console.error(
                `    Tool Calls: ${(r.toolCallResults.successRate * 100).toFixed(1)}% success, ` +
                  `${r.toolCallResults.avgToolCallLatencyMs.toFixed(2)}ms avg latency`,
              );
            }

            if (r.rejectionReasons.length > 0) {
              console.error(`    Rejections: ${r.rejectionReasons.join(', ')}`);
            }

            console.error('');
          }
        }
      }
    } finally {
      await store.close();
    }
}
