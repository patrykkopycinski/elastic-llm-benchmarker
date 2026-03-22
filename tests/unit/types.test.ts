import { describe, it, expect } from 'vitest';
import { initialAgentState } from '../../src/types/agent.js';
import {
  appConfigSchema,
  benchmarkThresholdsSchema,
  vmHardwareProfileSchema,
} from '../../src/types/config.js';

describe('Agent types', () => {
  it('should have correct initial agent state', () => {
    expect(initialAgentState.currentState).toBe('idle');
    expect(initialAgentState.discoveredModels).toEqual([]);
    expect(initialAgentState.currentModel).toBeNull();
    expect(initialAgentState.results).toEqual([]);
    expect(initialAgentState.evaluatedModelIds).toEqual([]);
    expect(initialAgentState.error).toBeNull();
    expect(initialAgentState.errorCount).toBe(0);
    expect(initialAgentState.lastSuccessTimestamp).toBeNull();
  });
});

describe('Config schemas', () => {
  it('should validate benchmark thresholds with defaults', () => {
    const result = benchmarkThresholdsSchema.parse({});
    expect(result.minContextWindow).toBe(128_000);
    expect(result.maxITLMs).toBe(20);
    expect(result.maxToolCallLatencyMs).toBe(1000);
    expect(result.concurrencyLevels).toEqual([1, 4, 16]);
  });

  it('should validate VM hardware profile with defaults', () => {
    const result = vmHardwareProfileSchema.parse({});
    expect(result.gpuType).toBe('nvidia-l4');
    expect(result.gpuCount).toBe(1);
    expect(result.ramGb).toBe(64);
    expect(result.cpuCores).toBe(8);
    expect(result.diskGb).toBe(200);
    expect(result.machineType).toBe('g2-standard-8');
  });

  it('should validate VM hardware profile with custom values', () => {
    const result = vmHardwareProfileSchema.parse({
      gpuType: 'nvidia-a100',
      gpuCount: 8,
      ramGb: 256,
      cpuCores: 96,
      diskGb: 1000,
      machineType: 'a2-megagpu-16g',
    });
    expect(result.gpuType).toBe('nvidia-a100');
    expect(result.gpuCount).toBe(8);
    expect(result.ramGb).toBe(256);
    expect(result.cpuCores).toBe(96);
    expect(result.diskGb).toBe(1000);
    expect(result.machineType).toBe('a2-megagpu-16g');
  });

  it('should validate a full app config', () => {
    const config = appConfigSchema.parse({
      ssh: {
        host: '10.0.0.1',
        username: 'user',
        port: 22,
        password: 'pass',
      },
      huggingfaceToken: 'hf_token',
    });

    expect(config.ssh.host).toBe('10.0.0.1');
    expect(config.logLevel).toBe('info');
    expect(config.resultsDir).toBe('./results');
    expect(config.vmHardwareProfile.gpuType).toBe('nvidia-l4');
  });

  it('should accept SSH with privateKeyPath instead of password', () => {
    const config = appConfigSchema.parse({
      ssh: {
        host: '10.0.0.1',
        username: 'user',
        privateKeyPath: '/home/user/.ssh/id_rsa',
      },
      huggingfaceToken: 'hf_token',
    });

    expect(config.ssh.privateKeyPath).toBe('/home/user/.ssh/id_rsa');
    expect(config.ssh.password).toBeUndefined();
  });

  it('should reject config without SSH auth credentials', () => {
    expect(() =>
      appConfigSchema.parse({
        ssh: { host: '10.0.0.1', username: 'user' },
        huggingfaceToken: 'hf_token',
      }),
    ).toThrow();
  });

  it('should reject invalid config', () => {
    expect(() =>
      appConfigSchema.parse({
        ssh: { host: '', username: '' },
        huggingfaceToken: '',
      }),
    ).toThrow();
  });

  it('should reject VM hardware profile with invalid values', () => {
    expect(() =>
      vmHardwareProfileSchema.parse({
        gpuCount: -1,
      }),
    ).toThrow();
  });
});
