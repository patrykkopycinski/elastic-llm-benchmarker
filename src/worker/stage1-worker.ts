import type { PipelineRun, Stage1Result } from '../scheduler/pipeline-state.js';
import type {
  AppConfig,
  VMHardwareProfile,
  BenchmarkThresholds,
} from '../types/config.js';
import { resolveMaxItlP50Ms, resolveMinToolCallSuccessRate } from '../types/config.js';
import type { BenchmarkResult, ModelInfo, ToolCallResult } from '../types/benchmark.js';
import { ToolCallBenchmarkService } from '../services/tool-call-benchmark.js';
import {
  startSSHTunnel,
  waitForTunnel,
  TUNNEL_BASE_URL,
} from '../utils/ssh-tunnel.js';
import { HFCardParser } from '../services/hf-card-parser.js';
import {
  enrichModelInfoFromHfConfig,
  normalizeParameterCount,
} from '../services/agent-builder-baseline.js';
import { ModelDiscoveryService } from '../services/model-discovery.js';
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

    // --gpu-memory-utilization <float> — require a numeric token (not prose like
    // "--gpu-memory-utilization to avoid OOM", which previously became NaN).
    const gpuMem = text.match(/--gpu-memory-utilization\s+(\d+(?:\.\d+)?|\.\d+)/);
    if (gpuMem) {
      const val = parseFloat(gpuMem[1]!);
      if (Number.isFinite(val) && val > 0 && val <= 1) {
        overrides.gpuMemoryUtilization = val;
      }
    }

    // --max-model-len <int>
    const maxLen = text.match(/--max-model-len\s+(\d+)/);
    if (maxLen) overrides.maxModelLen = parseInt(maxLen[1]!, 10);

    // --max-num-seqs <int>
    const maxSeqs = text.match(/--max-num-seqs\s+(\d+)/);
    if (maxSeqs) extraArgs.push(`--max-num-seqs ${maxSeqs[1]}`);

    // --dtype <str> — restrict to vLLM's actual accepted values so prose like
    // "--dtype should be bfloat16" can't capture the stopword "should" (see
    // chat-template guard below for the same prose-vs-literal failure mode).
    const dtype = text.match(/--dtype\s+(auto|half|float16|bfloat16|float|float32)\b/);
    if (dtype) extraArgs.push(`--dtype ${dtype[1]}`);

    // --chat-template <path>
    // Stage 3 suggestions are LLM-authored prose (e.g. "...potentially passing
    // --chat-template with the correct Mistral instruct template..."), not a
    // literal shell command. A bare `\S+` capture grabs the next English word
    // ("with") as if it were a real path, which vLLM then fails to load. Only
    // accept captures that actually look like a template path/file, never a
    // stopword — this deployed a broken container for Devstral-Small-2 in
    // production before the guard was added.
    const chatTpl = text.match(/--chat-template\s+(\S+)/);
    if (chatTpl && /^[\w./-]+\.jinja$|\//.test(chatTpl[1]!)) {
      overrides.chatTemplate = chatTpl[1]!;
    }
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
  /**
   * Override for the tool-call benchmark runner. Defaults to the real
   * SSH-tunnel + {@link ToolCallBenchmarkService} implementation
   * ({@link Stage1WorkerImpl.runToolCallBenchmark}). Injectable so unit tests
   * can exercise the Stage 2 tool-call gate without spawning a real tunnel.
   */
  toolCallBenchmarkRunner?: (modelId: string) => Promise<ToolCallResult | null>;
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
  private readonly toolCallBenchmarkRunner: (modelId: string) => Promise<ToolCallResult | null>;

  constructor(deps: Stage1WorkerDependencies) {
    this.config = deps.config;
    this.vllmEngine = deps.vllmEngine;
    this.resultsStore = deps.resultsStore;
    this.queueService = deps.queueService;
    this.logger = deps.logger ?? createLogger(deps.config.logLevel);
    this.toolCallBenchmarkRunner =
      deps.toolCallBenchmarkRunner ?? ((modelId) => this.runToolCallBenchmark(modelId));
  }

  private async resolveContextWindow(modelId: string, modelInfo: ModelInfo): Promise<number> {
    const discovery = new ModelDiscoveryService(
      this.config.huggingfaceToken,
      [],
      this.config.logLevel,
    );
    const hfConfig = await discovery.fetchModelConfig(modelId);
    if (!hfConfig) {
      this.logger.warn('Stage 1: HF config.json fetch failed — using card contextWindow', {
        modelId,
        cardContextWindow: modelInfo.contextWindow,
      });
      return modelInfo.contextWindow;
    }
    const enriched = enrichModelInfoFromHfConfig(
      { ...modelInfo, parameterCount: normalizeParameterCount(modelInfo.parameterCount) },
      hfConfig,
    );
    this.logger.info('Stage 1: context window resolved', {
      modelId,
      cardContextWindow: modelInfo.contextWindow,
      configContextWindow: enriched.contextWindow,
    });
    return enriched.contextWindow;
  }

  /**
   * Runs the single-tool calling benchmark against the freshly-deployed model.
   *
   * The VM's vLLM port (8000) is firewalled externally, so the benchmark
   * reaches it through a short-lived SSH tunnel. Never throws: any tunnel or
   * request failure is logged and returned as `null` (fail-open on infra
   * errors — the caller does not quarantine a good model for a flaky tunnel;
   * only a real below-floor success rate gates Stage 2 eligibility).
   */
  private async runToolCallBenchmark(modelId: string): Promise<ToolCallResult | null> {
    let tunnel: ReturnType<typeof startSSHTunnel> | null = null;
    try {
      tunnel = startSSHTunnel(this.config.ssh, this.logger);
      const ready = await waitForTunnel();
      if (!ready) {
        this.logger.warn('Stage 1: tool-call SSH tunnel not ready within 15s', { modelId });
        return null;
      }
      const benchmark = new ToolCallBenchmarkService({
        baseUrl: TUNNEL_BASE_URL,
        model: modelId,
        maxLatencyMs: this.config.benchmarkThresholds.maxToolCallLatencyMs,
        logLevel: this.config.logLevel as 'error' | 'warn' | 'info' | 'debug',
      });
      const report = await benchmark.runBenchmark();
      this.logger.info('Stage 1: tool-call benchmark completed', {
        modelId,
        successRate: report.toolCallResult.successRate,
        totalTests: report.toolCallResult.totalTests,
      });
      return report.toolCallResult;
    } catch (err) {
      this.logger.warn('Stage 1: tool-call benchmark failed (fail-open)', {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      if (tunnel && !tunnel.killed) tunnel.kill();
    }
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
        // HFCardParser reports billions (e.g. 34.67 for a 34.67B model); ModelInfo's
        // contract is a RAW parameter count. Without normalizing here, the tiered ITL
        // resolver downstream (paramBillions = parameterCount / 1e9) collapses to ~0
        // and every model is gated at the smallest tier (20ms) — silently rejecting
        // any 14B+ model that a larger tier would have passed.
        parameterCount: normalizeParameterCount(parsedCard.card.parameterCount),
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
            // Guard: Stage 3 reasoning optimizes benchmark throughput/memory and may
            // suggest reducing --max-model-len (e.g. to 8192). But the same deployment
            // also serves the Stage 2 security eval suites, whose prompts exceed small
            // contexts (alert-triage sends >8192 tokens). A capped context makes every
            // Stage 2 build fail with a 400 "maximum context length is N tokens". Never
            // let a reasoning suggestion drop max-model-len below the Stage 2 context
            // floor — fall back to `auto` (the model's advertised max) instead.
            const contextFloor = this.config.stage2Thresholds.minContextWindow;
            const suggestedMaxLen = deploymentOverrides.maxModelLen;
            if (
              suggestedMaxLen !== null &&
              suggestedMaxLen !== undefined &&
              suggestedMaxLen < contextFloor
            ) {
              this.logger.warn(
                'Stage 1: ignoring reasoning max-model-len override below Stage 2 context floor',
                { modelId: run.modelId, suggested: suggestedMaxLen, floor: contextFloor },
              );
              deploymentOverrides.maxModelLen = undefined;
            }
            this.logger.info('Stage 1: applying reasoning overrides', {
              modelId: run.modelId,
              overrides: Object.keys(deploymentOverrides).filter(
                (k) =>
                  deploymentOverrides![k as keyof VllmDeploymentOptions] !== undefined,
              ),
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

      // g2. Tool-call benchmark (single-tool calling competence). Only meaningful
      // for models that advertise tool calling — the Agent Builder baseline
      // requires it at discovery, so by Stage 1 this is virtually always true.
      let toolCallResults: ToolCallResult | null = null;
      if (this.vllmEngine.supportsToolCalling(modelInfo)) {
        this.logger.info('Stage 1: running tool-call benchmark', { modelId: run.modelId });
        toolCallResults = await this.toolCallBenchmarkRunner(run.modelId);
      } else {
        this.logger.info('Stage 1: skipping tool-call benchmark (model does not advertise tool calling)', {
          modelId: run.modelId,
        });
      }

      // h. Store results
      this.logger.info('Stage 1: storing results', { modelId: run.modelId });
      const benchmarkRecord: BenchmarkResult = {
        modelId: run.modelId,
        modelName: modelInfo.name,
        architecture: modelInfo.architecture,
        parameterCount: modelInfo.parameterCount,
        contextWindow: modelInfo.contextWindow,
        supportsToolCalling: modelInfo.supportsToolCalling,
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
        toolCallResults,
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
      const contextWindow = await this.resolveContextWindow(run.modelId, modelInfo);

      const stage2Thresholds = this.config.stage2Thresholds;
      const maxItlP50Ms = resolveMaxItlP50Ms(stage2Thresholds, paramBillions);

      // Tool-call gate: Stage 2 is agentic (Kibana security suites), so a model
      // that advertises tool calling but can't reliably emit valid single-tool
      // calls must not proceed. A below-floor success rate hard-gates. A null
      // result (benchmark skipped or failed-open on infra error) does NOT gate —
      // the perf gates still apply and a flaky tunnel shouldn't quarantine a good
      // model. Floor is param-count-aware (smaller models get a lower floor that
      // Agent Builder's malformed-tool-call filter + retry tolerate).
      const minToolCallSuccessRate = resolveMinToolCallSuccessRate(
        this.config.benchmarkThresholds,
        paramBillions,
      );
      // Gate on the SINGLE-TOOL success rate — Agent Builder issues single-tool
      // calls only, so a model that can't do parallel calls (4 of 5 benchmark
      // scenarios) must not be penalized. Fall back to the all-scenarios rate for
      // results produced before singleToolSuccessRate existed.
      const gateSuccessRate =
        toolCallResults === null
          ? null
          : (toolCallResults.singleToolSuccessRate ?? toolCallResults.successRate);
      const toolCallGatePassed =
        gateSuccessRate === null || gateSuccessRate >= minToolCallSuccessRate;

      const stage2Eligible =
        avgItlP50 < maxItlP50Ms &&
        throughput > stage2Thresholds.minThroughputTps &&
        avgTtft < stage2Thresholds.maxTtftMs &&
        contextWindow >= stage2Thresholds.minContextWindow &&
        toolCallGatePassed;

      this.logger.info('Stage 1: Stage 2 eligibility', {
        modelId: run.modelId,
        stage2Eligible,
        avgItlP50,
        maxItlP50Ms,
        throughput,
        avgTtft,
        contextWindow,
        toolCallSuccessRate: toolCallResults?.successRate ?? null,
        singleToolSuccessRate: toolCallResults?.singleToolSuccessRate ?? null,
        gateSuccessRate,
        minToolCallSuccessRate,
        toolCallGatePassed,
      });

      result.stage2Eligible = stage2Eligible;
      result.parameterCountBillions = paramBillions;
      result.toolCallSuccessRate = toolCallResults?.successRate ?? null;
      result.singleToolSuccessRate =
        toolCallResults?.singleToolSuccessRate ?? toolCallResults?.successRate ?? null;

      // Populate result fields
      result.status = benchmarkResult.passed ? 'success' : 'failed';
      // A benchmark that ran to completion but did not pass is still a failure
      // the queue entry must explain — otherwise `error_message` lands `null`
      // and operators cannot tell why the model was rejected. Surface the
      // rejection reasons (ITL over gate, container crash, no successful runs).
      if (!benchmarkResult.passed) {
        result.error =
          benchmarkResult.rejectionReasons.length > 0
            ? benchmarkResult.rejectionReasons.join('; ')
            : 'Stage 1 benchmark did not pass (no rejection reason reported)';
      }
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

      // Carry deployment info so the scheduler can keep the model alive
      // for Stage 2 CI evals and tear down in its own finally block.
      result.endpointUrl = deployment.apiEndpoint;
      result.deploymentName = deployment.deploymentName;
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
      // Teardown is now owned by the Scheduler (via its own finally block).
      // Stage 1 only logs if deployment is still live so the caller knows
      // it must clean up.
      if (deployment) {
        this.logger.info('Stage 1: deployment still active — scheduler owns teardown', {
          deploymentName: deployment.deploymentName,
        });
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
