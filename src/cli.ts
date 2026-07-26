#!/usr/bin/env node
import type { PipelineRun } from './scheduler/pipeline-state.js';


/**
 * elastic-llm-benchmarker CLI
 *
 * Command-line interface for managing the LLM benchmarking agent.
 * Supports both interactive and scriptable modes with JSON output.
 *
 * Commands:
 *   start          Start the benchmarking daemon (deprecated)
 *   status         View benchmarker status from Elasticsearch
 *   benchmark      Trigger an immediate benchmark (deprecated)
 *   results        Query stored benchmark results from Elasticsearch
 *   export         Export benchmark results as JSON or CSV
 *   reevaluate     Re-evaluate thresholds (deprecated)
 *   migrate-to-es  Migrate results from SQLite to Elasticsearch
 *   kibana-import  Import Kibana saved objects (dashboards, visualizations)
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { ElasticsearchResultsStore } from './services/elasticsearch-results-store.js';
import { ResultsStore } from './services/results-store.js';
import { QueueService } from './services/queue-service.js';
import { Stage3WorkerImpl } from './worker/index.js';
import { KibanaRepoService } from './services/kibana-repo-service.js';
import { Lockfile } from './utils/lockfile.js';
import { registerIngestPipelines } from './services/es-ingest-pipelines.js';
import { TraceQueryBuilderImpl } from './services/trace-query-builder.js';
import { LocalTraceQueryBuilder } from './services/local-trace-query-builder.js';
import { CompositeTraceQueryBuilder } from './services/composite-trace-query-builder.js';
import { ReasoningPromptBuilderImpl } from './services/reasoning-prompt-builder.js';
import type { BenchmarkResult } from './types/benchmark.js';
import type { AppConfig } from './types/config.js';
import { ToolCallBenchmarkService } from './services/tool-call-benchmark.js';
import { buildDeployCommandWithToolCalling } from './services/vllm-deployment.js';
import { ConfigResearcherService } from './services/config-researcher.js';
import { runEnqueue } from './cli/enqueue-handler.js';
import { startHandler, createEsClient, createLlmClient } from './cli/start-handler.js';
import { CliError } from './cli/shutdown.js';
import { output, outputError, formatDuration } from './cli/output.js';
import { resultsHandler } from './cli/results-handler.js';
import { recommendHandler } from './cli/recommend-handler.js';
import { regenerateRecommendationHandler } from './cli/regenerate-handler.js';
import { SystemHealthChecker } from './services/system-health-check.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const VERSION = '0.1.0';

// ─── ES Client Helper ───────────────────────────────────────────────────────────


// ─── Helper Functions ──────────────────────────────────────────────────────────


/**
 * Loads app configuration safely, returning null on failure.
 * Prints the error to stderr in non-JSON mode.
 */
