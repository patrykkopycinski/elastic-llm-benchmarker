// src/services/benchmark-orchestration.ts
import type { SSHConfig, VMHardwareProfile, BenchmarkThresholds } from '../types/config.js';
import type { ModelInfo, BenchmarkResult } from '../types/benchmark.js';
import type { InferenceEngine } from '../engines/engine-types.js';
import { BenchmarkRunnerService } from './benchmark-runner.js';
import { ToolCallBenchmarkService } from './tool-call-benchmark.js';
import { ReasoningBenchmarkService } from './reasoning-benchmark.js';
import { ConfigResearcherService } from './config-researcher.js';
import { SSHClientPool } from './ssh-client.js';
import { createLogger } from '../utils/logger.js';

export interface OrchestrationOptions {
  skipReasoning?: boolean;
  configOverrides?: {
    tensorParallelSize?: number;
    maxModelLen?: number;
  };
}

export class BenchmarkOrchestrationService {
  private logger;
  private sshPool: SSHClientPool;

  constructor(
    private configResearcher: ConfigResearcherService,
    private engine: InferenceEngine,
    sshPool: SSHClientPool,
    logLevel: string = 'info'
  ) {
    this.logger = createLogger(logLevel);
    this.sshPool = sshPool;
  }

  async orchestrate(
    sshConfig: SSHConfig,
    model: ModelInfo,
    hardwareProfile: VMHardwareProfile,
    thresholds: BenchmarkThresholds,
    options: OrchestrationOptions = {}
  ): Promise<BenchmarkResult> {
    let attemptNumber = 0;
    let config = await this.configResearcher.research(model.id);

    // Apply overrides
    if (options.configOverrides) {
      config = { ...config, ...options.configOverrides };
    }

    while (attemptNumber < 2) {
      try {
        // Deploy
        const deployment = await this.engine.deploy(sshConfig, model, hardwareProfile);

        // Run hardware benchmarks
        const benchmarkRunner = new BenchmarkRunnerService(this.sshPool, 'info');
        const paramCountB = model.parameterCount ? model.parameterCount / 1e9 : null;

        const engineResult = await benchmarkRunner.runBenchmarks(
          sshConfig,
          model.id,
          thresholds.concurrencyLevels,
          thresholds,
          deployment.deploymentName,
          paramCountB
        );

        // Run tool calling benchmark
        let toolCallResults = null;
        if (this.engine.supportsToolCalling(model)) {
          const toolCallBenchmark = new ToolCallBenchmarkService({
            baseUrl: deployment.apiEndpoint,
            model: model.id,
            logLevel: 'info',
          });
          const toolReport = await toolCallBenchmark.runBenchmark();
          toolCallResults = toolReport.toolCallResult;
        }

        // Run reasoning benchmark
        let reasoningResults = null;
        if (!options.skipReasoning && config.capabilities.reasoning.supported) {
          const reasoningBenchmark = new ReasoningBenchmarkService({
            baseUrl: deployment.apiEndpoint,
            model: model.id,
          });
          reasoningResults = await reasoningBenchmark.run();
        }

        // Stop deployment
        await this.engine.stop(sshConfig, deployment.deploymentName);

        // Build complete result
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
          reasoningResults,
          passed: engineResult.passed,
          rejectionReasons: engineResult.rejectionReasons,
          tensorParallelSize: deployment.parallelismConfig,
          toolCallParser: deployment.toolCallParser,
          rawOutput: engineResult.combinedRawOutput,
          gpuUtilization: deployment.gpuUtilization ?? null,
        };

      } catch (error: any) {
        if (error.category === 'resource_exhausted' && attemptNumber < 1) {
          config.maxModelLen = Math.floor(config.maxModelLen * 0.75);
          this.logger.warn('VRAM OOM - retrying', { newMaxLen: config.maxModelLen });
          attemptNumber++;
          continue;
        }
        throw error;
      }
    }

    throw new Error('Max retries exceeded');
  }
}
