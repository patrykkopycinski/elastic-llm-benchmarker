import { describe, it, expect } from 'vitest';
import {
  resolveEvalTier,
  resolveEvalTierFromConfig,
  shouldUseLocalStage2,
  shouldUseBuildkiteCIEvals,
} from '../../src/services/eval-tier-selector.js';
import type { AppConfig } from '../../src/types/config.js';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    elasticsearch: { url: 'http://localhost:9200' },
    ssh: { host: 'localhost' },
    huggingfaceToken: '',
    benchmarkThresholds: {
      minContextWindow: 128000,
      maxITLMs: 20,
      maxToolCallLatencyMs: 1000,
      minToolCallSuccessRate: 1.0,
      concurrencyLevels: [1, 4, 16],
      healthCheckTimeoutSeconds: 1800,
    },
    vmHardwareProfile: {
      gpuType: 'nvidia-a100-80gb',
      gpuCount: 2,
      ramGb: 340,
      cpuCores: 24,
      diskGb: 1000,
    },
    logLevel: 'info',
    resultsDir: './results',
    daemon: { enabled: true, sleepIntervalMs: 60000 },
    stage2Thresholds: {},
    enableStage2: false,
    stage2Local: {},
    gcp: {},
    goldenCluster: {},
    buildkite: {
      enabled: false,
      orgSlug: 'elastic',
      onDemandPipelineSlug: 'p',
      weeklyPipelineSlug: 'w',
      pollIntervalMs: 30000,
      pollTimeoutMs: 10800000,
      retryOnFailure: true,
      defaultEvalSuites: [],
      kibanaBranch: 'main',
      triggerFullEval: false,
      detachPoll: true,
    },
    kibanaRepo: {
      url: 'https://github.com/elastic/kibana.git',
      branch: 'main',
      autoPull: true,
    },
    kibanaConnector: { enabled: false },
    smokeTest: {
      healthTimeoutMs: 10000,
      inferenceTimeoutMs: 30000,
      toolCallingTimeoutMs: 60000,
      maxRetries: 2,
      depth: 'full',
    },
    engine: {
      type: 'vllm',
      vllmGpuMemoryUtilization: 0.9,
      maxModelLen: 65536,
      apiPort: 8000,
      dockerImage: 'vllm/vllm-openai:latest',
    },
    tunnel: { enabled: false, provider: 'ngrok' },
    agentBuilderBaseline: { enabled: true },
    discoveryScheduler: { enabled: false, intervalMinutes: 60 },
    edotCollector: { enabled: false },
    elasticAgent: { enabled: false },
    llmApiKey: '',
    llmBaseUrl: '',
    llmModel: '',
    llmMaxTokens: 4096,
    llmTemperature: 0,
    eisApiKey: '',
    eisModel: '',
    notifications: { enabled: false, minLevel: 'info' },
    ...overrides,
  } as unknown as AppConfig;
}

describe('resolveEvalTier', () => {
  it('returns "local" when evalTier=local and CI evals disabled', () => {
    expect(resolveEvalTier({ evalTier: 'local', ciEvalsEnabled: false, localStage2Enabled: true }))
      .toBe('local');
  });

  it('returns "localThenWeekly" when evalTier=local but CI evals also enabled', () => {
    expect(resolveEvalTier({ evalTier: 'local', ciEvalsEnabled: true, localStage2Enabled: true }))
      .toBe('localThenWeekly');
  });

  it('returns "buildkiteWeekly" when evalTier=buildkite-weekly and CI enabled', () => {
    expect(
      resolveEvalTier({
        evalTier: 'buildkite-weekly',
        ciEvalsEnabled: true,
        localStage2Enabled: false,
      }),
    ).toBe('buildkiteWeekly');
  });

  it('returns "none" when evalTier=buildkite-weekly but CI evals NOT enabled', () => {
    expect(
      resolveEvalTier({
        evalTier: 'buildkite-weekly',
        ciEvalsEnabled: false,
        localStage2Enabled: false,
      }),
    ).toBe('none');
  });

  it('falls back to legacy: Buildkite when no evalTier but CI enabled', () => {
    expect(resolveEvalTier({ evalTier: undefined, ciEvalsEnabled: true, localStage2Enabled: false }))
      .toBe('buildkiteWeekly');
  });

  it('falls back to legacy: local when no evalTier, CI disabled, Stage 2 enabled', () => {
    expect(resolveEvalTier({ evalTier: undefined, ciEvalsEnabled: false, localStage2Enabled: true }))
      .toBe('local');
  });

  it('falls back to "none" when nothing is enabled', () => {
    expect(resolveEvalTier({ evalTier: undefined, ciEvalsEnabled: false, localStage2Enabled: false }))
      .toBe('none');
  });
});

describe('shouldUseLocalStage2 / shouldUseBuildkiteCIEvals', () => {
  it('local tier → local stage2 ON, buildkite OFF', () => {
    expect(shouldUseLocalStage2('local')).toBe(true);
    expect(shouldUseBuildkiteCIEvals('local')).toBe(false);
  });

  it('buildkiteWeekly tier → local stage2 OFF, buildkite ON', () => {
    expect(shouldUseLocalStage2('buildkiteWeekly')).toBe(false);
    expect(shouldUseBuildkiteCIEvals('buildkiteWeekly')).toBe(true);
  });

  it('localThenWeekly tier → both ON', () => {
    expect(shouldUseLocalStage2('localThenWeekly')).toBe(true);
    expect(shouldUseBuildkiteCIEvals('localThenWeekly')).toBe(true);
  });

  it('none tier → both OFF', () => {
    expect(shouldUseLocalStage2('none')).toBe(false);
    expect(shouldUseBuildkiteCIEvals('none')).toBe(false);
  });
});

describe('resolveEvalTierFromConfig', () => {
  it('reads evalTier from config and resolves correctly', () => {
    const config = baseConfig({ evalTier: 'local', enableStage2: true });
    expect(resolveEvalTierFromConfig(config, false)).toBe('local');
  });

  it('upgrades to localThenWeekly when CI evals also enabled', () => {
    const config = baseConfig({ evalTier: 'local', enableStage2: true });
    expect(resolveEvalTierFromConfig(config, true)).toBe('localThenWeekly');
  });

  it('resolves buildkite-weekly from config', () => {
    const config = baseConfig({ evalTier: 'buildkite-weekly' });
    expect(resolveEvalTierFromConfig(config, true)).toBe('buildkiteWeekly');
  });
});
