import { Client } from '@elastic/elasticsearch';
import type { SSHConfig, AppConfig, VMHardwareProfile, BenchmarkThresholds } from '../types/config.js';
import { loadConfig } from '../config/index.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { QueueService } from '../services/queue-service.js';
import { ElasticAgentService } from '../services/elastic-agent-service.js';
import { SSHClientPool } from '../services/ssh-client.js';
import { TunnelService } from '../services/tunnel-service.js';
import { KibanaConnectorService } from '../services/kibana-connector.js';
import { KibanaEvalRunner } from '../services/kibana-eval-runner.js';
import { ReasoningBenchmarkService } from '../services/reasoning-benchmark.js';
import type { InferenceEngine } from '../engines/engine-types.js';
import { createEngine } from '../engines/engine-factory.js';

export interface BenchmarkConfigurable {
  appConfig?: AppConfig;
  sshConfig?: SSHConfig;
  sshPool?: SSHClientPool;
  hardwareProfile?: VMHardwareProfile;
  thresholds?: BenchmarkThresholds;
  engine?: InferenceEngine;
  resultsStore?: ElasticsearchResultsStore;
  queueService?: QueueService;
  elasticAgentService?: ElasticAgentService;
  tunnelService?: TunnelService;
  kibanaConnectorService?: KibanaConnectorService;
  kibanaEvalRunner?: KibanaEvalRunner;
  reasoningBenchmark?: ReasoningBenchmarkService;
  huggingfaceToken?: string;
  maxDeploymentDurationMs?: number;
}

function buildEsAuth(es: AppConfig['elasticsearch']) {
  if (es.apiKey) return { apiKey: es.apiKey };
  if (es.username && es.password) return { username: es.username, password: es.password };
  return undefined;
}

function createEsClient(config: AppConfig): Client {
  const es = config.elasticsearch;
  const auth = buildEsAuth(es);
  if (es.cloudId) {
    return new Client({ cloud: { id: es.cloudId }, ...(auth ? { auth } : {}) });
  }
  return new Client({ node: es.url, ...(auth ? { auth } : {}) });
}

export async function createConfigurable(
  appConfig?: AppConfig,
): Promise<BenchmarkConfigurable> {
  const config = appConfig ?? loadConfig();
  const logLevel = config.logLevel;

  const esClient = createEsClient(config);
  const resultsStore = new ElasticsearchResultsStore(esClient, logLevel);
  await resultsStore.initialize();

  const queueService = new QueueService(esClient);
  const sshPool = new SSHClientPool({}, logLevel);

  let elasticAgentService: ElasticAgentService | undefined;
  if (config.elasticAgent.enabled) {
    elasticAgentService = new ElasticAgentService(sshPool, logLevel);
  }

  const eng = config.engine;
  const engine: InferenceEngine = createEngine(eng.type, sshPool, logLevel, {
    deployment: {
      apiPort: eng.apiPort,
      dockerImage: eng.dockerImage,
      ...(eng.type === 'ollama'
        ? { useDocker: eng.ollamaUseDocker, numGpuLayers: eng.ollamaNumGpuLayers }
        : { gpuMemoryUtilization: eng.vllmGpuMemoryUtilization, maxModelLen: eng.maxModelLen, huggingfaceToken: config.huggingfaceToken, useSudo: config.ssh.useSudo }),
    },
  });

  let tunnelService: TunnelService | undefined;
  if (config.tunnel.enabled) {
    tunnelService = new TunnelService({
      config: config.tunnel,
      logLevel,
    });
  }

  let kibanaConnectorService: KibanaConnectorService | undefined;
  let kibanaEvalRunner: KibanaEvalRunner | undefined;
  if (config.kibanaConnector.enabled) {
    kibanaConnectorService = new KibanaConnectorService({
      config: config.kibanaConnector,
      logLevel,
    });
    kibanaEvalRunner = new KibanaEvalRunner({
      kibanaConfig: config.kibanaConnector,
      evalConfig: config.kibanaEval,
      logLevel,
    });
  }

  const maxDeploymentDurationMs =
    config.benchmarkThresholds.healthCheckTimeoutSeconds * 1000;

  // Create reasoning benchmark service (uses local vLLM endpoint)
  const reasoningBenchmark = new ReasoningBenchmarkService({
    baseUrl: `http://localhost:${eng.apiPort || 8000}`,
    model: 'current-model', // Will be overridden by actual model ID
  });

  return {
    appConfig: config,
    sshConfig: config.ssh,
    sshPool,
    hardwareProfile: config.vmHardwareProfile,
    thresholds: config.benchmarkThresholds,
    engine,
    resultsStore,
    queueService,
    elasticAgentService,
    tunnelService,
    kibanaConnectorService,
    kibanaEvalRunner,
    reasoningBenchmark,
    huggingfaceToken: config.huggingfaceToken,
    maxDeploymentDurationMs,
  };
}

export async function destroyConfigurable(
  configurable: BenchmarkConfigurable,
): Promise<void> {
  await configurable.resultsStore?.close();
  await configurable.sshPool?.close();
}
