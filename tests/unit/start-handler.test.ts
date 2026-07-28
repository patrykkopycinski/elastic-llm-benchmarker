import { describe, it, expect } from 'vitest';
import {
  resolveDiscoveryHardwareProfile,
  shouldEnableCIEvals,
} from '../../src/cli/start-handler.js';
import { HardwareProfileRegistry } from '../../src/services/hardware-profiles.js';

describe('resolveDiscoveryHardwareProfile', () => {
  // Regression: ModelDiscoveryService's Step 5 hardware-fit gate (which is
  // *authoritative* — a rejection there excludes the candidate from
  // discover()'s result.models entirely, so DiscoveryScheduler.scoreModels()
  // never even sees it) and scoreModels()'s own hardware-fit re-check were
  // previously fed from two independently-configured sources
  // (config.vmHardwareProfile vs discoveryScheduler.hardwareProfileId
  // resolved through the registry). They only agreed on i9 because both
  // config values happened to be manually kept in sync — nothing enforced
  // it, so a config drift could wrongly reject a model against the wrong
  // hardware profile before scoreModels ever got a chance to score it
  // correctly.
  const registry = new HardwareProfileRegistry();

  it('resolves a known built-in profile id to its definition', () => {
    const profile = resolveDiscoveryHardwareProfile('2xa100-80gb', registry);
    expect(profile).toBeDefined();
    expect(profile?.id).toBe('2xa100-80gb');
    expect(profile?.hardware.gpuCount).toBe(2);
    expect(profile?.hardware.gpuType).toBe('nvidia-a100-80gb');
  });

  it('returns undefined for an unknown profile id rather than throwing', () => {
    const profile = resolveDiscoveryHardwareProfile('nonexistent-profile', registry);
    expect(profile).toBeUndefined();
  });

  it('resolves each built-in profile id consistently with registry.getProfile', () => {
    for (const id of registry.getProfileIds()) {
      expect(resolveDiscoveryHardwareProfile(id, registry)).toEqual(registry.getProfile(id));
    }
  });

  it('reflects a custom profile registered at runtime', () => {
    const customRegistry = new HardwareProfileRegistry();
    customRegistry.registerProfile({
      id: 'custom-a60',
      displayName: '1x NVIDIA A60',
      description: 'Custom test profile',
      hardware: {
        gpuType: 'nvidia-a60',
        gpuCount: 1,
        ramGb: 64,
        cpuCores: 8,
        diskGb: 200,
        machineType: 'custom-machine',
      },
    });

    const profile = resolveDiscoveryHardwareProfile('custom-a60', customRegistry);
    expect(profile?.hardware.gpuType).toBe('nvidia-a60');
  });
});

describe('shouldEnableCIEvals', () => {
  // Regression (2026-07-28): the pre-fix expression
  // `(enableCIEvals || buildkiteEnabled) && Boolean(apiToken)` let the
  // `--ci-evals` CLI flag alone bypass the `config.buildkite.enabled: false`
  // kill-switch whenever an API token happened to be resolvable (env var, or
  // ~/.buildkite/token read by start-local.sh for unrelated tooling). That
  // fired real on-demand Buildkite builds (#316-326, ~$8/build) against
  // buildkite.enabled: false and mislabeled two models that had already
  // passed the local Stage 2 batch eval as `failed`.
  it('is false when buildkite.enabled is false, even with --ci-evals and a token present', () => {
    expect(shouldEnableCIEvals(true, false, 'real-token')).toBe(false);
  });

  it('is false when --ci-evals is not passed, even with buildkite.enabled true and a token', () => {
    expect(shouldEnableCIEvals(false, true, 'real-token')).toBe(false);
  });

  it('is false when no token is resolvable, even with both flags true', () => {
    expect(shouldEnableCIEvals(true, true, undefined)).toBe(false);
    expect(shouldEnableCIEvals(true, true, '')).toBe(false);
  });

  it('is true only when --ci-evals, buildkite.enabled, and a token are all present', () => {
    expect(shouldEnableCIEvals(true, true, 'real-token')).toBe(true);
  });
});
