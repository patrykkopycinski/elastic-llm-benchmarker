import type { VMHardwareProfile } from '../types/config.js';

/**
 * A hardware profile with metadata for identification and display.
 */
export interface HardwareProfileDefinition {
  /** Unique profile identifier (e.g., "2xa100-80gb") */
  id: string;
  /** Human-readable display name (e.g., "2x NVIDIA A100 80GB") */
  displayName: string;
  /** Optional description of the profile's intended use */
  description: string;
  /** The VM hardware configuration for this profile */
  hardware: VMHardwareProfile;
}

/**
 * Built-in hardware profile definitions.
 *
 * These represent the standard VM configurations available for benchmarking.
 * The registry can be extended at runtime via `registerProfile()`.
 */
const BUILTIN_PROFILES: readonly HardwareProfileDefinition[] = [
  {
    id: '2xa100-80gb',
    displayName: '2x NVIDIA A100 80GB',
    description: 'Dual A100 80GB GPUs on a2-ultragpu-2g instance. High-end configuration for large model benchmarks.',
    hardware: {
      gpuType: 'nvidia-a100-80gb',
      gpuCount: 2,
      ramGb: 680,
      cpuCores: 24,
      diskGb: 1000,
      machineType: 'a2-ultragpu-2g',
    },
  },
  {
    id: '1xa100-80gb',
    displayName: '1x NVIDIA A100 80GB',
    description: 'Single A100 80GB GPU on a2-highgpu-1g instance. Standard configuration for medium model benchmarks.',
    hardware: {
      gpuType: 'nvidia-a100-80gb',
      gpuCount: 1,
      ramGb: 340,
      cpuCores: 12,
      diskGb: 500,
      machineType: 'a2-highgpu-1g',
    },
  },
  {
    id: '4xa100-80gb',
    displayName: '4x NVIDIA A100 80GB',
    description: 'Quad A100 80GB GPUs on a2-ultragpu-4g instance. Premium configuration for very large model benchmarks.',
    hardware: {
      gpuType: 'nvidia-a100-80gb',
      gpuCount: 4,
      ramGb: 1360,
      cpuCores: 48,
      diskGb: 2000,
      machineType: 'a2-ultragpu-4g',
    },
  },
  {
    id: '1xl4',
    displayName: '1x NVIDIA L4',
    description: 'Single L4 GPU on g2-standard-8 instance. Cost-effective configuration for smaller model benchmarks.',
    hardware: {
      gpuType: 'nvidia-l4',
      gpuCount: 1,
      ramGb: 64,
      cpuCores: 8,
      diskGb: 200,
      machineType: 'g2-standard-8',
    },
  },
  {
    id: '8xl4',
    displayName: '8x NVIDIA L4',
    description: 'Eight L4 GPUs on g2-standard-96 instance. High GPU count configuration for large model benchmarks with L4 GPUs.',
    hardware: {
      gpuType: 'nvidia-l4',
      gpuCount: 8,
      ramGb: 384,
      cpuCores: 96,
      diskGb: 1000,
      machineType: 'g2-standard-96',
    },
  },
] as const;

/**
 * Registry for managing VM hardware profiles.
 *
 * Provides access to built-in profiles and allows registering custom
 * profiles at runtime. Profiles are identified by unique string IDs
 * and contain full VM hardware specifications.
 *
 * @example
 * ```typescript
 * const registry = new HardwareProfileRegistry();
 *
 * // Get a built-in profile
 * const profile = registry.getProfile('2xa100-80gb');
 *
 * // Register a custom profile
 * registry.registerProfile({
 *   id: 'custom-a60',
 *   displayName: '1x NVIDIA A60',
 *   description: 'Custom A60 configuration',
 *   hardware: { gpuType: 'nvidia-a60', gpuCount: 1, ... }
 * });
 *
 * // List all available profiles
 * const allProfiles = registry.listProfiles();
 * ```
 */
export class HardwareProfileRegistry {
  private readonly profiles: Map<string, HardwareProfileDefinition> = new Map();

  constructor() {
    // Register all built-in profiles
    for (const profile of BUILTIN_PROFILES) {
      this.profiles.set(profile.id, profile);
    }
  }

  /**
   * Retrieves a hardware profile by its ID.
   *
   * @param id - The unique profile identifier
   * @returns The profile definition, or undefined if not found
   */
  getProfile(id: string): HardwareProfileDefinition | undefined {
    return this.profiles.get(id);
  }

  /**
   * Returns all registered hardware profiles.
   *
   * @returns Array of all profile definitions, sorted by ID
   */
  listProfiles(): HardwareProfileDefinition[] {
    return Array.from(this.profiles.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Registers a new hardware profile or replaces an existing one.
   *
   * @param profile - The profile definition to register
   * @throws {Error} If the profile ID is empty
   */
  registerProfile(profile: HardwareProfileDefinition): void {
    if (!profile.id || profile.id.trim().length === 0) {
      throw new Error('Hardware profile ID cannot be empty');
    }
    this.profiles.set(profile.id, profile);
  }

  /**
   * Checks whether a profile with the given ID exists.
   *
   * @param id - The profile ID to check
   * @returns true if the profile is registered
   */
  hasProfile(id: string): boolean {
    return this.profiles.has(id);
  }

  /**
   * Returns the number of registered profiles.
   */
  get size(): number {
    return this.profiles.size;
  }

  /**
   * Returns all registered profile IDs.
   */
  getProfileIds(): string[] {
    return Array.from(this.profiles.keys()).sort();
  }
}

/**
 * Default singleton registry instance with all built-in profiles.
 */
export const defaultHardwareProfileRegistry = new HardwareProfileRegistry();
