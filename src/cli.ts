#!/usr/bin/env node

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
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from '@elastic/elasticsearch';
import { loadConfig } from './config/index.js';
import { ElasticsearchResultsStore } from './services/elasticsearch-results-store.js';
import { ResultsStore } from './services/results-store.js';
import { QueueService } from './services/queue-service.js';
import { registerIngestPipelines } from './services/es-ingest-pipelines.js';
import type { BenchmarkResult } from './types/benchmark.js';
import type { ModelBenchmarkSummary } from './services/elasticsearch-results-store.js';
import type { AppConfig } from './types/config.js';
import { ToolCallBenchmarkService } from './services/tool-call-benchmark.js';
import { buildDeployCommandWithToolCalling } from './services/vllm-deployment.js';
import { ConfigResearcherService } from './services/config-researcher.js';
import { VMResourceManagerService } from './services/vm-resource-manager.js';
import { InteractiveOrchestrator } from './agent/interactive-orchestrator.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const VERSION = '0.1.0';

// ─── ES Client Helper ───────────────────────────────────────────────────────────

function createEsClient(config: AppConfig | null): Client | null {
  if (!config) return null;
  const es = config.elasticsearch;
  if (es.cloudId) {
    return new Client({
      cloud: { id: es.cloudId },
      ...(es.apiKey ? { auth: { apiKey: es.apiKey } } : {}),
      ...(es.username && es.password ? { auth: { username: es.username, password: es.password } } : {}),
    });
  }
  return new Client({
    node: es.url,
    ...(es.apiKey ? { auth: { apiKey: es.apiKey } } : {}),
    ...(es.username && es.password ? { auth: { username: es.username, password: es.password } } : {}),
  });
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Loads app configuration safely, returning null on failure.
 * Prints the error to stderr in non-JSON mode.
 */
function loadAppConfig(options: { config?: string; json?: boolean }): AppConfig | null {
  try {
    return loadConfig(undefined, {
      configPath: options.config,
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
 * Outputs data in either JSON or human-readable format.
 */
function output(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

/**
 * Outputs an error in either JSON or human-readable format.
 */
function outputError(message: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ error: message }) + '\n');
  } else {
    console.error(`Error: ${message}`);
  }
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
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

program
  .command('start')
  .description('Start the benchmarking daemon (deprecated: use LangGraph instead)')
  .action(() => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const msg =
      'Daemon removed. Run the agent with LangGraph: langgraph dev (see langgraph.json)';
    if (jsonOutput) {
      output({ error: msg }, true);
    } else {
      console.error(msg);
    }
    process.exit(1);
  });

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
  .description('Trigger an immediate benchmark run (deprecated: use LangGraph graph instead)')
  .action(() => {
    const globalOpts = program.opts();
    const jsonOutput = globalOpts['json'] as boolean;
    const msg = 'Benchmark via CLI removed. Use the graph with LangGraph: langgraph dev';
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
      const showSummary = opts['summary'] as boolean;
      const modelId = opts['model'] as string | undefined;

      if (showSummary) {
        const modelIds = modelId ? [modelId] : await store.getEvaluatedModelIds();
        const summaries: ModelBenchmarkSummary[] = [];
        for (const id of modelIds) {
          const s = await store.getModelSummary(id);
          if (s) summaries.push(s);
        }

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
  });

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
  .option('--port <n>', 'Host port to expose (default: 8000)', '8000')
  .option('--image <image>', 'vLLM Docker image', 'vllm/vllm-openai:v0.15.1')
  .option('--tensor-parallel <n>', 'Tensor parallel size (GPUs)', '1')
  .action((opts) => {
    const modelId = opts['model'] as string;
    const port = parseInt(opts['port'] as string, 10);
    const image = opts['image'] as string;
    const tensorParallel = parseInt(opts['tensorParallel'] as string, 10);
    const { command, toolCallParser } = buildDeployCommandWithToolCalling({
      modelId,
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
  .option('--port <n>', 'Host port', '8000')
  .option('--image <image>', 'vLLM Docker image', 'vllm/vllm-openai:v0.15.1')
  .option('--tensor-parallel <n>', 'Tensor parallel size', '1')
  .option('--wait-ms <n>', 'Max ms to wait for API health before running benchmark', '600000')
  .option('--no-stop', 'Do not stop the container after the benchmark')
  .action(async (opts) => {
    const modelId = opts['model'] as string;
    const port = parseInt(opts['port'] as string, 10);
    const image = opts['image'] as string;
    const tensorParallel = parseInt(opts['tensorParallel'] as string, 10);
    const waitMs = parseInt(opts['waitMs'] as string, 10);
    const stopAfter = opts['stop'] !== false;

    const { command, toolCallParser } = buildDeployCommandWithToolCalling({
      modelId,
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
      gpusAvailable: config.hardwareProfile.gpuCount || 2,
      huggingfaceToken: config.huggingface?.token,
    });

    try {
      console.log('🔍 Researching optimal configuration...');
      const researchedConfig = await configResearcher.research(modelId);

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
  const POLL_INTERVAL = 5000;
  const MAX_ITERATIONS = 720; // 1 hour max

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const allEntries = await queueService.getQueue();
    const entry = allEntries.find(e => e.id === queueId);

    if (!entry) {
      console.error('❌ Queue entry not found');
      process.exit(1);
    }

    if (entry.status === 'deploying') {
      console.log('🚀 Deploying model...');
    } else if (entry.status === 'benchmarking') {
      console.log('📊 Running benchmarks...');
    }

    if (entry.status === 'completed') {
      console.log('✅ Benchmark complete!');
      return;
    }
    if (entry.status === 'failed') {
      console.error(`❌ Failed: ${entry.errorMessage || 'Unknown error'}`);
      process.exit(1);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  console.error('❌ Timeout after 1 hour');
  process.exit(1);
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

// ─── vm-status command ─────────────────────────────────────────────────────

program
  .command('vm-status')
  .description('Check GPU VM availability and queue length')
  .action(async (options) => {
    const config = loadAppConfig(options);
    if (!config) process.exit(1);

    const esClient = createEsClient(config);
    if (!esClient) {
      console.error('Error: Could not create Elasticsearch client');
      process.exit(1);
    }

    try {
      // Create VM manager (simplified - using config values)
      const vmManager = new VMResourceManagerService([{
        id: 'vm-1',
        host: config.ssh.host,
        port: config.ssh.port,
        username: config.ssh.username,
        gpus: `${config.hardwareProfile.gpuCount}x${config.hardwareProfile.gpuType}`,
      }]);

      const status = vmManager.getVMStatus();

      console.log('GPU VM Status\n');

      if (status.available.length > 0) {
        console.log('✅ AVAILABLE');
        status.available.forEach(vm => {
          console.log(`  ${vm.id}: ${vm.gpus}`);
        });
      } else {
        console.log('🔴 BUSY');
        status.busy.forEach(vm => {
          console.log(`  ${vm.id}: Running ${vm.modelId}`);
          console.log(`  Started: ${vm.startedAt}`);
        });
      }

      // Get queue info
      const queueService = new QueueService(esClient);
      const allEntries = await queueService.getQueue();

      console.log(`\nQueue Status:`);
      console.log(`  Total entries: ${allEntries.length}`);
      console.log(`  Pending: ${allEntries.filter(e => e.status === 'pending').length}`);
      console.log(`  Active: ${allEntries.filter(e => e.status === 'deploying' || e.status === 'benchmarking').length}`);
      console.log(`  Completed: ${allEntries.filter(e => e.status === 'completed').length}`);

    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await esClient.close();
    }
  });

// ─── Parse and Execute ─────────────────────────────────────────────────────────

program.parse(process.argv);

// Show help if no command provided
if (process.argv.length <= 2) {
  program.help();
}
