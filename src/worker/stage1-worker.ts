import type { PipelineRun, Stage1Result } from '../scheduler/pipeline-state.js';
import type {
  AppConfig,
  VMHardwareProfile,
  BenchmarkThresholds,
} from '../types/config.js';
import type { BenchmarkResult, ModelInfo } from '../types/benchmark.js';
import { HFCardParser } from '../services/hf-card-parser.js';
import type { VllmEngine } from '../engines/vllm-engine.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { QueueService } from '../services/queue-service.js';
import type { VllmDeploymentOptions } from '../services/vllm-deployment.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';
import type { EngineDeploymentResult } from '../engines/engine-types.js';
import type { Stage3Suggestion } from '../scheduler/pipeline-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Scans Stage 3 reasoning suggestions for vLLM deployment flag overrides.
 * Looks for CLI flags like `--gpu-memory-utilization 0.95` in suggestion
 * descriptions and maps them to VllmDeploymentOptions.
 */
function parseVllmOverridesFromSuggestions(
  suggestions: Stage3Suggestion[] | undefined,
): VllmDeploymentOptions | undefined {
  if (!suggestions || suggestions.length === 0) return undefined;

  const overrides: VllmDeploymentOptions = {};
  const extraArgs: string[] = [];

  for (const sug of suggestions) {
    const text = `${sug.title} ${sug.description}`;

    // --gpu-memory-utilization <float>
    const gpuMem = text.match(/--gpu-memory-utilization\s+(\d*(?:\.\d+)?)/);
    if (gpuMem) overrides.gpuMemoryUtilization = parseFloat(gpuMem[1]!);

    // --max-model-len <int>
    const maxLen = text.match(/--max-model-len\s+(\d+)/);
    if (maxLen) overrides.maxModelLen = parseInt(maxLen[1]!, 10);

    // --max-num-seqs <int>
    const maxSeqs = text.match(/--max-num-seqs\s+(\d+)/);
    if (maxSeqs) extraArgs.push(`--max-num-seqs ${maxSeqs[1]}`);

    // --dtype <str>
    const dtype = text.match(/--dtype\s+(\w+)/);
    if (dtype) extraArgs.push(`--dtype ${dtype[1]}`);

    // --chat-template <str>
    const chatTpl = text.match(/--chat-template\s+(\S+)/);
    if (chatTpl) overrides.chatTemplate = chatTpl[1]!;
  }

  if (extraArgs.length > 0) {
    overrides.additionalDockerArgs = extraArgs;
  }

  // Only return if at least one override was found
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * Interface for Stage 1 workers that execute the HF parse → deploy → benchmark
 * pipeline for a single model.
 */
export interface Stage1Worker {
  execute(run: PipelineRun): Promise<Stage1Result>;
}

/**
 * Dependencies required to construct a Stage1WorkerImpl.
 */
export interface Stage1WorkerDependencies {
  config: AppConfig;
  vllmEngine: VllmEngine;
  resultsStore: ElasticsearchResultsStore;
  queueService: QueueService;
  logger?: Logger;
}

/**
 * Implementation of the Stage 1 worker.
 *
 * Orchestrates:
 *  1. HF card parsing
 *  2. vLLM deployment
 *  3. Benchmark execution
 *  4. Result storage (Elasticsearch)
 *  5. Deployment teardown
 *  6. Queue status updates
 */
export class Stage1WorkerImpl implements Stage1Worker {
  private readonly config: AppConfig;
  private readonly vllmEngine: VllmEngine;
  private readonly resultsStore: ElasticsearchResultsStore;
  private readonly queueService: QueueService;
  private readonly logger: Logger;

  constructor(deps: Stage1WorkerDependencies) {
    this.config = deps.config;
    this.vllmEngine = deps.vllmEngine;
    this.resultsStore = deps.resultsStore;
    this.queueService = deps.queueService;
    this.logger = deps.logger ?? createLogger(deps.config.logLevel);
  }

  async execute(run: PipelineRun): Promise<Stage1Result> {
    const startTime = Date.now();
    let deployment: EngineDeploymentResult | null = null;

    const result: Stage1Result = {
      runId: run.runId,
      modelId: run.modelId,
      queueEntryId: run.queueEntryId,
      status: 'success',
      metrics: null,
      rawOutput: '',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    try {
      // a. Update queue entry status to 'deploying'
      this.logger.info('Stage 1: updating status to deploying', {
        modelId: run.modelId,
        queueEntryId: run.queueEntryId,
      });
      await this.queueService.updateStatus(run.queueEntryId, 'deploying');

      // b. Parse HF card
      this.logger.info('Stage 1: parsing HF card', { modelId: run.modelId });
      const cardParser = new HFCardParser();
      const parsedCard = await cardParser.parse({ modelId: run.modelId });
      this.logger.info('Stage 1: HF card parsed', {
        modelId: run.modelId,
        contextWindow: parsedCard.card.contextWindow,
        parameterCount: parsedCard.card.parameterCount,
      });

      // c. Build ModelInfo for vLLM engine from parsed card
      const modelInfo: ModelInfo = {
        id: parsedCard.card.modelId,
        name: parsedCard.card.name,
        architecture: parsedCard.card.architecture,
        contextWindow: parsedCard.card.contextWindow,
        license: parsedCard.card.license,
        parameterCount: parsedCard.card.parameterCount,
        quantizations: parsedCard.card.quantizations,
        supportsToolCalling: parsedCard.card.supportsToolCalling,
      };

      // d. Select default hardware profile (singular profile from config)
      const hardwareProfile: VMHardwareProfile = this.config.vmHardwareProfile;

      // e. Update queue entry status to 'benchmarking'
      this.logger.info('Stage 1: updating status to benchmarking', {
        modelId: run.modelId,
      });
      await this.queueService.updateStatus(run.queueEntryId, 'benchmarking');

      // f. Query previous reasoning feedback and deploy with any overrides
      this.logger.info('Stage 1: checking for previous reasoning feedback', {
        modelId: run.modelId,
      });
      let deploymentOverrides: VllmDeploymentOptions | undefined;
      try {
        const previousReasoning =
          await this.resultsStore.getLatestReasoningResult(run.modelId);
        if (previousReasoning?.suggestions) {
          deploymentOverrides = parseVllmOverridesFromSuggestions(
            previousReasoning.suggestions,
          );
          if (deploymentOverrides) {
            this.logger.info('Stage 1: applying reasoning overrides', {
              modelId: run.modelId,
              overrides: Object.keys(deploymentOverrides),
            });
          }
        }
      } catch (feedbackErr) {
        this.logger.warn('Stage 1: failed to load reasoning feedback', {
          modelId: run.modelId,
          error: feedbackErr instanceof Error ? feedbackErr.message : String(feedbackErr),
        });
      }

      this.logger.info('Stage 1: deploying model', { modelId: run.modelId });
      deployment = await this.vllmEngine.deploy(
        this.config.ssh,
        modelInfo,
        hardwareProfile,
        deploymentOverrides,
      );
      this.logger.info('Stage 1: model deployed', {
        deploymentName: deployment.deploymentName,
        apiEndpoint: deployment.apiEndpoint,
      });

      // g. Run benchmarks
      this.logger.info('Stage 1: running benchmarks', { modelId: run.modelId });
      const thresholds: BenchmarkThresholds = this.config.benchmarkThresholds;
      const concurrencyLevels = thresholds.concurrencyLevels;
      const paramBillions = modelInfo.parameterCount
        ? modelInfo.parameterCount / 1_000_000_000
        : null;

      const benchmarkResult = await this.vllmEngine.runBenchmarks(
        this.config.ssh,
        run.modelId,
        concurrencyLevels,
        thresholds,
        deployment.deploymentName,
        paramBillions ?? undefined,
      );
      this.logger.info('Stage 1: benchmarks completed', {
        modelId: run.modelId,
        passed: benchmarkResult.passed,
        runsCompleted: benchmarkResult.runs.length,
      });

      // h. Store results
      this.logger.info('Stage 1: storing results', { modelId: run.modelId });
      const benchmarkRecord: BenchmarkResult = {
        modelId: run.modelId,
        timestamp: new Date().toISOString(),
        vllmVersion: deployment.engineImage,
        dockerCommand: deployment.deploymentCommand,
        hardwareConfig: {
          gpuType: hardwareProfile.gpuType,
          gpuCount: hardwareProfile.gpuCount,
          ramGb: hardwareProfile.ramGb,
          cpuCores: hardwareProfile.cpuCores,
          diskGb: hardwareProfile.diskGb,
          machineType: hardwareProfile.machineType,
          hardwareProfileId: this.config.hardwareProfileId ?? null,
        },
        benchmarkMetrics: benchmarkResult.runs.map((r) => r.metrics),
        toolCallResults: null,
        passed: benchmarkResult.passed,
        rejectionReasons: benchmarkResult.rejectionReasons,
        tensorParallelSize: deployment.parallelismConfig,
        toolCallParser: deployment.toolCallParser,
        rawOutput: benchmarkResult.combinedRawOutput,
        gpuUtilization: deployment.gpuUtilization ?? null,
      };
      await this.resultsStore.save(benchmarkRecord);
      this.logger.info('Stage 1: results stored', { modelId: run.modelId });

      // Gate logic (Stage 2 eligibility)
      const successfulRuns = benchmarkResult.runs.filter((r) => r.success);
      const metrics = successfulRuns.map((r) => r.metrics);

      const avgItlP50 =
        metrics.length > 0
          ? metrics.reduce((sum, m) => sum + m.itlMs, 0) / metrics.length
          : Infinity;
      const throughput =
        metrics.length > 0
          ? Math.max(...metrics.map((m) => m.throughputTokensPerSec))
          : 0;
      const avgTtft =
        metrics.length > 0
          ? metrics.reduce((sum, m) => sum + m.ttftMs, 0) / metrics.length
          : Infinity;
      const contextWindow = parsedCard.card.contextWindow;

      const stage2Thresholds = this.config.stage2Thresholds;
      const stage2Eligible =
        avgItlP50 < stage2Thresholds.minItlP50Ms &&
        throughput > stage2Thresholds.minThroughputTps &&
        avgTtft < stage2Thresholds.maxTtftMs &&
        contextWindow >= stage2Thresholds.minContextWindow;

      this.logger.info('Stage 1: Stage 2 eligibility', {
        modelId: run.modelId,
        stage2Eligible,
        avgItlP50,
        throughput,
        avgTtft,
        contextWindow,
      });

      // Populate result fields
      result.status = benchmarkResult.passed ? 'success' : 'failed';
      result.rawOutput = benchmarkResult.combinedRawOutput;
      if (metrics.length > 0) {
        result.metrics = {
          itl_p50_ms: avgItlP50,
          itl_p99_ms:
            metrics.reduce((sum, m) => sum + m.p99LatencyMs, 0) / metrics.length,
          ttft_ms: avgTtft,
          throughput_tps: throughput,
          duration_sec: (Date.now() - startTime) / 1000,
        };
      }

      // i. Teardown deployment
      this.logger.info('Stage 1: stopping deployment', {
        deploymentName: deployment.deploymentName,
      });
      await this.vllmEngine.stop(this.config.ssh, deployment.deploymentName);
      deployment = null;
      this.logger.info('Stage 1: deployment stopped');

      // j. Update queue entry status to 'completed'
      await this.queueService.updateStatus(run.queueEntryId, 'completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Stage 1: execution failed', {
        modelId: run.modelId,
        error: message,
      });
      result.status = 'failed';
      result.error = message;
      try {
        await this.queueService.updateStatus(run.queueEntryId, 'failed', message);
      } catch (updateErr) {
        this.logger.error('Stage 1: failed to update queue status', {
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    } finally {
      // Always attempt teardown in finally block as a safety net
      if (deployment) {
        try {
          this.logger.info('Stage 1: cleaning up deployment in finally', {
            deploymentName: deployment.deploymentName,
          });
          await this.vllmEngine.stop(this.config.ssh, deployment.deploymentName);
          this.logger.info('Stage 1: deployment cleaned up');
        } catch (stopErr) {
          const stopMessage = stopErr instanceof Error ? stopErr.message : String(stopErr);
          this.logger.error('Stage 1: failed to stop deployment in finally', {
            error: stopMessage,
          });
        }
      }
    }

    result.completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    this.logger.info('Stage 1: execution finished', {
      modelId: run.modelId,
      status: result.status,
      durationMs,
    });

    return result;
  }
}
