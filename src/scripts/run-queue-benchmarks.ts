#!/usr/bin/env tsx
/**
 * Direct benchmark runner that processes the ES queue by deploying each model
 * via SSH/vLLM, running throughput + tool-call benchmarks, and storing results
 * to Elasticsearch.
 *
 * Tool call benchmarks route through an SSH tunnel because the VM's port 8000
 * is not exposed externally (GCP firewall).
 */

import { loadConfig } from '../config/index.js';
import { Client } from '@elastic/elasticsearch';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { QueueService } from '../services/queue-service.js';
import { SSHClientPool } from '../services/ssh-client.js';
import { createEngine } from '../engines/engine-factory.js';
import { ToolCallBenchmarkService } from '../services/tool-call-benchmark.js';
import type { ModelInfo, ToolCallResult, BenchmarkResult } from '../types/benchmark.js';
import type { EngineDeploymentResult, EngineFullBenchmarkResult } from '../engines/engine-types.js';
import type { SSHConfig, VMHardwareProfile } from '../types/config.js';
import { createLogger } from '../utils/logger.js';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';

const logger = createLogger();
const TUNNEL_LOCAL_PORT = 18000;

function startSSHTunnel(sshConfig: SSHConfig): ChildProcess {
  const args = [
    '-N', '-L', `${TUNNEL_LOCAL_PORT}:localhost:8000`,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-p', String(sshConfig.port),
  ];
  if (sshConfig.privateKeyPath) {
    args.push('-i', sshConfig.privateKeyPath);
  }
  args.push(`${sshConfig.username}@${sshConfig.host}`);

  const proc = spawn('ssh', args, { stdio: 'pipe' });
  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) logger.debug(`SSH tunnel stderr: ${msg}`);
  });
  return proc;
}