function loadAppConfig(options: { config?: string; json?: boolean }): AppConfig | null {
  try {
    const configPath = options.config
      ? resolve(process.cwd(), options.config)
      : undefined;
    return loadConfig(undefined, {
      configPath,
    });
  } catch (err) {
    if (!options.json) {
      console.error(
        `Error loading configuration: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return null;
  }
}

/**
 * Resolves the results database path from configuration or defaults.
 */
function getResultsDbPath(config: AppConfig | null): string {
  const resultsDir = config?.resultsDir ?? './results';
  return resolve(resultsDir, 'benchmarks.db');
}







/**
 * Converts benchmark results to CSV format.
 */
function resultsToCSV(results: BenchmarkResult[]): string {
  const headers = [
    'model_id',
    'timestamp',
    'vllm_version',
    'passed',
    'gpu_type',
    'gpu_count',
    'ram_gb',
    'cpu_cores',
    'tensor_parallel_size',
    'tool_call_parser',
    'itl_ms_avg',
    'ttft_ms_avg',
    'throughput_avg',
    'p99_latency_avg',
    'tool_call_success_rate',
    'rejection_reasons',
  ];

  const rows = results.map((r) => {
    const avgMetrics =
      r.benchmarkMetrics.length > 0
        ? {
          itlMs:
            r.benchmarkMetrics.reduce((sum, m) => sum + m.itlMs, 0) /
            r.benchmarkMetrics.length,
          ttftMs:
            r.benchmarkMetrics.reduce((sum, m) => sum + m.ttftMs, 0) /
            r.benchmarkMetrics.length,
          throughput:
            r.benchmarkMetrics.reduce((sum, m) => sum + m.throughputTokensPerSec, 0) /
            r.benchmarkMetrics.length,
          p99:
            r.benchmarkMetrics.reduce((sum, m) => sum + m.p99LatencyMs, 0) /
            r.benchmarkMetrics.length,
        }
        : { itlMs: 0, ttftMs: 0, throughput: 0, p99: 0 };

    return [
      `"${r.modelId}"`,
      r.timestamp,
      r.vllmVersion,
      r.passed,
      r.hardwareConfig.gpuType,
      r.hardwareConfig.gpuCount,
      r.hardwareConfig.ramGb,
      r.hardwareConfig.cpuCores,
      r.tensorParallelSize,
      r.toolCallParser,
      avgMetrics.itlMs.toFixed(2),
      avgMetrics.ttftMs.toFixed(2),
      avgMetrics.throughput.toFixed(2),
      avgMetrics.p99.toFixed(2),
      r.toolCallResults?.successRate ?? '',
      `"${r.rejectionReasons.join('; ')}"`,
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

// ─── CLI Program ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('elastic-llm-benchmarker')
  .description('CLI for managing the Elastic LLM Benchmarking Agent')
  .version(VERSION)
  .option('-c, --config <path>', 'Path to configuration file', 'config/default.json')
  .option('--json', 'Output results in JSON format for scripting', false);

// ─── start command ─────────────────────────────────────────────────────────────

const _binaryName = basename(process.argv[1] ?? '');

/** Queue subcommands (start/stop/enqueue) work via symlink or direct dist/cli.js. */
function isQueueCliInvocation(): boolean {
  const entry = process.argv[1] ?? '';
  if (_binaryName === 'benchmarker-queue') {
    return true;
  }
  return entry.includes('dist/cli.js') || entry.includes('benchmarker-queue');
}

if (!isQueueCliInvocation()) {
  program
    .command('start')
    .description('Start the benchmarking daemon (deprecated: use benchmarker-queue start instead)')
    .action(() => {
      const globalOpts = program.opts();
      const jsonOutput = globalOpts['json'] as boolean;
      const msg =
        'Daemon removed. Run: benchmarker-queue start (see README for setup)';
      if (jsonOutput) {
        output({ error: msg }, true);
      } else {
        console.error(msg);
      }
      process.exit(1);
    });
}

// ─── status command ────────────────────────────────────────────────────────────

program
  .command('status')
  .description('View benchmarker status from Elasticsearch')
  .action(async () => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const config = loadAppConfig({ config: globalOpts['config'] as string, json: jsonOutput });
    const esClient = createEsClient(config);
    if (!esClient) {
      outputError('Cannot connect to Elasticsearch. Check config.', jsonOutput);
      process.exit(1);
    }
    const store = new ElasticsearchResultsStore(esClient);
    await store.initialize();
    const stats = await store.getStats();
    const queue = new QueueService(esClient);
    const current = await queue.getCurrent();
    const pendingCount = (await queue.getQueue({ status: 'pending' })).length;

    const currentDuration =
      current?.startedAt ? formatDuration(Date.now() - new Date(current.startedAt).getTime()) : null;
    const info = {
      results: { total: stats.total, passed: stats.passed, failed: stats.failed },
      queue: {
        pending: pendingCount,
        current: current?.modelId ?? null,
        currentDuration: currentDuration ?? null,
      },
    };
    if (jsonOutput) {
      output(info, true);
    } else {
      console.error('=== Elastic LLM Benchmarker Status ===\n');
      console.error(`Results: ${stats.total} total (${stats.passed} passed, ${stats.failed} failed)`);
      console.error(
        `Queue: ${pendingCount} pending, current: ${current?.modelId ?? 'none'}` +
          (currentDuration ? ` (${currentDuration})` : ''),
      );
    }
    await store.close();
  });

// ─── benchmark command ─────────────────────────────────────────────────────────

program
  .command('benchmark')
  .description('Trigger an immediate benchmark run (deprecated: use queue enqueue instead)')
  .action(() => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const msg = 'Benchmark via CLI removed. Use: benchmarker-queue enqueue <modelId> (see README)';
    if (jsonOutput) {
      output({ error: msg }, true);
    } else {
      console.error(msg);
    }
    process.exit(1);
  });

// ─── results command ───────────────────────────────────────────────────────────

program
  .command('results')
  .description('Query stored benchmark results')
  .option('--model <id>', 'Filter by model ID')
  .option('--status <status>', 'Filter by status (passed | failed)')
  .option('--after <date>', 'Filter results after this date (ISO 8601)')
  .option('--before <date>', 'Filter results before this date (ISO 8601)')
  .option('--gpu-type <type>', 'Filter by GPU type')
  .option('--limit <n>', 'Maximum number of results to return', '20')
  .option('--offset <n>', 'Number of results to skip', '0')
  .option('--order <dir>', 'Sort order (asc | desc)', 'desc')
  .option('--summary', 'Show summary for each model instead of individual results', false)
  .action(async (opts) => { await resultsHandler(opts, { program }); });

// ─── reevaluate command ───────────────────────────────────────────────────────

program
  .command('reevaluate')
  .description(
    'Re-evaluate results against tiered thresholds (deprecated: use Kibana alerting rules for threshold monitoring)',
  )
  .action(() => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const msg =
      'reevaluate deprecated. Use Kibana alerting rules for threshold monitoring of Elasticsearch results.';
    if (jsonOutput) {
      output({ error: msg }, true);
    } else {
      console.error(msg);
    }
    process.exit(1);
  });

// ─── print-deploy-command command ────────────────────────────────────────────

program
  .command('print-deploy-command')
  .description(
    'Print a vLLM docker run command with tool calling enabled for the given model (for local deploy + tool-call-benchmark)',
  )
  .option('--model <id>', 'Model ID (e.g. meta-llama/Llama-3.3-70B-Instruct)', 'meta-llama/Llama-3.3-70B-Instruct')
  .option('--architecture <arch>', 'Model architecture (e.g. llama) — needed for Llama-derived models whose id lacks "llama"')
  .option('--port <n>', 'Host port to expose (default: 8000)', '8000')
  .option('--image <image>', 'vLLM Docker image', 'vllm/vllm-openai:latest')
  .option('--tensor-parallel <n>', 'Tensor parallel size (GPUs)', '2')
  .action((opts) => {
    const modelId = opts['model'] as string;
    const architecture = opts['architecture'] as string | undefined;
    const port = parseInt(opts['port'] as string, 10);
    const image = opts['image'] as string;
    const tensorParallel = parseInt(opts['tensorParallel'] as string, 10);
    const { command, toolCallParser } = buildDeployCommandWithToolCalling({
      modelId,
      architecture,
      apiPort: port,
      dockerImage: image,
      tensorParallelSize: tensorParallel,
    });
    if (toolCallParser) {
      console.error(`# Tool calling enabled: --tool-call-parser ${toolCallParser} --enable-auto-tool-choice`);
    } else {
      console.error('# No tool-call parser for this model; add one manually if needed.');
    }
    console.log(command);
  });

// ─── deploy-and-test-tool-calls command ──────────────────────────────────────

program
  .command('deploy-and-test-tool-calls')
  .description(
    'Deploy vLLM with tool calling enabled, wait for healthy, then run the tool-call benchmark (local Docker)',
  )
  .option('--model <id>', 'Model ID', 'meta-llama/Llama-3.3-70B-Instruct')
  .option('--architecture <arch>', 'Model architecture (e.g. llama) — needed for Llama-derived models whose id lacks "llama"')
  .option('--port <n>', 'Host port', '8000')
  .option('--image <image>', 'vLLM Docker image', 'vllm/vllm-openai:latest')
  .option('--tensor-parallel <n>', 'Tensor parallel size', '2')
  .option('--wait-ms <n>', 'Max ms to wait for API health before running benchmark', '600000')
  .option('--no-stop', 'Do not stop the container after the benchmark')
  .action(async (opts) => {
    const modelId = opts['model'] as string;
    const architecture = opts['architecture'] as string | undefined;
    const port = parseInt(opts['port'] as string, 10);
    const image = opts['image'] as string;
    const tensorParallel = parseInt(opts['tensorParallel'] as string, 10);
    const waitMs = parseInt(opts['waitMs'] as string, 10);
    const stopAfter = opts['stop'] !== false;

    const { command, toolCallParser } = buildDeployCommandWithToolCalling({
      modelId,
      architecture,
      apiPort: port,
      dockerImage: image,
      tensorParallelSize: tensorParallel,
    });

    if (!toolCallParser) {
      console.error('No tool-call parser for this model; deploy command would not enable tool calling.');
      process.exit(1);
    }

    const oneLiner = command.replace(/\s*\\\s*\n\s*/g, ' ');
    console.error('Deploying with tool calling enabled...');
    console.error(`  ${oneLiner.slice(0, 120)}...`);

    const child = spawn(oneLiner, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c) => { stderr += c; });
    child.stdout?.on('data', (c) => { stderr += String(c); });

    await new Promise<void>((res, rej) => {
      child.on('error', rej);
      child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`docker run exited ${code}: ${stderr}`))));
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const start = Date.now();
    console.error(`Waiting for API at ${baseUrl} (max ${waitMs}ms)...`);
    let healthy = false;
    while (Date.now() - start < waitMs) {
      try {
        const r = await fetch(`${baseUrl}/health`);
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch {
        // ignore, retry
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!healthy) {
      console.error('API did not become healthy in time.');
      process.exit(1);
    }
    console.error('API is healthy. Running tool-call benchmark...');
    const service = new ToolCallBenchmarkService({ baseUrl, model: modelId, logLevel: 'info' });
    const report = await service.runBenchmark();
    const tc = report.toolCallResult;
    console.error('\nTool-call benchmark result:');
    console.error(`  Passed: ${report.passed}`);
    console.error(`  Supports parallel calls: ${tc.supportsParallelCalls}`);
    console.error(`  Success rate: ${(tc.successRate * 100).toFixed(2)}%`);
    console.error(`  Avg latency: ${tc.avgToolCallLatencyMs.toFixed(2)} ms`);
    if (stopAfter) {
      const containerName = `vllm-${modelId.replace(/[^a-zA-Z0-9.-]/g, '-').slice(0, 40)}`;
      console.error(`Stopping container ${containerName}...`);
      spawn(`docker stop ${containerName}`, { shell: true, stdio: 'inherit' });
    }
  });

