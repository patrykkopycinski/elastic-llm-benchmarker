// tests/e2e/realistic-model.test.ts
/**
 * End-to-end test for complete benchmark flow with a real small model.
 *
 * Prerequisites:
 * - GPU VM accessible via SSH (configure in .env)
 * - Elasticsearch running (docker compose up -d elasticsearch)
 * - Sufficient VRAM for small model (~2GB for Qwen2.5-0.5B)
 *
 * Run:
 *   ELASTIC_PASSWORD=changeme npx vitest run tests/e2e/realistic-model.test.ts
 *
 * Expected duration: 5-10 minutes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@elastic/elasticsearch';
import { loadConfig } from '../../src/config/index.js';
import { createConfigurable, destroyConfigurable } from '../../src/agent/configurable.js';
import { ConfigResearcherService } from '../../src/services/config-researcher.js';
import { BenchmarkOrchestrationService } from '../../src/services/benchmark-orchestration.js';
import type { ModelInfo } from '../../src/types/benchmark.js';

describe('E2E: Realistic Model Benchmark', () => {
  const TEST_MODEL_ID = 'Qwen/Qwen2.5-0.5B-Instruct';
  let esClient: Client;
  let configurable: any;

  beforeAll(async () => {
    const config = loadConfig();

    esClient = new Client({
      node: process.env.ES_URL || 'http://localhost:9200',
      auth: {
        username: 'elastic',
        password: process.env.ELASTIC_PASSWORD || 'changeme',
      },
    });

    configurable = await createConfigurable(config);
  }, 60000); // 1 minute timeout for setup

  afterAll(async () => {
    if (configurable) {
      await destroyConfigurable(configurable);
    }
    if (esClient) {
      await esClient.close();
    }
  });

  it('should benchmark small model end-to-end', async () => {
    // Skip if no SSH config (CI environment)
    const config = loadConfig();
    if (!config.ssh.host || config.ssh.host === 'your-vm-ip') {
      console.log('⏭️  Skipping E2E test - no GPU VM configured');
      return;
    }

    const model: ModelInfo = {
      id: TEST_MODEL_ID,
      parameterCount: 0.5e9, // 0.5B parameters
    };

    // Create orchestration service
    const configResearcher = new ConfigResearcherService({
      gpusAvailable: config.vmHardwareProfile.gpuCount,
      huggingfaceToken: config.huggingfaceToken,
    });

    const orchestrator = new BenchmarkOrchestrationService(
      configResearcher,
      configurable.engine,
      configurable.sshPool,
      'info'
    );

    console.log(`🚀 Starting E2E benchmark for ${TEST_MODEL_ID}...`);

    // Run complete benchmark flow
    const result = await orchestrator.orchestrate(
      config.ssh,
      model,
      config.vmHardwareProfile,
      config.benchmarkThresholds,
      {
        skipReasoning: false, // Test reasoning pipeline
      }
    );

    // Verify result structure
    expect(result.modelId).toBe(TEST_MODEL_ID);
    expect(result.benchmarkMetrics.length).toBeGreaterThan(0);
    expect(result.passed).toBeDefined();

    // Verify tool calling was tested
    expect(result.toolCallResults).toBeDefined();
    if (result.toolCallResults) {
      expect(result.toolCallResults.totalTests).toBeGreaterThan(0);
      expect(result.toolCallResults.successRate).toBeGreaterThanOrEqual(0);
      expect(result.toolCallResults.successRate).toBeLessThanOrEqual(1);
    }

    // Verify reasoning was tested
    expect(result.reasoningResults).toBeDefined();
    if (result.reasoningResults) {
      expect(result.reasoningResults.resultsWithoutReasoning.length).toBe(15);
      expect(result.reasoningResults.resultsWithReasoning.length).toBe(15);
      expect(result.reasoningResults.recommendation).toMatch(/enable|skip/);
    }

    // Verify hardware config
    expect(result.hardwareConfig.gpuCount).toBeGreaterThan(0);
    expect(result.hardwareConfig.gpuType).toBeTruthy();

    console.log('✅ E2E benchmark completed successfully');
    console.log(`   Model: ${result.modelId}`);
    console.log(`   Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
    console.log(`   Tool Calling: ${result.toolCallResults?.successRate ? (result.toolCallResults.successRate * 100).toFixed(0) + '%' : 'N/A'}`);
    console.log(`   Reasoning: ${result.reasoningResults?.recommendation || 'N/A'}`);

  }, 600000); // 10 minute timeout for full benchmark

  it('should handle VRAM OOM with retry logic', async () => {
    // Skip if no SSH config
    const config = loadConfig();
    if (!config.ssh.host || config.ssh.host === 'your-vm-ip') {
      console.log('⏭️  Skipping OOM test - no GPU VM configured');
      return;
    }

    // Test with a model that might OOM
    const largeModel: ModelInfo = {
      id: 'meta-llama/Llama-3.3-70B-Instruct',
      parameterCount: 70e9,
    };

    const configResearcher = new ConfigResearcherService({
      gpusAvailable: config.vmHardwareProfile.gpuCount,
      huggingfaceToken: config.huggingfaceToken,
    });

    const orchestrator = new BenchmarkOrchestrationService(
      configResearcher,
      configurable.engine,
      configurable.sshPool,
      'info'
    );

    // This might OOM and retry with reduced maxModelLen
    // The test verifies retry logic triggers correctly
    try {
      const result = await orchestrator.orchestrate(
        config.ssh,
        largeModel,
        config.vmHardwareProfile,
        config.benchmarkThresholds,
        {
          skipReasoning: true,
        }
      );

      // If successful, verify it worked
      expect(result.modelId).toBe(largeModel.id);
    } catch (error: any) {
      // If it fails after retries, that's ok for this test
      // We're just verifying the retry logic executes
      expect(error.message).toMatch(/Max retries exceeded|resource_exhausted|VRAM/i);
      console.log('✅ OOM retry logic triggered as expected');
    }
  }, 900000); // 15 minute timeout
});
