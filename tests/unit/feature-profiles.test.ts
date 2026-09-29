import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveFeatureProfiles,
  AGENT_BUILDER_PROFILE_ID,
  type FeatureProfileConfig,
} from '../../src/types/config.js';
import {
  createAgentBuilderFilter,
  createProfileFilter,
} from '../../src/services/agent-builder-baseline.js';
import type { AppConfig } from '../../src/types/config.js';
import { loadConfig } from '../../src/config/index.js';

const baselineConfig: FeatureProfileConfig = {
  enabled: true,
  minContextWindow: 128_000,
  minParameterCountBillions: 24,
  minActiveParametersBillions: 8,
  requireToolCalling: true,
  requireInstructVariant: true,
};

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    agentBuilderBaseline: baselineConfig,
    ...overrides,
  } as unknown as AppConfig;
}

describe('resolveFeatureProfiles', () => {
  it('derives the agent-builder profile from agentBuilderBaseline when featureProfiles is absent', () => {
    const config = makeConfig();
    const profiles = resolveFeatureProfiles(config);
    expect(profiles[AGENT_BUILDER_PROFILE_ID]).toEqual(baselineConfig);
  });

  it('lets an explicit featureProfiles["agent-builder"] override agentBuilderBaseline', () => {
    const override: FeatureProfileConfig = { ...baselineConfig, minParameterCountBillions: 8 };
    const config = makeConfig({ featureProfiles: { [AGENT_BUILDER_PROFILE_ID]: override } } as Partial<AppConfig>);
    const profiles = resolveFeatureProfiles(config);
    expect(profiles[AGENT_BUILDER_PROFILE_ID].minParameterCountBillions).toBe(8);
  });

  it('preserves additional named profiles alongside the derived/overridden agent-builder one', () => {
    const research: FeatureProfileConfig = { ...baselineConfig, minParameterCountBillions: 1 };
    const config = makeConfig({ featureProfiles: { research } } as Partial<AppConfig>);
    const profiles = resolveFeatureProfiles(config);
    expect(profiles.research).toEqual(research);
    expect(profiles[AGENT_BUILDER_PROFILE_ID]).toEqual(baselineConfig);
  });
});

describe('createAgentBuilderFilter / createProfileFilter equivalence', () => {
  it('createAgentBuilderFilter is equivalent to createProfileFilter(config, "agent-builder") for legacy config', () => {
    const config = makeConfig();
    const direct = createAgentBuilderFilter(config);
    const viaProfile = createProfileFilter(config, AGENT_BUILDER_PROFILE_ID);
    expect(viaProfile.success).toBe(true);
    // Both are freshly-constructed ModelCandidateFilter instances (each carries
    // its own logger), so compare public filtering behavior rather than deep
    // instance equality: same model in, same pass/reject verdict out.
    const sampleModel = {
      id: 'Qwen/Qwen2.5-72B-Instruct',
      name: 'Qwen2.5-72B-Instruct',
      architecture: 'qwen2',
      contextWindow: 131072,
      license: 'apache-2.0',
      parameterCount: 72_000_000_000,
      quantizations: ['fp16'],
      supportsToolCalling: true,
    };
    expect(viaProfile.filter?.evaluate(sampleModel)).toEqual(direct.evaluate(sampleModel));
  });

  it('createProfileFilter rejects an unknown profile id with the list of valid ids', () => {
    const config = makeConfig();
    const result = createProfileFilter(config, 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown profile 'nonexistent'/);
    expect(result.validProfileIds).toContain(AGENT_BUILDER_PROFILE_ID);
  });

  it('createProfileFilter resolves a named non-default profile independently of agent-builder', () => {
    const permissive: FeatureProfileConfig = { ...baselineConfig, minParameterCountBillions: 1 };
    const config = makeConfig({ featureProfiles: { research: permissive } } as Partial<AppConfig>);
    const result = createProfileFilter(config, 'research');
    expect(result.success).toBe(true);
    expect(result.validProfileIds).toEqual(expect.arrayContaining([AGENT_BUILDER_PROFILE_ID, 'research']));
  });
});

function requireFilter(config: AppConfig, profileId: string) {
  const { filter } = createProfileFilter(config, profileId);
  if (!filter) throw new Error("profile " + profileId + " produced no filter");
  return filter;
}