// ─── tool-call-benchmark command ─────────────────────────────────────────────

program
  .command('tool-call-benchmark')
  .description('Run only the tool-call benchmark (sequential + parallel) against a running API')
  .option('--base-url <url>', 'Base URL of the API (e.g. http://localhost:8000)', 'http://localhost:8000')
  .option('--model <id>', 'Model ID as exposed by the API', 'meta-llama/Llama-3.3-70B-Instruct')
  .option('--log-level <level>', 'Log level (error, warn, info, debug)', 'info')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const baseUrl = (opts['baseUrl'] as string).replace(/\/+$/, '');
    const modelId = opts['model'] as string;
    const logLevel = (opts['logLevel'] as string) ?? 'info';

    if (!jsonOutput) {
      console.error(`Running tool-call benchmark for ${modelId}`);
      console.error(`  Base URL: ${baseUrl}`);
    }

    const service = new ToolCallBenchmarkService({
      baseUrl,
      model: modelId,
      logLevel: logLevel as 'error' | 'warn' | 'info' | 'debug',
    });

    try {
      const report = await service.runBenchmark();

      if (jsonOutput) {
        output(
          {
            modelId,
            baseUrl,
            passed: report.passed,
            toolCallResult: report.toolCallResult,
            failureReasons: report.failureReasons,
          },
          true,
        );
      } else {
        const tc = report.toolCallResult;
        console.error('\nTool-call benchmark result:');
        console.error(`  Passed: ${report.passed}`);
        console.error(`  Supports parallel calls: ${tc.supportsParallelCalls}`);
        console.error(`  Max concurrent calls: ${tc.maxConcurrentCalls}`);
        console.error(`  Success rate: ${(tc.successRate * 100).toFixed(2)}%`);
        console.error(`  Avg latency: ${tc.avgToolCallLatencyMs.toFixed(2)} ms`);
        console.error(`  Total tests: ${tc.totalTests}`);
        if (report.failureReasons.length > 0) {
          console.error('  Failure reasons:');
          report.failureReasons.forEach((r) => console.error(`    - ${r}`));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outputError(`Tool-call benchmark failed: ${message}`, jsonOutput);
      process.exit(1);
    }
  });

