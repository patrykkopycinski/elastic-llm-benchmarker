#!/usr/bin/env node
import type { PipelineRun, Stage2Result } from './scheduler/pipeline-state.js';


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
import { readFileSync, writeFileSync, existsSync, openSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { Client } from '@elastic/elasticsearch';
import { loadConfig } from './config/index.js';
import { ElasticsearchResultsStore } from './services/elasticsearch-results-store.js';
import { ensureIndices } from './services/es-index-mappings.js';
import { ResultsStore } from './services/results-store.js';
import { QueueService } from './services/queue-service.js';
import { Scheduler } from './scheduler/scheduler.js';
import { Stage1WorkerImpl, Stage2WorkerImpl, Stage2Gate, Stage3WorkerImpl } from './worker/index.js';
import { KibanaRepoService } from './services/kibana-repo-service.js';
import { EvalSuiteRunner } from './services/eval-suite-runner.js';
import { Lockfile } from './utils/lockfile.js';
import { SSHClientPool } from './services/ssh-client.js';
import { VllmEngine } from './engines/vllm-engine.js';
import { createLogger } from './utils/logger.js';
import { registerIngestPipelines } from './services/es-ingest-pipelines.js';
import { TraceQueryBuilderImpl } from './services/trace-query-builder.js';
import { LocalTraceQueryBuilder } from './services/local-trace-query-builder.js';
import { CompositeTraceQueryBuilder } from './services/composite-trace-query-builder.js';
import { ReasoningPromptBuilderImpl } from './services/reasoning-prompt-builder.js';
import { LlmClientImpl } from './services/llm-client.js';
import type { LlmClient } from './services/llm-client.js';
import { EisLlmClient } from './services/eis-llm-client.js';
import type { BenchmarkResult } from './types/benchmark.js';
import type { ModelBenchmarkSummary } from './services/elasticsearch-results-store.js';
import type { AppConfig } from './types/config.js';
import { ToolCallBenchmarkService } from './services/tool-call-benchmark.js';
import { buildDeployCommandWithToolCalling } from './services/vllm-deployment.js';
import { ConfigResearcherService } from './services/config-researcher.js';
import { runEnqueue } from './cli/enqueue-handler.js';
import { buildRecommendationReport } from './services/recommendation-report-builder.js';
import {
  mapBuildkiteResultToStage2,
  mergeStage2Results,
} from './services/ci-eval-stage2-mapper.js';
import type { BuildkiteBuildResult } from './services/buildkite-eval-trigger.js';
import { SystemHealthChecker } from './services/system-health-check.js';
import { SlackNotifier } from './services/slack-notifier.js';
import { LocalConnector } from './services/local-connector.js';
import { DiscoveryScheduler } from './services/discovery-scheduler.js';
import { createAgentBuilderFilter } from './services/agent-builder-baseline.js';
import { ModelDiscoveryService } from './services/model-discovery.js';
import { HardwareEstimator } from './services/hardware-estimator.js';
import { HardwareProfileRegistry } from './services/hardware-profiles.js';
import { ModelSmokeTestImpl } from './services/model-smoke-test.js';
import { BuildkiteEvalTriggerImpl } from './services/buildkite-eval-trigger.js';
import { recoverOrFailActiveEntries } from './services/ci-eval-resume.js';
import type { CIEvalsOptions } from './scheduler/scheduler.js';

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
 * Prefer the `start` subcommand's `--config` from raw argv over the program-level default.
 */
function resolveStartConfigPath(fallback: string): string {
  if (process.env['BENCHMARKER_CONFIG']) {
    return process.env['BENCHMARKER_CONFIG'];
  }
  const args = process.argv.slice(2);
  const startIdx = args.indexOf('start');
  const searchFrom = startIdx >= 0 ? startIdx + 1 : 0;
  for (let i = searchFrom; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1] !== undefined) {
      return args[i + 1]!;
    }
  }
  return fallback;
}

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

