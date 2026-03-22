import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, loadConfigFile, formatValidationErrors } from '../../src/config/index.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load config with valid environment variables', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['SSH_PASSWORD'] = 'testpass';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';

    const config = loadConfig(undefined, { skipDotenv: true });

    expect(config.ssh.host).toBe('10.0.0.1');
    expect(config.ssh.username).toBe('testuser');
    expect(config.ssh.password).toBe('testpass');
    expect(config.ssh.port).toBe(22);
    expect(config.huggingfaceToken).toBe('hf_test_token');
  });

  it('should apply default benchmark thresholds', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['SSH_PASSWORD'] = 'testpass';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';

    const config = loadConfig(undefined, { skipDotenv: true });

    expect(config.benchmarkThresholds.minContextWindow).toBe(128_000);
    expect(config.benchmarkThresholds.maxITLMs).toBe(20);
    expect(config.benchmarkThresholds.maxToolCallLatencyMs).toBe(1000);
    expect(config.benchmarkThresholds.minToolCallSuccessRate).toBe(1.0);
    expect(config.benchmarkThresholds.concurrencyLevels).toEqual([1, 4, 16]);
  });

  it('should apply default VM hardware profile', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['SSH_PASSWORD'] = 'testpass';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';

    const config = loadConfig(undefined, { skipDotenv: true });

    expect(config.vmHardwareProfile.gpuType).toBe('nvidia-l4');
    expect(config.vmHardwareProfile.gpuCount).toBe(1);
    expect(config.vmHardwareProfile.ramGb).toBe(64);
    expect(config.vmHardwareProfile.cpuCores).toBe(8);
    expect(config.vmHardwareProfile.diskGb).toBe(200);
    expect(config.vmHardwareProfile.machineType).toBe('g2-standard-8');
  });

  it('should load VM hardware profile from env vars', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['SSH_PASSWORD'] = 'testpass';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';
    process.env['VM_GPU_TYPE'] = 'nvidia-a100';
    process.env['VM_GPU_COUNT'] = '4';
    process.env['VM_RAM_GB'] = '128';
    process.env['VM_CPU_CORES'] = '16';
    process.env['VM_DISK_GB'] = '500';
    process.env['VM_MACHINE_TYPE'] = 'a2-highgpu-4g';

    const config = loadConfig(undefined, { skipDotenv: true });

    expect(config.vmHardwareProfile.gpuType).toBe('nvidia-a100');
    expect(config.vmHardwareProfile.gpuCount).toBe(4);
    expect(config.vmHardwareProfile.ramGb).toBe(128);
    expect(config.vmHardwareProfile.cpuCores).toBe(16);
    expect(config.vmHardwareProfile.diskGb).toBe(500);
    expect(config.vmHardwareProfile.machineType).toBe('a2-highgpu-4g');
  });

  it('should allow overrides', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['SSH_PASSWORD'] = 'testpass';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';

    const config = loadConfig({ logLevel: 'debug' }, { skipDotenv: true });

    expect(config.logLevel).toBe('debug');
  });

  it('should throw on missing required fields with descriptive errors', () => {
    // Clear all SSH/token env vars to trigger validation failure
    delete process.env['SSH_HOST'];
    delete process.env['SSH_USERNAME'];
    delete process.env['SSH_PASSWORD'];
    delete process.env['SSH_PRIVATE_KEY_PATH'];
    delete process.env['HUGGINGFACE_TOKEN'];

    expect(() =>
      loadConfig(undefined, { skipDotenv: true, configPath: '/nonexistent/path.json' }),
    ).toThrow('Configuration validation failed');
  });

  it('should require either SSH password or privateKeyPath', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';
    // No password or key set
    delete process.env['SSH_PASSWORD'];
    delete process.env['SSH_PRIVATE_KEY_PATH'];

    expect(() =>
      loadConfig(undefined, { skipDotenv: true, configPath: '/nonexistent/path.json' }),
    ).toThrow('Configuration validation failed');
  });

  it('should accept SSH private key path without password', () => {
    process.env['SSH_HOST'] = '10.0.0.1';
    process.env['SSH_USERNAME'] = 'testuser';
    process.env['SSH_PRIVATE_KEY_PATH'] = '/home/user/.ssh/id_rsa';
    process.env['HUGGINGFACE_TOKEN'] = 'hf_test_token';
    delete process.env['SSH_PASSWORD'];

    const config = loadConfig(undefined, {
      skipDotenv: true,
      configPath: '/nonexistent/path.json',
    });

    expect(config.ssh.privateKeyPath).toBe('/home/user/.ssh/id_rsa');
    expect(config.ssh.password).toBeUndefined();
  });

  it('should merge env vars over config file values', () => {
    const tmpDir = join(process.cwd(), 'tmp-test-config');
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'test-config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        ssh: {
          host: 'file-host',
          username: 'file-user',
          password: 'file-pass',
        },
        huggingfaceToken: 'hf_file_token',
        logLevel: 'debug',
      }),
    );

    try {
      // Env vars should override file values
      process.env['SSH_HOST'] = 'env-host';
      process.env['HUGGINGFACE_TOKEN'] = 'hf_env_token';
      delete process.env['SSH_USERNAME'];
      delete process.env['SSH_PASSWORD'];
      delete process.env['SSH_PRIVATE_KEY_PATH'];

      const config = loadConfig(undefined, { skipDotenv: true, configPath });

      expect(config.ssh.host).toBe('env-host');
      expect(config.ssh.username).toBe('file-user');
      expect(config.ssh.password).toBe('file-pass');
      expect(config.huggingfaceToken).toBe('hf_env_token');
      expect(config.logLevel).toBe('debug');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should prioritize overrides over env vars and file', () => {
    const tmpDir = join(process.cwd(), 'tmp-test-config2');
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'test-config.json');

    writeFileSync(
      configPath,
      JSON.stringify({
        ssh: {
          host: 'file-host',
          username: 'file-user',
          password: 'file-pass',
        },
        huggingfaceToken: 'hf_file_token',
        logLevel: 'warn',
      }),
    );

    try {
      process.env['SSH_HOST'] = 'env-host';
      process.env['HUGGINGFACE_TOKEN'] = 'hf_env_token';
      delete process.env['SSH_USERNAME'];
      delete process.env['SSH_PASSWORD'];
      delete process.env['SSH_PRIVATE_KEY_PATH'];

      const config = loadConfig({ logLevel: 'error' }, { skipDotenv: true, configPath });

      expect(config.ssh.host).toBe('env-host');
      expect(config.logLevel).toBe('error');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('loadConfigFile', () => {
  it('should return empty object for non-existent file', () => {
    const result = loadConfigFile('/this/does/not/exist.json');
    expect(result).toEqual({});
  });

  it('should load and parse a valid JSON file', () => {
    const tmpDir = join(process.cwd(), 'tmp-test-config3');
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'test.json');

    writeFileSync(configPath, JSON.stringify({ key: 'value' }));

    try {
      const result = loadConfigFile(configPath);
      expect(result).toEqual({ key: 'value' });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should throw on invalid JSON', () => {
    const tmpDir = join(process.cwd(), 'tmp-test-config4');
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'bad.json');

    writeFileSync(configPath, 'not valid json');

    try {
      expect(() => loadConfigFile(configPath)).toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should throw if config file contains an array', () => {
    const tmpDir = join(process.cwd(), 'tmp-test-config5');
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, 'array.json');

    writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    try {
      expect(() => loadConfigFile(configPath)).toThrow('must contain a JSON object');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('formatValidationErrors', () => {
  it('should format Zod errors into readable messages', () => {
    const error = new ZodError([
      {
        code: 'too_small',
        minimum: 1,
        type: 'string',
        inclusive: true,
        exact: false,
        message: 'SSH host is required',
        path: ['ssh', 'host'],
      },
      {
        code: 'too_small',
        minimum: 1,
        type: 'string',
        inclusive: true,
        exact: false,
        message: 'HuggingFace token is required',
        path: ['huggingfaceToken'],
      },
    ]);

    const messages = formatValidationErrors(error);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('ssh.host: SSH host is required');
    expect(messages[1]).toBe('huggingfaceToken: HuggingFace token is required');
  });
});