// ─── report command ───────────────────────────────────────────────────────────

program
  .command('report')
  .description('Generate markdown evaluation report (deprecated: use Elasticsearch dashboard)')
  .action(() => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const msg = 'Markdown report removed. Use Elasticsearch results store and dashboard.';
    if (jsonOutput) {
      output({ error: msg }, true);
    } else {
      console.error(msg);
    }
    process.exit(1);
  });

// ─── export command ────────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export benchmark results as JSON or CSV reports')
  .option('--format <fmt>', 'Output format (json | csv)', 'json')
  .option('--output <path>', 'Output file path (defaults to stdout)')
  .option('--model <id>', 'Filter by model ID')
  .option('--status <status>', 'Filter by status (passed | failed)')
  .option('--after <date>', 'Filter results after this date (ISO 8601)')
  .option('--before <date>', 'Filter results before this date (ISO 8601)')
  .option('--gpu-type <type>', 'Filter by GPU type')
  .action(async (opts) => {
    const globalOpts = program.opts();
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
      const format = opts['format'] as string;
      const outputPath = opts['output'] as string | undefined;
      const statusFilter = opts['status'] as string | undefined;

      const results = await store.query({
        modelId: opts['model'] as string | undefined,
        passed: statusFilter === 'passed' ? true : statusFilter === 'failed' ? false : undefined,
        after: opts['after'] as string | undefined,
        before: opts['before'] as string | undefined,
        gpuType: opts['gpuType'] as string | undefined,
        orderBy: 'desc',
      });

      let content: string;

      if (format === 'csv') {
        content = resultsToCSV(results);
      } else {
        content = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            totalResults: results.length,
            results,
          },
          null,
          2,
        );
      }

      if (outputPath) {
        const resolvedOutput = resolve(outputPath);
        const dir = dirname(resolvedOutput);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(resolvedOutput, content, 'utf-8');

        if (!jsonOutput) {
          console.error(`Exported ${results.length} result(s) to ${resolvedOutput} (${format})`);
        } else {
          output(
            {
              status: 'exported',
              format,
              path: resolvedOutput,
              count: results.length,
            },
            true,
          );
        }
      } else {
        process.stdout.write(content + '\n');
      }
    } finally {
      await store.close();
    }
  });

// ─── migrate-to-es command ────────────────────────────────────────────────────