describe('agent-builder profile verdicts (hard-coded fixture table)', () => {
  const model = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id.split('/')[1],
    architecture: 'qwen2',
    contextWindow: 131_072,
    license: 'apache-2.0',
    parameterCount: 32_000_000_000,
    quantizations: ['fp16'],
    supportsToolCalling: true,
    ...overrides,
  });

  const cases: Array<{
    name: string;
    model: ReturnType<typeof model>;
    passed: boolean;
    rejections: string[];
    warnings: string[];
  }> = [
    { name: 'dense 32B instruct with tools', model: model('Qwen/Qwen2.5-32B-Instruct'), passed: true, rejections: [], warnings: [] },
    { name: 'context well below floor', model: model('Qwen/Qwen2.5-32B-Instruct-32k', { contextWindow: 32_768 }), passed: false, rejections: ['context_size'], warnings: [] },
    { name: 'context exactly at the 128k floor', model: model('Qwen/Qwen2.5-32B-Instruct-128k', { contextWindow: 128_000 }), passed: true, rejections: [], warnings: [] },
    { name: 'context one token below the floor', model: model('Qwen/Qwen2.5-32B-Instruct-127k', { contextWindow: 127_999 }), passed: false, rejections: ['context_size'], warnings: [] },
    { name: 'below the 24B parameter floor', model: model('Qwen/Qwen2.5-7B-Instruct', { parameterCount: 7_000_000_000 }), passed: false, rejections: ['parameter_count'], warnings: [] },
    { name: 'no tool calling', model: model('Qwen/Qwen2.5-32B-Instruct-notools', { supportsToolCalling: false }), passed: false, rejections: ['tool_calling'], warnings: [] },
    { name: 'base (non-instruct) variant', model: model('Qwen/Qwen2.5-32B'), passed: true, rejections: [], warnings: [] },
    { name: 'MoE with 3B active params', model: model('Qwen/Qwen3-30B-A3B-Instruct-2507', { architecture: 'qwen3_moe', parameterCount: 30_000_000_000 }), passed: true, rejections: [], warnings: ['active_parameter_count'] },
    { name: 'architecture vLLM does not support', model: model('acme/Foo-32B-Instruct', { architecture: 'totally_unknown_arch' }), passed: false, rejections: ['vllm_architecture', 'tool_calling'], warnings: [] },
  ];

  const filter = requireFilter(makeConfig(), AGENT_BUILDER_PROFILE_ID);

  it.each(cases)('$name', ({ model: m, passed, rejections, warnings }) => {
    const result = filter.evaluate(m as never);
    expect(result.passed).toBe(passed);
    expect(result.rejections.map((r) => r.criterion)).toEqual(rejections);
    expect(result.warnings.map((w) => w.criterion)).toEqual(warnings);
  });

  it('applies each profile\'s own thresholds to the same model', () => {
    const model200k = model('Qwen/Qwen2.5-32B-Instruct-200k-floor-probe', { contextWindow: 131_072 });
    const strict: FeatureProfileConfig = { ...baselineConfig, minContextWindow: 200_000 };
    const config = makeConfig({ featureProfiles: { 'attack-discovery': strict } } as Partial<AppConfig>);

    const abResult = requireFilter(config, AGENT_BUILDER_PROFILE_ID).evaluate(model200k as never);
    const adResult = requireFilter(config, 'attack-discovery').evaluate(model200k as never);

    expect(abResult.passed).toBe(true);
    expect(adResult.passed).toBe(false);
    expect(adResult.rejections.map((r) => r.criterion)).toEqual(['context_size']);
  });
});

describe('shipped attack-discovery profile (config/default.json)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SSH_HOST: '10.0.0.1',
      SSH_USERNAME: 'testuser',
      SSH_PASSWORD: 'testpass',
      HUGGINGFACE_TOKEN: 'hf_test_token',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exposes an attack-discovery profile with the AD-derived numeric floors', () => {
    const config = loadConfig(undefined, { skipDotenv: true });
    const profiles = resolveFeatureProfiles(config);
    // 131072: ~104k-token AD prompt at 95 alerts (qwen tokenizer) needs this as
    // a floor, not a comfortable margin — tekken is ~2x less dense (C2-5).
    expect(profiles['attack-discovery']).toMatchObject({
      enabled: true,
      minContextWindow: 131_072,
      minParameterCountBillions: 24,
      minActiveParametersBillions: 8,
      requireToolCalling: false,
      requireInstructVariant: true,
    });
  });

  it('does not change the agent-builder profile\'s own thresholds', () => {
    const config = loadConfig(undefined, { skipDotenv: true });
    const profiles = resolveFeatureProfiles(config);
    expect(profiles[AGENT_BUILDER_PROFILE_ID]).toEqual(config.agentBuilderBaseline);
    expect(profiles[AGENT_BUILDER_PROFILE_ID].minContextWindow).toBe(128_000);
    expect(profiles[AGENT_BUILDER_PROFILE_ID].requireToolCalling).toBe(true);
  });

  it('leaves agent-builder verdicts on a fixture set identical with the new profile present', () => {
    const config = loadConfig(undefined, { skipDotenv: true });
    const sampleModels = [
      { id: 'Qwen/Qwen2.5-32B-Instruct', name: 'Qwen2.5-32B-Instruct', architecture: 'qwen2', contextWindow: 131_072, license: 'apache-2.0', parameterCount: 32_000_000_000, quantizations: ['fp16'], supportsToolCalling: true },
      { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B-Instruct', architecture: 'qwen2', contextWindow: 32_768, license: 'apache-2.0', parameterCount: 7_000_000_000, quantizations: ['fp16'], supportsToolCalling: true },
      { id: 'acme/no-tools-32B-Instruct', name: 'no-tools-32B-Instruct', architecture: 'qwen2', contextWindow: 131_072, license: 'apache-2.0', parameterCount: 32_000_000_000, quantizations: ['fp16'], supportsToolCalling: false },
    ];
    const filter = requireFilter(config, AGENT_BUILDER_PROFILE_ID);
    const verdicts = sampleModels.map((m) => filter.evaluate(m as never).passed);
    expect(verdicts).toEqual([true, false, false]);
  });
});