const _binaryName = basename(process.argv[1] ?? '');

if (_binaryName !== 'benchmarker-queue') {
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
  .option('--image <image>', 'vLLM Docker image', 'vllm/vllm-openai:latest')
  .option('--tensor-parallel <n>', 'Tensor parallel size (GPUs)', '2')
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
  .option('--image <image>', 'vLLM Docker image', 'vllm/vllm-openai:latest')
  .option('--tensor-parallel <n>', 'Tensor parallel size', '2')
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

// ─── recommend command ─────────────────────────────────────────────────

program
  .command('recommend')
  .description('Get the latest recommendation report for a model')
  .option('--model <id>', 'Model ID to get recommendation for')
  .option('--verdict <verdict>', 'Filter by verdict (support | investigate | reject)')
  .option('--limit <n>', 'Number of reports to return', '10')
  .option('--format <fmt>', 'Output format: json or text', 'text')
  .action(async (opts) => {
    const globalOpts = program.opts();
    const jsonOutput = (globalOpts['json'] as boolean) || opts['format'] === 'json';
    const config = loadAppConfig({ config: globalOpts['config'] as string, json: jsonOutput });
    const esClient = createEsClient(config);
    if (!esClient) {
      outputError('Cannot connect to Elasticsearch. Check config.', jsonOutput);
      process.exit(1);
    }

    const store = new ElasticsearchResultsStore(esClient);
    await store.initialize();

    try {
      const modelId = opts['model'] as string | undefined;

      if (modelId) {
        const report = await store.getLatestRecommendation(modelId);
        if (!report) {
          outputError(`No recommendation found for ${modelId}`, jsonOutput);
          process.exit(1);
        }
        if (jsonOutput) {
          output(report, true);
        } else {
          printReport(report);
        }
      } else {
        const reports = await store.queryRecommendations({
          verdict: opts['verdict'] as string | undefined,
          limit: parseInt(opts['limit'] as string, 10),
        });

        if (reports.length === 0) {
          if (jsonOutput) {
            output({ total: 0, data: [] }, true);
          } else {
            console.error('No recommendation reports found.');
          }
          return;
        }

        if (jsonOutput) {
          output({ total: reports.length, data: reports }, true);
        } else {
          console.error(`Found ${reports.length} recommendation report(s):\n`);
          for (const r of reports) {
            printReportSummary(r);
          }
        }
      }
    } finally {
      await store.close();
    }
  });

// ─── regenerate-recommendation command ──────────────────────────────────
// Rebuilds a model's recommendation report from persisted Stage 1/2/3 data
// WITHOUT re-running any Buildkite builds. Use after a scoring-logic fix (e.g.
// the per-suite score-extraction bug) to give an already-evaluated model its
// corrected verdict. All inputs are read from ES — nothing is fabricated.
program
  .command('regenerate-recommendation')
  .description("Rebuild a model's recommendation from persisted Stage 1/2/3 data (no build re-run)")
  .requiredOption('--model <id>', 'Model ID to regenerate the recommendation for')
  .action(async (opts) => {
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
      if (latestBySuite.size === 0) {
        outputError(`No terminal CI eval builds found for run ${prior.runId}`, jsonOutput);
        process.exit(1);
      }

      const perSuiteStage2: Stage2Result[] = [];
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
  });

function createLlmClient(config: AppConfig, esClient: Client, logger: ReturnType<typeof createLogger>): LlmClient | undefined {
  const es = config.elasticsearch;
  const esAuthHeader = es.apiKey
    ? `ApiKey ${es.apiKey}`
    : es.username && es.password
      ? `Basic ${Buffer.from(`${es.username}:${es.password}`).toString('base64')}`
      : undefined;

  // Use EIS when a CCM key is explicitly set (self-managed activation), or when
  // the ES cluster is API-key authed (serverless/cloud provisions EIS natively,
  // so no CCM key is needed). An explicit llmApiKey still wins over the
  // serverless-native fallback.
  const useEis = Boolean(config.eisApiKey) || (Boolean(es.apiKey) && !config.llmApiKey);
  if (useEis) {
    logger.info('Stage 3 reasoning: using EIS (Elastic Inference Service)', {
      model: config.eisModel,
      ccm: config.eisApiKey ? 'key-provided' : 'native',
    });
    return new EisLlmClient(
      esClient,
      config.eisApiKey,
      config.eisModel,
      es.url ?? 'http://localhost:9223',
      esAuthHeader,
      logger,
    );
  }
  if (config.llmApiKey) {
    logger.info('Stage 3 reasoning: using OpenAI-compatible LLM', { model: config.llmModel });
    return new LlmClientImpl(config, logger);
  }
  logger.warn('Stage 3 reasoning: no LLM configured (set EIS_CCM_API_KEY or LLM_API_KEY)');
  return undefined;
}

function printReport(r: { modelId: string; verdict: string; confidence: string; hardwareProfile: string; stage1Passed: boolean; stage2Ran: boolean; stage2Passed: boolean | null; stage3Ran: boolean; stage1Metrics: { itl: { p50: number }; ttft: { p50: number }; throughputTps: number } | null; passingEvals: Array<{ suite: string; score: number; threshold: number; passed: boolean }>; blockingIssues: Array<{ severity: string; message: string }>; suggestions: Array<{ title: string; description: string }>; evaluatedAt: string; runId: string }): void {
  const verdictColor = r.verdict === 'support' ? '\x1b[32m' : r.verdict === 'reject' ? '\x1b[31m' : '\x1b[33m';
  console.error(`\n=== Recommendation Report: ${r.modelId} ===\n`);
  console.error(`  Verdict:    ${verdictColor}${r.verdict.toUpperCase()}\x1b[0m`);
  console.error(`  Confidence: ${r.confidence}`);
  console.error(`  Hardware:   ${r.hardwareProfile}`);
  console.error(`  Evaluated:  ${r.evaluatedAt}`);
  console.error(`  Run ID:     ${r.runId}`);
  console.error('');
  console.error(`  Stage 1: ${r.stage1Passed ? 'PASSED' : 'FAILED'}`);
  if (r.stage1Metrics) {
    console.error(`    ITL p50:     ${r.stage1Metrics.itl.p50.toFixed(1)}ms`);
    console.error(`    TTFT:        ${r.stage1Metrics.ttft.p50.toFixed(1)}ms`);
    console.error(`    Throughput:  ${r.stage1Metrics.throughputTps.toFixed(1)} tps`);
  }
  console.error(`  Stage 2: ${r.stage2Ran ? (r.stage2Passed ? 'PASSED' : 'FAILED') : 'NOT RUN'}`);
  if (r.passingEvals.length > 0) {
    for (const e of r.passingEvals) {
      const status = e.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.error(`    [${status}] ${e.suite}: ${(e.score * 100).toFixed(0)}% (threshold: ${(e.threshold * 100).toFixed(0)}%)`);
    }
  }
  console.error(`  Stage 3: ${r.stage3Ran ? 'COMPLETED' : 'NOT RUN'}`);
  if (r.blockingIssues.length > 0) {
    console.error('\n  Blocking Issues:');
    for (const i of r.blockingIssues) {
      console.error(`    [${i.severity}] ${i.message}`);
    }
  }
  if (r.suggestions.length > 0) {
    console.error('\n  Suggestions:');
    for (const s of r.suggestions) {
      console.error(`    - ${s.title}: ${s.description}`);
    }
  }
  console.error('');
}

function printReportSummary(r: { modelId: string; verdict: string; confidence: string; evaluatedAt: string; stage1Passed: boolean; stage2Ran: boolean }): void {
  const verdictColor = r.verdict === 'support' ? '\x1b[32m' : r.verdict === 'reject' ? '\x1b[31m' : '\x1b[33m';
  const stages = `S1:${r.stage1Passed ? 'Y' : 'N'} S2:${r.stage2Ran ? 'Y' : '-'}`;
  console.error(`  ${verdictColor}${r.verdict.toUpperCase().padEnd(12)}\x1b[0m ${r.modelId.padEnd(40)} [${r.confidence}] ${stages}  ${r.evaluatedAt}`);
}

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

if (_binaryName === 'benchmarker-queue') {
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
      const configPath = resolveStartConfigPath(opts['config'] as string);
      const pollInterval = parseInt(opts['pollInterval'] as string, 10);
      const enableStage2 = opts['stage2'] as boolean;
      const enableStage3 = opts['stage3'] as boolean;
      const enableDiscovery = opts['discovery'] as boolean;
      const enableCIEvals = opts['ciEvals'] as boolean;
      const daemonize = opts['daemonize'] as boolean;
      const clearPending = opts['clearPending'] as boolean;
      const enqueueAfterClear = opts['enqueueAfterClear'] as string | undefined;
      const queueModel = opts['queueModel'] as string | undefined;
      const connectorType = opts['connector'] as string;
      const outputDir = opts['outputDir'] as string;
      const useLocalConnector = connectorType === 'local';

      // Load config first — needed for both one-off enqueue and scheduler start
      const config = loadAppConfig({ config: configPath, json: false });
      if (!config) process.exit(1);

      if (daemonize && !queueModel) {
        const absConfigPath = resolve(process.cwd(), configPath);
        const childArgs = process.argv.slice(2).filter((arg) => arg !== '--daemonize');
        for (let i = 0; i < childArgs.length; i++) {
          if (childArgs[i] === '--config' || childArgs[i] === '-c') {
            childArgs[i + 1] = absConfigPath;
          }
        }
        if (!childArgs.includes(absConfigPath)) {
          const startIdx = childArgs.indexOf('start');
          const insertAt = startIdx >= 0 ? startIdx + 1 : 0;
          childArgs.splice(insertAt, 0, '--config', absConfigPath);
        }
        const cliEntry = process.argv[1] ?? resolve(process.cwd(), 'dist/cli.js');
        const logPath = resolve(process.cwd(), '.smoke-logs/daemon.log');
        mkdirSync(dirname(logPath), { recursive: true });
        const logFd = openSync(logPath, 'a');
        const child = spawn(process.execPath, [cliEntry, ...childArgs], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: process.env,
          cwd: process.cwd(),
        });
        child.unref();
        console.log(`benchmarker-queue daemon started (pid ${child.pid ?? 'unknown'}, log ${logPath})`);
        process.exit(0);
      }

      // Keep the event loop alive when stdin is closed (agent shells, nohup, launchd).
      if (process.stdin.isTTY !== true) {
        process.stdin.resume();
      }

      // One-off enqueue mode (for CI)
      if (queueModel) {
        const esClient = createEsClient(config);
        if (!esClient) {
          console.error('Error: Could not create Elasticsearch client');
          process.exit(1);
        }

        try {
          const result = await runEnqueue({
            modelId: queueModel,
            config,
            esClient,
            hardwareProfileId: config.hardwareProfileId,
            priority: 5,
          });

          if (!result.success) {
            console.error(`Error: ${result.message}`);
            await esClient.close();
            process.exit(1);
          }

          console.log(result.message);
          if (result.dryRun) {
            console.log(
              `Dry-run: estimated ${result.dryRun.estimatedGb.toFixed(2)} GB / available ${result.dryRun.availableGb.toFixed(2)} GB (${result.dryRun.fits ? 'fits' : 'does not fit'})`,
            );
          }
          await esClient.close();
          process.exit(0);
        } catch (error) {
          console.error('Error:', error instanceof Error ? error.message : String(error));
          await esClient.close();
          process.exit(1);
        }
      }

      // Lockfile check (only when actually starting the scheduler)
      const lockfile = new Lockfile({ path: '.benchmarker-queue.lock' });
      if (!lockfile.acquire()) {
        console.error('Error: benchmarker-queue is already running (lockfile exists)');
        process.exit(1);
      }

      // Pre-flight health check — pass config values as env vars
      try {
        const healthEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          ELASTICSEARCH_URL: config.elasticsearch.url,
          SSH_HOST: config.ssh.host,
          SSH_PORT: String(config.ssh.port),
          SSH_USERNAME: config.ssh.username,
        };
        if (config.ssh.privateKeyPath) {
          healthEnv['SSH_KEY_PATH'] = config.ssh.privateKeyPath;
        }
        execSync('bash scripts/health-check.sh', { stdio: 'inherit', env: healthEnv });
      } catch {
        lockfile.release();
        console.error('Error: Health check failed. Fix issues and try again.');
        process.exit(1);
      }

      const logger = createLogger(config.logLevel ?? 'info');
      logger.info('Config loaded successfully', {
        configPath: resolve(process.cwd(), configPath),
        buildkiteBranch: config.buildkite.kibanaBranch,
        evalSuites: config.buildkite.defaultEvalSuites,
      });

      // Create ES client
      const esClient = createEsClient(config);
      if (!esClient) {
        lockfile.release();
        console.error('Error: Could not create Elasticsearch client');
        process.exit(1);
      }

      // Ensure all ES indices exist with correct mappings
      await ensureIndices(esClient);
      logger.info('ES indices verified');

      // Create queue service
      const queueService = new QueueService(esClient);
      logger.info('Queue service ready');

      const resultsStore = new ElasticsearchResultsStore(esClient);

      const ciEvalsEnabled =
        (enableCIEvals || config.buildkite.enabled) && Boolean(config.buildkite.apiToken);

      if (ciEvalsEnabled && config.buildkite.apiToken) {
        const buildkiteTrigger = new BuildkiteEvalTriggerImpl(
          {
            apiToken: config.buildkite.apiToken,
            orgSlug: config.buildkite.orgSlug,
            onDemandPipelineSlug: config.buildkite.onDemandPipelineSlug,
            weeklyPipelineSlug: config.buildkite.weeklyPipelineSlug,
            pollIntervalMs: config.buildkite.pollIntervalMs,
            pollTimeoutMs: config.buildkite.pollTimeoutMs,
            retryOnFailure: config.buildkite.retryOnFailure,
            defaultEvalSuites: config.buildkite.defaultEvalSuites,
            kibanaBranch: config.buildkite.kibanaBranch,
            detachPoll: config.buildkite.detachPoll,
            adoptRunningBuild: config.buildkite.adoptRunningBuild,
            waitForPipelineIdle: config.buildkite.waitForPipelineIdle,
            pipelineIdleWaitMs: config.buildkite.pipelineIdleWaitMs,
            pipelineIdlePollMs: config.buildkite.pipelineIdlePollMs,
          },
          config.logLevel,
        );
        const { recovered, failed } = await recoverOrFailActiveEntries(
          queueService,
          resultsStore,
          buildkiteTrigger,
          config.buildkite.defaultEvalSuites ?? [],
          logger,
        );
        if (recovered > 0) {
          logger.info('Recovered in-flight CI eval queue entries after daemon restart', {
            recovered,
          });
        }
        if (failed > 0) {
          logger.warn('Cleared orphaned active queue entries before starting scheduler', {
            count: failed,
          });
        }
      } else {
        const orphanedActive = await queueService.failActiveEntries(
          'Orphaned active entry — previous daemon exited before completion',
        );
        if (orphanedActive > 0) {
          logger.warn('Cleared orphaned active queue entries before starting scheduler', {
            count: orphanedActive,
          });
        }
      }

      if (clearPending) {
        const cancelled = await queueService.cancelAllPending();
        if (cancelled > 0) {
          logger.info('Cancelled pending queue entries before starting scheduler', {
            count: cancelled,
          });
        }
      }

      if (enqueueAfterClear) {
        const enqueueResult = await runEnqueue({
          modelId: enqueueAfterClear,
          config,
          esClient,
          hardwareProfileId: config.hardwareProfileId,
          priority: 999,
          force: true,
        });
        if (!enqueueResult.success) {
          lockfile.release();
          logger.error('Failed to enqueue validation model after clear-pending', {
            modelId: enqueueAfterClear,
            error: enqueueResult.message,
          });
          process.exit(1);
        }
        logger.info('Enqueued validation model after clear-pending', {
          modelId: enqueueAfterClear,
          queueEntryId: enqueueResult.entryId,
        });
      }

      // Create worker dependencies
      const sshPool = new SSHClientPool({}, config.logLevel ?? 'info');
      const vllmEngine = new VllmEngine(sshPool, config.logLevel ?? 'info', {
        deployment: {
          dockerImage: config.engine?.dockerImage,
          gpuMemoryUtilization: config.engine?.vllmGpuMemoryUtilization,
          maxModelLen: config.engine?.maxModelLen,
          huggingfaceToken: config.huggingfaceToken,
          useSudo: config.ssh.useSudo,
          healthCheckTimeoutMs: config.benchmarkThresholds.healthCheckTimeoutSeconds * 1000,
          // Emit vLLM OTLP traces to the EDOT collector when configured. vLLM runs
          // in a bridge-network container on the remote VM, so the endpoint is
          // resolved from the container's perspective (host.docker.internal) and
          // reaches the local collector via a reverse SSH tunnel.
          otlpTracesEndpoint: config.edotCollector.vllmOtlpTracesEndpoint,
        },
      });

      // ciEvalsEnabled computed above for startup recovery

      // Optionally create Stage 2 worker (local Kibana clone path — skipped when CI evals are enabled)
      const stage2Worker =
        (enableStage2 || config.enableStage2) && !ciEvalsEnabled
          ? new Stage2WorkerImpl({
              config,
              gate: new Stage2Gate(config),
              repoService: new KibanaRepoService({ config, logger }),
              evalRunner: new EvalSuiteRunner({ esStore: resultsStore, logger }),
              resultsStore,
              logger,
            })
          : undefined;

      if (stage2Worker) {
        logger.info('Stage 2 local eval pipeline enabled');
      } else if ((enableStage2 || config.enableStage2) && ciEvalsEnabled) {
        logger.info('Stage 2 uses Buildkite Kibana CI evals (local eval-suite-runner disabled)');
      }

      // Optionally create Stage 3 worker
      let stage3Worker: Stage3WorkerImpl | undefined;
      if (enableStage3) {
        const llmClient = createLlmClient(config, esClient, logger);
        if (llmClient) {
          stage3Worker = new Stage3WorkerImpl({
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
          logger.info('Stage 3 reasoning pipeline enabled');
        }
      }

      // Optionally create Slack notifier
      const slackWebhookUrl = config.notifications.webhook.url;
      const slackNotifier = slackWebhookUrl && config.notifications.webhook.enabled
        ? new SlackNotifier({ webhookUrl: slackWebhookUrl, logLevel: config.logLevel })
        : undefined;

      if (slackNotifier) {
        logger.info('Slack notifications enabled');
      }

      // Local connector mode
      if (useLocalConnector) {
        const localConnector = new LocalConnector({ outputDir, logLevel: config.logLevel });
        const initResult = await localConnector.initialize();
        if (!initResult.success) {
          logger.error('Failed to initialize local connector', { error: initResult.error });
          lockfile.release();
          process.exit(1);
        }
        logger.info('Local connector initialized', { outputDir });
      }

      // Start HuggingFace model discovery scheduler (auto-discovers and queues models)
      let discoveryScheduler: DiscoveryScheduler | undefined;
      if (enableDiscovery || config.discoveryScheduler.enabled) {
        const profileRegistry = new HardwareProfileRegistry();
        const existingResults = await resultsStore.query({ limit: 10000 });
        const evaluatedIds = [...new Set(existingResults.map((r) => r.modelId))];

        const discoveryService = new ModelDiscoveryService(
          config.huggingfaceToken,
          evaluatedIds,
          config.logLevel,
          config.vmHardwareProfile,
        );

        discoveryScheduler = new DiscoveryScheduler({
          discoveryService,
          hardwareEstimator: new HardwareEstimator(),
          profileRegistry,
          queueService,
          config: config.discoveryScheduler,
          candidateFilter: config.agentBuilderBaseline.enabled
            ? createAgentBuilderFilter(config)
            : undefined,
          logger,
        });
        discoveryScheduler.start();
        logger.info(
          `HuggingFace discovery scheduler started (interval: ${config.discoveryScheduler.intervalMinutes} min)`,
        );
      } else {
        logger.info('HuggingFace discovery scheduler disabled (set discoveryScheduler.enabled=true to enable)');
      }

      // Optionally create CI evals pipeline
      let ciEvalsOptions: CIEvalsOptions | undefined;
      if ((enableCIEvals || config.buildkite.enabled) && config.buildkite.apiToken) {
        const smokeTest = new ModelSmokeTestImpl(config.smokeTest, config.logLevel);
        const buildkiteTrigger = new BuildkiteEvalTriggerImpl({
          apiToken: config.buildkite.apiToken,
          orgSlug: config.buildkite.orgSlug,
          onDemandPipelineSlug: config.buildkite.onDemandPipelineSlug,
          weeklyPipelineSlug: config.buildkite.weeklyPipelineSlug,
          pollIntervalMs: config.buildkite.pollIntervalMs,
          pollTimeoutMs: config.buildkite.pollTimeoutMs,
          retryOnFailure: config.buildkite.retryOnFailure,
          defaultEvalSuites: config.buildkite.defaultEvalSuites,
          kibanaBranch: config.buildkite.kibanaBranch,
          detachPoll: config.buildkite.detachPoll,
          adoptRunningBuild: config.buildkite.adoptRunningBuild,
          waitForPipelineIdle: config.buildkite.waitForPipelineIdle,
          pipelineIdleWaitMs: config.buildkite.pipelineIdleWaitMs,
          pipelineIdlePollMs: config.buildkite.pipelineIdlePollMs,
        }, config.logLevel);
        ciEvalsOptions = {
          enabled: true,
          detachPoll: config.buildkite.detachPoll,
          smokeTest,
          buildkiteTrigger,
          sshPool,
        };
        logger.info('CI eval pipeline enabled (on-demand security matrix suites only)');
        logger.info('Buildkite eval config', {
          kibanaBranch: config.buildkite.kibanaBranch,
          defaultEvalSuites: config.buildkite.defaultEvalSuites,
          kibanaRepoBranch: config.kibanaRepo.branch,
        });
      } else if (enableCIEvals) {
        logger.warn('CI evals requested but buildkite.apiToken is missing — skipping');
      }

      // Create scheduler
      const scheduler = new Scheduler(
        queueService,
        new Stage1WorkerImpl({
          config,
          queueService,
          resultsStore,
          vllmEngine,
          logger,
        }),
        { pollIntervalMs: pollInterval, maxConcurrentRuns: 1 },
        stage2Worker,
        resultsStore,
        stage3Worker,
        config,
        slackNotifier,
        vllmEngine,
        ciEvalsOptions,
      );

      logger.info(`Scheduler starting. Polling every ${pollInterval} ms...`);
      scheduler.start();

      // Graceful shutdown — ignore SIGHUP so agent/shell disconnect does not kill mid-Buildkite poll.
      process.on('SIGHUP', () => {
        logger.warn('Received SIGHUP — ignoring (daemon keeps running)');
      });

      // Graceful shutdown
      const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Stopping scheduler...`);
        discoveryScheduler?.stop();
        await scheduler.stop();
        lockfile.release();
        await resultsStore.close();
        await esClient.close();
        logger.info('Shutdown complete.');
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
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