program
  .command('migrate-to-es')
  .description('Migrate results from SQLite database to Elasticsearch')
  .option('--db <path>', 'Path to SQLite results database')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const config = loadAppConfig({ config: globalOpts['config'] as string, json: jsonOutput });
    const dbPath = (opts['db'] as string) ?? getResultsDbPath(config);

    if (!existsSync(dbPath)) {
      outputError(`SQLite database not found at: ${dbPath}`, jsonOutput);
      process.exit(1);
    }

    const esClient = createEsClient(config);
    if (!esClient) {
      outputError('Cannot connect to Elasticsearch. Check config.', jsonOutput);
      process.exit(1);
    }

    const sqliteStore = new ResultsStore(dbPath, 'info');
    const esStore = new ElasticsearchResultsStore(esClient);
    await esStore.initialize();
    await registerIngestPipelines(esClient);

    const allResults = sqliteStore.exportAll();
    let migrated = 0;
    let errors = 0;

    for (const result of allResults) {
      try {
        await esStore.save(result);
        migrated++;
      } catch (err) {
        errors++;
        if (!jsonOutput) {
          console.error(`Failed to migrate ${result.modelId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    sqliteStore.close();
    await esStore.close();

    if (jsonOutput) {
      output({ total: allResults.length, migrated, errors }, true);
    } else {
      console.error(`Migration complete: ${migrated}/${allResults.length} results migrated (${errors} errors)`);
    }
  });

// ─── kibana-import command ─────────────────────────────────────────────────────

program
  .command('kibana-import')
  .description('Import Kibana saved objects (dashboards, visualizations)')
  .option('--kibana-url <url>', 'Kibana URL', 'http://localhost:5601')
  .option('--file <path>', 'Path to saved objects NDJSON file', './kibana/saved-objects.ndjson')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const kibanaUrl = (opts['kibanaUrl'] as string).replace(/\/+$/, '');
    const filePath = resolve(opts['file'] as string);

    if (!existsSync(filePath)) {
      outputError(`Saved objects file not found: ${filePath}`, jsonOutput);
      process.exit(1);
    }

    const fileContent = readFileSync(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([fileContent]), 'saved-objects.ndjson');

    try {
      const response = await fetch(`${kibanaUrl}/api/saved_objects/_import?overwrite=true`, {
        method: 'POST',
        headers: { 'kbn-xsrf': 'true' },
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        outputError(`Kibana import failed (${response.status}): ${text}`, jsonOutput);
        process.exit(1);
      }

      const result = (await response.json()) as { successCount?: number };
      if (jsonOutput) {
        output(result, true);
      } else {
        console.error(`Import complete: ${result.successCount ?? 0} objects imported`);
      }
    } catch (err) {
      outputError(`Failed to connect to Kibana: ${err instanceof Error ? err.message : String(err)}`, jsonOutput);
      process.exit(1);
    }
  });

// ─── recommend command ─────────────────────────────────────────────────

program
  .command('recommend')
  .description('Get the latest recommendation report for a model')
  .option('--model <id>', 'Model ID to get recommendation for')
  .option('--verdict <verdict>', 'Filter by verdict (support | investigate | reject)')
  .option('--limit <n>', 'Number of reports to return', '10')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .action(async (opts) => { await recommendHandler(opts, { program }); });

// ─── regenerate-recommendation command ──────────────────────────────────
// Rebuilds a model's recommendation report from persisted Stage 1/2/3 data
// WITHOUT re-running any Buildkite builds. Use after a scoring-logic fix (e.g.
// the per-suite score-extraction bug) to give an already-evaluated model its
// corrected verdict. All inputs are read from ES — nothing is fabricated.
program
  .command('regenerate-recommendation')
  .description("Rebuild a model's recommendation from persisted Stage 1/2/3 data (no build re-run)")
  .requiredOption('--model <id>', 'Model ID to regenerate the recommendation for')
  .action(async (opts) => { await regenerateRecommendationHandler(opts, { program }); });



// ─── benchmark-model command ───────────────────────────────────────────────

program
  .command('benchmark-model <model-id>')
  .description('Benchmark a specific model (adds to priority queue)')
  .option('--wait', 'Wait and stream progress until completion')
  .option('--tensor-parallel <number>', 'Override tensor parallel size')
  .option('--max-model-len <number>', 'Override max model length')
  .option('--skip-reasoning', 'Skip reasoning tests')
  .action(async (modelId, options) => {
    const config = loadAppConfig(options);
    if (!config) process.exit(1);

    const esClient = createEsClient(config);
    if (!esClient) {
      console.error('Error: Could not create Elasticsearch client');
      process.exit(1);
    }

    const queueService = new QueueService(esClient);
    const configResearcher = new ConfigResearcherService({
      gpusAvailable: config.vmHardwareProfile.gpuCount || 2,
      huggingfaceToken: config.huggingfaceToken,
    });

    try {
      console.log('🔍 Researching optimal configuration...');
      await configResearcher.research(modelId);

      console.log('📝 Adding to priority queue...');
      const queueEntry = await queueService.enqueue(
        modelId,
        'user',
        100,
        'cli'
      );

      console.log('✓ Added to priority queue');
      console.log(`  Queue ID: ${queueEntry.id}`);
      console.log(`  Model: ${queueEntry.modelId}`);
      console.log(`  Priority: ${queueEntry.priority}`);
      console.log(`  Status: ${queueEntry.status}`);

      if (options.wait) {
        console.log('\n⏳ Waiting for completion...\n');
        await pollUntilComplete(queueService, queueEntry.id);
      } else {
        console.log(`\n💡 Check status: npx tsx src/cli.ts queue-status ${queueEntry.id}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await esClient.close();
    }
  });

async function pollUntilComplete(queueService: QueueService, queueId: string) {
  const MAX_WAIT_MS = 3600000; // 1 hour
  const startTime = Date.now();
  let lastStatus: string | null = null;
  let pollInterval = 1000; // Start at 1s
  const MAX_INTERVAL = 30000; // Cap at 30s

  while (true) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      console.error('❌ Timeout after 1 hour');
      process.exit(1);
    }

    // Efficient: Get single entry by ID instead of fetching entire queue
    const entry = await queueService.getById(queueId);

    if (!entry) {
      console.error('❌ Queue entry not found');
      process.exit(1);
    }

    // Only log status on change (reduce spam)
    if (entry.status !== lastStatus) {
      if (entry.status === 'deploying') {
        console.log('🚀 Deploying model...');
      } else if (entry.status === 'benchmarking') {
        console.log('📊 Running benchmarks...');
      }
      lastStatus = entry.status;
    }

    if (entry.status === 'completed') {
      console.log('✅ Benchmark complete!');
      return;
    }
    if (entry.status === 'failed') {
      console.error(`❌ Failed: ${entry.errorMessage || 'Unknown error'}`);
      process.exit(1);
    }

    await new Promise(r => setTimeout(r, pollInterval));

    // Exponential backoff: 1s → 1.5s → 2.25s → ... → 30s max
    pollInterval = Math.min(pollInterval * 1.5, MAX_INTERVAL);
  }
}

