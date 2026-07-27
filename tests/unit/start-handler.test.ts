import { describe, it, expect } from 'vitest';
import { resolveDiscoveryHardwareProfile } from '../../src/cli/start-handler.js';
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