async function waitForTunnel(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(TUNNEL_LOCAL_PORT, '127.0.0.1', () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
        sock.setTimeout(1000, () => { sock.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

function buildEsAuth(es: { apiKey?: string; username?: string; password?: string }) {
  if (es.apiKey) return { apiKey: es.apiKey };
  if (es.username && es.password) return { username: es.username, password: es.password };
  return undefined;
}

function getModelParamsBillions(modelId: string): number | null {
  const match = modelId.match(/(\d+(?:\.\d+)?)[Bb]/);
  return match ? Number(match[1]) : null;
}

function buildBenchmarkResult(
  model: ModelInfo,
  deployment: EngineDeploymentResult,
  engineResult: EngineFullBenchmarkResult,
  hardwareProfile: VMHardwareProfile,
  toolCallResults: ToolCallResult | null = null,
): BenchmarkResult {
  return {
    modelId: model.id,
    timestamp: deployment.timestamp,
    vllmVersion: deployment.engineImage,
    dockerCommand: deployment.deploymentCommand,
    hardwareConfig: {
      gpuType: hardwareProfile.gpuType,
      gpuCount: hardwareProfile.gpuCount,
      ramGb: hardwareProfile.ramGb,
      cpuCores: hardwareProfile.cpuCores,
      diskGb: hardwareProfile.diskGb,
      machineType: hardwareProfile.machineType,
      hardwareProfileId: null,
    },
    benchmarkMetrics: engineResult.runs
      .filter((r) => r.success)
      .map((r) => r.metrics),
    toolCallResults,
    passed: engineResult.passed,
    rejectionReasons: engineResult.rejectionReasons,
    tensorParallelSize: deployment.parallelismConfig,
    toolCallParser: deployment.toolCallParser,
    rawOutput: engineResult.combinedRawOutput,
    gpuUtilization: deployment.gpuUtilization ?? null,
  };
}

async function main() {
  const config = loadConfig();
  const es = config.elasticsearch;
  const auth = buildEsAuth(es);
  const esClient = es.cloudId
    ? new Client({ cloud: { id: es.cloudId }, ...(auth ? { auth } : {}) })
    : new Client({ node: es.url, ...(auth ? { auth } : {}) });

  const resultsStore = new ElasticsearchResultsStore(esClient, config.logLevel);
  await resultsStore.initialize();

  const queueService = new QueueService(esClient);
  const sshPool = new SSHClientPool({}, config.logLevel);

  const eng = config.engine;
  const engine = createEngine(eng.type, sshPool, config.logLevel, {
    deployment: {
      apiPort: eng.apiPort,
      dockerImage: eng.dockerImage,
      ...(eng.type === 'ollama'
        ? { useDocker: eng.ollamaUseDocker, numGpuLayers: eng.ollamaNumGpuLayers }
        : {
            gpuMemoryUtilization: eng.vllmGpuMemoryUtilization,
            maxModelLen: eng.maxModelLen,
            huggingfaceToken: config.huggingfaceToken,
            useSudo: config.ssh.useSudo,
          }),
    },
  });

  const entries = await queueService.getQueue({ status: 'pending' });
  logger.info(`Found ${entries.length} pending models in queue`);

  if (entries.length === 0) {
    logger.info('Nothing to benchmark. Exiting.');
    await resultsStore.close();
    await sshPool.close();
    return;
  }

  let completed = 0;
  let failed = 0;

  for (const entry of entries) {
    const modelId = entry.modelId;
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`[${completed + failed + 1}/${entries.length}] Benchmarking: ${modelId}`);
    logger.info('='.repeat(60));

    const model: ModelInfo = {
      id: modelId,
      name: modelId.split('/').pop() ?? modelId,
      architecture: 'unknown',
      contextWindow: 0,
      license: '',
      parameterCount: null,
      quantizations: [],
      supportsToolCalling: false,
    };

    try {
      // Mark as deploying
      await queueService.dequeue();

      // 1. Deploy
      await resultsStore.saveCheckpoint({
        modelId, eventType: 'deployment_started', engineType: 'vllm', host: config.ssh.host,
      });
      logger.info(`Deploying model: ${modelId}`);
      const deployment = await engine.deploy(
        config.ssh,
        model,
        config.vmHardwareProfile,
      );
      await resultsStore.saveCheckpoint({
        modelId, eventType: 'deployment_ready', engineType: 'vllm',
        host: config.ssh.host,
        containerId: deployment.deploymentId,
        containerName: deployment.deploymentName,
      });
      logger.info(`Model deployed: ${modelId}`, {
        apiEndpoint: deployment.apiEndpoint,
        maxModelLen: deployment.maxModelLen,
      });

      // 2. Run throughput benchmarks
      const currentEntry = await queueService.getCurrent();
      if (currentEntry) {
        await queueService.updateStatus(currentEntry.id, 'benchmarking');
      }

      await resultsStore.saveCheckpoint({
        modelId, eventType: 'benchmark_started', engineType: 'vllm',
      });

      const parameterCountBillions = getModelParamsBillions(modelId);

      logger.info(`Running throughput benchmarks for: ${modelId}`);
      const engineResult = await engine.runBenchmarks(
        config.ssh,
        modelId,
        config.benchmarkThresholds.concurrencyLevels,
        config.benchmarkThresholds,
        deployment.deploymentName,
        parameterCountBillions,
      );
      logger.info(`Throughput benchmarks completed: ${modelId}`, {
        passed: engineResult.passed,
        runs: engineResult.runs.length,
      });

      // 3. Run tool-call benchmarks via SSH tunnel (VM port 8000 is firewalled)
      let toolCallResults: ToolCallResult | null = null;
      if (engine.supportsToolCalling(model)) {
        let tunnel: ChildProcess | null = null;
        try {
          logger.info(`Starting SSH tunnel for tool-call benchmarks: ${modelId}`);
          tunnel = startSSHTunnel(config.ssh);
          const tunnelReady = await waitForTunnel();
          if (!tunnelReady) {
            throw new Error('SSH tunnel failed to become ready within 15s');
          }
          logger.info('SSH tunnel established on localhost:' + TUNNEL_LOCAL_PORT);

          const toolCallBenchmark = new ToolCallBenchmarkService({
            baseUrl: `http://127.0.0.1:${TUNNEL_LOCAL_PORT}`,
            model: modelId,
            logLevel: 'info',
          });
          const toolReport = await toolCallBenchmark.runBenchmark();
          toolCallResults = toolReport.toolCallResult;
          logger.info(`Tool call benchmark completed for ${modelId}`, {
            supportsParallelCalls: toolCallResults.supportsParallelCalls,
            successRate: (toolCallResults.successRate * 100).toFixed(1) + '%',
          });
        } catch (toolErr) {
          logger.warn(`Tool call benchmark failed for ${modelId}`, {
            error: toolErr instanceof Error ? toolErr.message : String(toolErr),
          });
        } finally {
          if (tunnel && !tunnel.killed) {
            tunnel.kill();
            logger.debug('SSH tunnel closed');
          }
        }
      }

      // 4. Build and store result
      const result = buildBenchmarkResult(
        model,
        deployment,
        engineResult,
        config.vmHardwareProfile,
        toolCallResults,
      );

      await resultsStore.save(result);
      await resultsStore.saveCheckpoint({
        modelId, eventType: 'benchmark_completed', engineType: 'vllm',
      });
      await queueService.updateStatus(entry.id, 'completed');
      completed++;
      logger.info(`Stored results for: ${modelId} (passed: ${result.passed})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to benchmark ${modelId}: ${message}`);
      try {
        await resultsStore.saveCheckpoint({
          modelId, eventType: 'deployment_failed', engineType: 'vllm',
          error: { message, category: 'benchmark_error' },
        });
        await queueService.updateStatus(entry.id, 'failed', message);
      } catch {
        // ignore
      }
      failed++;
    }

    // Always stop and remove ALL containers between models (even on error)
    try {
      await resultsStore.saveCheckpoint({ modelId, eventType: 'teardown_started', engineType: 'vllm' });
      logger.info('Cleaning up all vLLM containers before next model...');
      // Force-remove all vLLM containers (running or stopped) 
      await sshPool.exec(config.ssh, 'docker ps -aq --filter "ancestor=vllm/vllm-openai" | xargs -r docker rm -f 2>/dev/null || true');
      // Also force-remove by name pattern in case ancestor filter misses some
      await sshPool.exec(config.ssh, 'docker ps -aq --filter "name=vllm-model" | xargs -r docker rm -f 2>/dev/null || true');
      // Wait for port to actually free up (kernel takes time to release TCP ports)
      logger.info('Waiting 10s for port release...');
      await new Promise((r) => setTimeout(r, 10000));
      // Verify port is free
      const portCheck = await sshPool.exec(config.ssh, 'ss -tlnp | grep :8000 || echo "PORT_FREE"');
      logger.info(`Port 8000 status: ${portCheck.stdout.trim()}`);
    } catch (cleanupErr) {
      logger.warn('Cleanup error (continuing anyway)', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
  }

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`Benchmark run complete: ${completed} succeeded, ${failed} failed out of ${entries.length}`);
  logger.info('='.repeat(60));

  await resultsStore.close();
  await sshPool.close();
}

main().catch((err) => {
  logger.error('Fatal error', { err });
  process.exit(1);
});