// ─── queue-status command ──────────────────────────────────────────────────

program
  .command('queue-status [queue-id]')
  .description('Check queue status (specific entry or all entries)')
  .action(async (queueId, options) => {
    const config = loadAppConfig(options);
    if (!config) process.exit(1);

    const esClient = createEsClient(config);
    if (!esClient) {
      console.error('Error: Could not create Elasticsearch client');
      process.exit(1);
    }

    const queueService = new QueueService(esClient);

    try {
      if (queueId) {
        // Get specific entry
        const allEntries = await queueService.getQueue();
        const entry = allEntries.find(e => e.id === queueId);

        if (!entry) {
          console.error(`Queue entry ${queueId} not found`);
          process.exit(1);
        }

        console.log('Queue Entry:');
        console.log(`  ID: ${entry.id}`);
        console.log(`  Model: ${entry.modelId}`);
        console.log(`  Status: ${entry.status}`);
        console.log(`  Priority: ${entry.priority}`);
        console.log(`  Requested: ${entry.requestedAt}`);
        if (entry.startedAt) console.log(`  Started: ${entry.startedAt}`);
        if (entry.completedAt) console.log(`  Completed: ${entry.completedAt}`);
        if (entry.errorMessage) console.log(`  Error: ${entry.errorMessage}`);
      } else {
        // Get all entries
        const entries = await queueService.getQueue();
        console.log(`Queue: ${entries.length} entries\n`);

        if (entries.length === 0) {
          console.log('  (empty)');
        } else {
          entries.forEach(e => {
            const statusEmoji = {
              pending: '⏳',
              deploying: '🚀',
              benchmarking: '📊',
              completed: '✅',
              failed: '❌',
              cancelled: '🚫'
            }[e.status] || '❓';

            console.log(`  ${statusEmoji} [${e.status.padEnd(12)}] ${e.modelId} (priority: ${e.priority})`);
          });
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await esClient.close();
    }
  });

// ─── bootstrap-kibana command ──────────────────────────────────────────────

program
  .command('bootstrap-kibana')
  .description('Clone and bootstrap Kibana repository for evals')
  .option('-c, --config <path>', 'Path to configuration file', 'config/default.json')
  .action(async (opts) => {
    const configPath = opts['config'] as string;
    const config = loadAppConfig({ config: configPath, json: false });
    if (!config) process.exit(1);

    const logger = createLogger(config.logLevel ?? 'info');
    const repoService = new KibanaRepoService({ config, logger });
    await repoService.cloneOrPull();
    await repoService.bootstrap();
    logger.info(`Kibana ready at ${repoService.getRepoPath()}`);
  });

// ─── benchmarker-queue commands ───────────────────────────────────────────────

if (isQueueCliInvocation()) {
  program.name('benchmarker-queue').description('LLM Benchmarker Queue Scheduler');

  program
    .command('start')
    .description('Start the scheduler polling loop for pending queue entries')
    .option('-c, --config <path>', 'Path to configuration file', 'config/default.json')
    .option('--poll-interval <ms>', 'Polling interval in milliseconds', '30000')
    .option('--stage2', 'Enable Stage 2 eval pipeline', false)
    .option('--stage3', 'Enable Stage 3 reasoning pipeline', true)
    .option('--queue-model <modelId>', 'Enqueue a single model and exit (does not start scheduler)')
    .option('--discovery', 'Enable HuggingFace model discovery scheduler', false)
    .option('--ci-evals', 'Enable CI eval pipeline (smoke test → Buildkite on-demand eval)', false)
    .option('--daemonize', 'Fork into a background process and exit (survives shell disconnect)', false)
    .option('--clear-pending', 'Cancel all pending queue entries before starting (validation runs)', false)
    .option(
      '--enqueue-after-clear <modelId>',
      'Enqueue a model after --clear-pending (avoids cancelling the validation target)',
    )
    .option('--connector <type>', 'Output connector: "elasticsearch" (default) or "local"', 'elasticsearch')
    .option('--output-dir <path>', 'Output directory for local connector', './benchmark-output')
    .action(async (opts) => {
      try {
        await startHandler(opts, { program });
      } catch (err) {
        if (err instanceof CliError) {
          if (err.message) console.error(`Error: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    });

  program
    .command('queue <modelId>')
    .description('Add a model to the benchmark queue')
    .option('-c, --config <path>', 'Path to configuration file', 'config/default.json')
    .option('-p, --priority <n>', 'Queue priority (higher runs first)', '5')
    .option('-s, --source <source>', 'Queue entry source', 'user')
    .action(async (modelId: string, opts) => {
      const configPath = opts['config'] as string;
      const priority = parseInt(opts['priority'] as string, 10);
      const source = opts['source'] as string;

      const config = loadAppConfig({ config: configPath, json: false });
      if (!config) process.exit(1);

      const esClient = createEsClient(config);
      if (!esClient) {
        console.error('Error: Could not create Elasticsearch client');
        process.exit(1);
      }

      const queueService = new QueueService(esClient);

      try {
        const entry = await queueService.enqueue(modelId, source as 'user' | 'discovery', priority);
        console.log(`Queued ${modelId} with ID ${entry.id} (priority: ${priority})`);
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      } finally {
        await esClient.close();
      }
    });

  program
    .command('health-check')
    .description('Run the health-check script for ES + EDOT + GPU VM')
    .option('--format <fmt>', 'Output format: text or json', 'text')
    .action(async (opts) => {
      const json = opts['format'] === 'json';

      let bashOk = true;
      let bashOutput = '';
      try {
        bashOutput = execSync('bash scripts/health-check.sh', { encoding: 'utf-8' });
      } catch (err) {
        bashOk = false;
        bashOutput = String(err);
      }

      const checker = new SystemHealthChecker({});
      const tsResult = await checker.run();

      if (json) {
        const result = {
          ok: bashOk && tsResult.ok,
          checks: {
            bash_health_check: { ok: bashOk, message: bashOutput.trim() || undefined },
            ...tsResult.checks,
          },
        };
        output(result, true);
        process.exit(result.ok ? 0 : 1);
      }

      if (!bashOk) {
        console.error('Bash health-check script failed');
        if (bashOutput) console.error(bashOutput);
      } else {
        console.log(bashOutput.trim() || 'Bash health-check script passed');
      }

      for (const [name, check] of Object.entries(tsResult.checks)) {
        const status = check.ok ? '✓' : '✗';
        console.log(`${status} ${name}: ${check.message ?? ''}`);
      }

      process.exit(bashOk && tsResult.ok ? 0 : 1);
    });

  program
    .command('setup-local')
    .description('Start local ES + EDOT containers and configure ILM policies')
    .action(() => {
      try {
        execSync('bash scripts/setup-local.sh', { stdio: 'inherit' });
        execSync('bash scripts/setup-ilm.sh', { stdio: 'inherit' });
        console.log('Local infrastructure ready.');
      } catch (err) {
        console.error('Setup failed:', (err as Error).message);
        process.exit((err as Error & { status?: number }).status ?? 1);
      }
    });

  program
    .command('reasoning <runId>')
    .description('Run Stage 3 reasoning on a benchmark run')
    .option('-c, --config <path>', 'Path to configuration file', 'config/default.json')
    .option('-m, --model <modelId>', 'Model identifier (defaults to runId)')
    .action(async (runId: string, opts) => {
      const configPath = opts['config'] as string;
      const modelId = (opts['model'] as string) || runId;

      const config = loadAppConfig({ config: configPath, json: false });
      if (!config) process.exit(1);

      const logger = createLogger(config.logLevel ?? 'info');
      const esClient = createEsClient(config);
      if (!esClient) {
        console.error('Error: Could not create Elasticsearch client');
        process.exit(1);
      }

      const resultsStore = new ElasticsearchResultsStore(esClient);

      const llmClient = createLlmClient(config, esClient, logger);
      if (!llmClient) {
        console.error('Error: No LLM configured — set EIS_CCM_API_KEY or LLM_API_KEY');
        process.exit(1);
      }

      const stage3Worker = new Stage3WorkerImpl({
        config,
        traceQueryBuilder: new CompositeTraceQueryBuilder(
          new TraceQueryBuilderImpl(
            esClient,
            logger,
            config.edotCollector.traceIndexPattern,
          ),
          new LocalTraceQueryBuilder(),
        ),
        promptBuilder: new ReasoningPromptBuilderImpl(),
        llmClient,
        resultsStore,
        logger,
      });

      // Derive the trace time window from the model's last benchmark run so the
      // standalone command reasons over the actual vLLM spans. Without this the
      // window defaults to "now", which never overlaps a past run's traces.
      const summary = await resultsStore.getModelSummary(modelId);
      const lastRun = summary?.lastRunTimestamp
        ? new Date(summary.lastRunTimestamp)
        : null;
      const startedAt = lastRun
        ? new Date(lastRun.getTime() - 30 * 60_000).toISOString()
        : new Date(Date.now() - 60 * 60_000).toISOString();
      const completedAt = lastRun
        ? new Date(lastRun.getTime() + 5 * 60_000).toISOString()
        : new Date().toISOString();

      const run: PipelineRun = {
        runId,
        modelId,
        queueEntryId: runId,
        stage: 'idle',
        startedAt,
        completedAt,
      };

      try {
        const result = await stage3Worker.execute(run);
        console.log(JSON.stringify(result.suggestions ?? [], null, 2));
        process.exit(result.status === 'success' ? 0 : 1);
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      } finally {
        await esClient.close();
      }
    });

  program
    .command('enqueue <modelId>')
    .description('Enqueue a single model for benchmarking with optional hardware-fit dry-run')
    .option('-c, --config <path>', 'Path to configuration file', 'config/default.json')
    .option('--hardware-profile <id>', 'Hardware profile ID to check against', undefined)
    .option('--priority <n>', 'Queue priority (1 = highest)', '5')
    .option('--force', 'Skip hardware-fit check and enqueue anyway')
    .option('--reason <text>', 'Optional reason/note to store in metadata')
    .option('--skip-stage1', 'Skip Stage 1 deploy/benchmark (eval-only)')
    .option('--endpoint-url <url>', 'vLLM endpoint when using --skip-stage1')
    .option('--deployment-name <name>', 'Deployment name for eval-only teardown')
    .option('--skip-passed-suites', 'Resume: skip suites already passed in batch jsonl/ES')
    .action(async (modelId: string, opts) => {
      const configPath = opts['config'] as string;
      const config = loadAppConfig({ config: configPath, json: false });
      if (!config) process.exit(1);

      const esClient = createEsClient(config);
      if (!esClient) {
        console.error('Error: Could not create Elasticsearch client');
        process.exit(1);
      }

      try {
        const result = await runEnqueue({
          modelId,
          config,
          esClient,
          hardwareProfileId: opts['hardwareProfile'] as string | undefined,
          priority: Number(opts['priority']),
          force: Boolean(opts['force']),
          reason: opts['reason'] as string | undefined,
          skipStage1: Boolean(opts['skipStage1']),
          endpointUrl: opts['endpointUrl'] as string | undefined,
          deploymentName: opts['deploymentName'] as string | undefined,
          skipPassedSuites: Boolean(opts['skipPassedSuites']),
        });

        console.log(result.message);
        if (result.dryRun) {
          console.log(
            `Estimated VRAM: ${result.dryRun.estimatedGb.toFixed(2)} GB / Available: ${result.dryRun.availableGb.toFixed(2)} GB`,
          );
        }
        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error('Unexpected error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      } finally {
        await esClient.close();
      }
    });

  program
    .command('stop')
    .description('Stop the running benchmarker-queue daemon')
    .action(() => {
      const lockfile = new Lockfile({ path: '.benchmarker-queue.lock' });
      const pid = lockfile.readPid();
      if (!pid) {
        console.log('benchmarker-queue is not running (no lockfile found)');
        process.exit(0);
      }
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Sent SIGTERM to process ${pid}`);
      } catch (err) {
        console.error('Failed to stop process:', (err as Error).message);
        process.exit(1);
      }
    });
}

// ─── Parse and Execute ─────────────────────────────────────────────────────────

program.parse(process.argv);

// Show help if no command provided
if (process.argv.length <= 2) {
  program.help();
}
