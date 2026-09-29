import { describe, it, expect } from 'vitest';
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
