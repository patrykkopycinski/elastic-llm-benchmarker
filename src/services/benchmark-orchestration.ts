// src/services/benchmark-orchestration.ts
// TODO: This service needs refactoring to match actual service APIs
// - BenchmarkRunnerService uses different constructor and method signatures
// - ToolCallBenchmarkService.runBenchmark() returns different type
// - Integration pending until service APIs are aligned

import type { SSHConfig, VMHardwareProfile, BenchmarkThresholds } from '../types/config.js';
import type { ModelInfo, BenchmarkResult } from '../types/benchmark.js';
import type { VllmEngine } from '../engines/vllm-engine.js';
import type { BenchmarkRunnerService } from './benchmark-runner.js';
import type { ToolCallBenchmarkService } from './tool-call-benchmark.js';
import type { ReasoningBenchmarkService } from './reasoning-benchmark.js';
import type { ConfigResearcherService } from './config-researcher.js';
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

  constructor(
    private configResearcher: ConfigResearcherService,
    private vllmEngine: VllmEngine,
    private benchmarkRunner: BenchmarkRunnerService,
    private toolCallBenchmark: ToolCallBenchmarkService,
    private reasoningBenchmark: ReasoningBenchmarkService,
    logLevel: string = 'info'
  ) {
    this.logger = createLogger(logLevel);
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
        const deployment = await this.vllmEngine.deploy(sshConfig, model, hardwareProfile);

        // Run benchmarks
        const hardwareMetrics = await this.benchmarkRunner.run(
          sshConfig,
          model.id,
          [1, 4, 16],
          thresholds,
          deployment.deploymentName
        );

        const toolCallResults = await this.toolCallBenchmark.run({
          baseUrl: deployment.apiEndpoint,
          model: model.id,
        });

        let reasoningResults = null;
        if (!options.skipReasoning && config.capabilities.reasoning.supported) {
          reasoningResults = await this.reasoningBenchmark.run();
        }

        // Stop deployment
        await this.vllmEngine.stop(sshConfig, deployment.deploymentName);

        return {
          ...hardwareMetrics,
          toolCallResults,
          reasoningResults,
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
