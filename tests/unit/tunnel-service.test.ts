import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns';
import type { TunnelConfig } from '../../src/types/config.js';
import {
  TunnelService,
  TunnelError,
  TunnelCreationError,
  TunnelProviderNotAvailableError,
  isPublicTunnelUrl,
} from '../../src/services/tunnel-service.js';
import type { TunnelInfo, TunnelResult, TunnelStatus } from '../../src/services/tunnel-service.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createDefaultTunnelConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    enabled: false,
    provider: 'ngrok',
    ngrokRegion: 'us',
    localPort: 8000,
    timeoutMs: 30_000,
    retryAttempts: 3,
    retryDelayMs: 5_000,
    ...overrides,
  };
}

function _createMockTunnelInfo(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    publicUrl: 'https://abc123.ngrok-free.app',
    provider: 'ngrok',
    localPort: 8000,
    establishedAt: '2024-01-01T00:00:00.000Z',
    tunnelId: null,
    region: 'us',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TunnelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('initializes with default tunnel config', () => {
      const config = createDefaultTunnelConfig();
      const service = new TunnelService({ config });
      expect(service).toBeInstanceOf(TunnelService);
    });

    it('initializes with custom log level', () => {
      const config = createDefaultTunnelConfig();
      const service = new TunnelService({ config, logLevel: 'debug' });
      expect(service).toBeInstanceOf(TunnelService);
    });

    it('initializes with enabled config', () => {
      const config = createDefaultTunnelConfig({ enabled: true });
      const service = new TunnelService({ config });
      expect(service.enabled).toBe(true);
    });
  });

  describe('enabled property', () => {
    it('returns false when tunnel is disabled', () => {
      const config = createDefaultTunnelConfig({ enabled: false });
      const service = new TunnelService({ config });
      expect(service.enabled).toBe(false);
    });

    it('returns true when tunnel is enabled', () => {
      const config = createDefaultTunnelConfig({ enabled: true });
      const service = new TunnelService({ config });
      expect(service.enabled).toBe(true);
    });
  });

  describe('activeTunnel property', () => {
    it('returns null when no tunnel is active', () => {
      const config = createDefaultTunnelConfig();
      const service = new TunnelService({ config });
      expect(service.activeTunnel).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('returns disabled status when tunnel is disabled', () => {
      const config = createDefaultTunnelConfig({ enabled: false });
      const service = new TunnelService({ config });

      const status: TunnelStatus = service.getStatus();
      expect(status).toEqual({
        enabled: false,
        active: false,
        tunnel: null,
        provider: 'ngrok',
      });
    });

    it('returns enabled but inactive status before connection', () => {
      const config = createDefaultTunnelConfig({ enabled: true });
      const service = new TunnelService({ config });

      const status = service.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.active).toBe(false);
      expect(status.tunnel).toBeNull();
      expect(status.provider).toBe('ngrok');
    });
  });

  describe('connect', () => {
    it('returns failure when tunnel service is disabled', async () => {
      const config = createDefaultTunnelConfig({ enabled: false });
      const service = new TunnelService({ config });

      const result: TunnelResult = await service.connect();
      expect(result.success).toBe(false);
      expect(result.tunnel).toBeNull();
      expect(result.error).toBe('Tunnel service is disabled');
      expect(result.reused).toBe(false);
    });

    it('attempts to check for existing tunnel before creating new one', async () => {
      const config = createDefaultTunnelConfig({
        enabled: true,
        retryAttempts: 0,
        timeoutMs: 100,
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ tunnels: [] }),
        } as Response),
      );

      const originalBin = process.env['NGROK_BIN'];
      process.env['NGROK_BIN'] = '/nonexistent/ngrok-binary';

      try {
        const result = await service.connect();
        expect(result.success).toBe(false);
        expect(result.tunnel).toBeNull();
        expect(result.error).toBeDefined();
      } finally {
        if (originalBin === undefined) {
          delete process.env['NGROK_BIN'];
        } else {
          process.env['NGROK_BIN'] = originalBin;
        }
        vi.unstubAllGlobals();
      }
    });
  });

  describe('disconnect', () => {
    it('does nothing when no tunnel is active', async () => {
      const config = createDefaultTunnelConfig();
      const service = new TunnelService({ config });

      // Should not throw
      await service.disconnect();
      expect(service.activeTunnel).toBeNull();
    });
  });

  describe('cloudflared provider', () => {
    // Isolate the persisted-tunnel state dir per test so we never read the live daemon's
    // ~/.elastic-llm-benchmarker state file (which would make these tests flaky).
    let stateDir: string;
    let originalStateDir: string | undefined;

    beforeEach(async () => {
      originalStateDir = process.env['BENCHMARKER_TUNNEL_STATE_DIR'];
      stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-tunnel-'));
      process.env['BENCHMARKER_TUNNEL_STATE_DIR'] = stateDir;
    });

    afterEach(async () => {
      if (originalStateDir === undefined) {
        delete process.env['BENCHMARKER_TUNNEL_STATE_DIR'];
      } else {
        process.env['BENCHMARKER_TUNNEL_STATE_DIR'] = originalStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    });

    it('reports the cloudflared provider in status', () => {
      const config = createDefaultTunnelConfig({ enabled: true, provider: 'cloudflared' });
      const service = new TunnelService({ config });
      expect(service.getStatus().provider).toBe('cloudflared');
    });

    it('returns a clean failure (no daemon crash) when the cloudflared binary is missing', async () => {
      const config = createDefaultTunnelConfig({
        enabled: true,
        provider: 'cloudflared',
        localPort: 18000,
        retryAttempts: 0,
        timeoutMs: 2_000,
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      // Local backend probe resolves OK so the shared backend-wait returns fast;
      // the missing binary then surfaces as a clean failure (no daemon crash).
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response),
      );

      const originalBin = process.env['CLOUDFLARED_BIN'];
      process.env['CLOUDFLARED_BIN'] = '/nonexistent/cloudflared-binary';

      try {
        const result = await service.connect();
        expect(result.success).toBe(false);
        expect(result.tunnel).toBeNull();
        expect(result.error).toBeDefined();
      } finally {
        if (originalBin === undefined) {
          delete process.env['CLOUDFLARED_BIN'];
        } else {
          process.env['CLOUDFLARED_BIN'] = originalBin;
        }
        vi.unstubAllGlobals();
      }
    });

    it('reuses a surviving tunnel (alive pid + resolving host) instead of spawning a fresh one', async () => {
      const localPort = 19100;
      const persistedUrl = 'https://reuse-me.trycloudflare.com';
      // Persist a tunnel owned by a live pid (this test process) so isPidAlive() is true.
      await fs.writeFile(
        path.join(stateDir, `cloudflared-${localPort}.json`),
        JSON.stringify({
          pid: process.pid,
          url: persistedUrl,
          localPort,
          establishedAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf8',
      );
      // Host still resolves ⇒ safe to reuse. (Same object ref as the module's dnsPromises.)
      const resolveSpy = vi
        .spyOn(dns.promises, 'resolve4')
        .mockResolvedValue(['1.2.3.4'] as unknown as string[]);

      const config = createDefaultTunnelConfig({
        enabled: true,
        provider: 'cloudflared',
        localPort,
        retryAttempts: 0,
        timeoutMs: 2_000,
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      try {
        const result = await service.connect();
        expect(result.success).toBe(true);
        expect(result.reused).toBe(true);
        expect(result.tunnel?.publicUrl).toBe(persistedUrl);
        expect(result.tunnel?.provider).toBe('cloudflared');
      } finally {
        resolveSpy.mockRestore();
      }
    });

    it('drops a stale state file (dead pid) and does not reuse it', async () => {
      const localPort = 19200;
      const stateFile = path.join(stateDir, `cloudflared-${localPort}.json`);
      // pid extremely unlikely to be alive ⇒ isPidAlive() false ⇒ checkExisting clears it.
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          pid: 2_147_483_646,
          url: 'https://dead.trycloudflare.com',
          localPort,
          establishedAt: '2026-01-01T00:00:00.000Z',
        }),
        'utf8',
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response),
      );
      const originalBin = process.env['CLOUDFLARED_BIN'];
      process.env['CLOUDFLARED_BIN'] = '/nonexistent/cloudflared-binary';

      const config = createDefaultTunnelConfig({
        enabled: true,
        provider: 'cloudflared',
        localPort,
        retryAttempts: 0,
        timeoutMs: 2_000,
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      try {
        const result = await service.connect();
        // Reuse rejected (dead pid); falls through to create() which fails on missing binary.
        expect(result.reused).toBe(false);
        expect(result.success).toBe(false);
        // Stale state file must have been removed.
        await expect(fs.access(stateFile)).rejects.toBeDefined();
      } finally {
        if (originalBin === undefined) {
          delete process.env['CLOUDFLARED_BIN'];
        } else {
          process.env['CLOUDFLARED_BIN'] = originalBin;
        }
        vi.unstubAllGlobals();
      }
    });
  });

  describe('cloudflared_named provider', () => {
    function namedConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
      return createDefaultTunnelConfig({
        enabled: true,
        provider: 'cloudflared_named',
        cloudflaredTunnelName: 'benchmarker-vllm',
        publicHostname: 'https://benchmarker.example.com',
        cloudflaredConfigPath: '/tmp/benchmarker-vllm-config.yml',
        localPort: 18000,
        ...overrides,
      });
    }

    it('reports the cloudflared_named provider in status', () => {
      const service = new TunnelService({ config: namedConfig(), logLevel: 'error' });
      expect(service.getStatus().provider).toBe('cloudflared_named');
    });

    it('throws at construction when cloudflaredTunnelName is missing', () => {
      expect(
        () =>
          new TunnelService({
            config: namedConfig({ cloudflaredTunnelName: undefined }),
            logLevel: 'error',
          }),
      ).toThrow(TunnelProviderNotAvailableError);
    });

    it('throws at construction when publicHostname is missing', () => {
      expect(
        () =>
          new TunnelService({
            config: namedConfig({ publicHostname: undefined }),
            logLevel: 'error',
          }),
      ).toThrow(/publicHostname is required/);
    });

    it('throws at construction when cloudflaredConfigPath is missing', () => {
      expect(
        () =>
          new TunnelService({
            config: namedConfig({ cloudflaredConfigPath: undefined }),
            logLevel: 'error',
          }),
      ).toThrow(/cloudflaredConfigPath is required/);
    });
  });

  describe('cloudrun provider', () => {
    it('throws TunnelProviderNotAvailableError when trying to connect', async () => {
      const config = createDefaultTunnelConfig({
        enabled: true,
        provider: 'cloudrun',
        retryAttempts: 0,
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      const result = await service.connect();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
    });
  });

  describe('load_balancer provider', () => {
    it('throws TunnelProviderNotAvailableError when trying to connect', async () => {
      const config = createDefaultTunnelConfig({
        enabled: true,
        provider: 'load_balancer',
        retryAttempts: 0,
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      const result = await service.connect();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not yet implemented');
    });
  });

  describe('retry logic', () => {
    it('respects retryAttempts configuration', async () => {
      const config = createDefaultTunnelConfig({
        enabled: true,
        provider: 'cloudrun', // Will always fail
        retryAttempts: 2,
        retryDelayMs: 10, // Short delay for testing
      });
      const service = new TunnelService({ config, logLevel: 'error' });

      const startTime = Date.now();
      const result = await service.connect();
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      // 3 total attempts (1 initial + 2 retries) with 10ms delays = at least 20ms
      expect(elapsed).toBeGreaterThanOrEqual(15);
    });

    it('returns on first success without retrying', async () => {
      const config = createDefaultTunnelConfig({
        enabled: false, // Disabled, so connect returns immediately
        retryAttempts: 5,
      });
      const service = new TunnelService({ config });

      const result = await service.connect();
      expect(result.success).toBe(false);
      expect(result.error).toBe('Tunnel service is disabled');
    });
  });
});

describe('TunnelError', () => {
  it('creates a TunnelError with provider information', () => {
    const error = new TunnelError('test error', 'ngrok');
    expect(error.name).toBe('TunnelError');
    expect(error.message).toBe('test error');
    expect(error.provider).toBe('ngrok');
  });

  it('includes cause error', () => {
    const cause = new Error('root cause');
    const error = new TunnelError('test error', 'ngrok', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('TunnelCreationError', () => {
  it('creates error with attempt count', () => {
    const error = new TunnelCreationError('ngrok', 3);
    expect(error.name).toBe('TunnelCreationError');
    expect(error.provider).toBe('ngrok');
    expect(error.attempts).toBe(3);
    expect(error.message).toContain('3 attempt(s)');
  });

  it('includes cause error message', () => {
    const cause = new Error('connection refused');
    const error = new TunnelCreationError('ngrok', 2, cause);
    expect(error.message).toContain('connection refused');
  });
});

describe('TunnelProviderNotAvailableError', () => {
  it('creates error with provider and reason', () => {
    const error = new TunnelProviderNotAvailableError('cloudrun', 'not implemented');
    expect(error.name).toBe('TunnelProviderNotAvailableError');
    expect(error.provider).toBe('cloudrun');
    expect(error.message).toContain('not implemented');
  });
});

describe.skip('TunnelService with exposeApiNode', () => {
  function createConfig(tunnelService?: unknown) {
    return { configurable: { tunnelService } };
  }

  it('exposeApiNode works with null tunnel service', async () => {
    const { exposeApiNode } = await import('../../src/agent/nodes.js');

    const state = createMinimalGraphState();
    const result = await exposeApiNode(state, createConfig(null));

    expect(result.currentState).toBe('running_kibana_eval');
    expect(result.tunnelUrl).toBeNull();
  });

  it('exposeApiNode works with disabled tunnel service', async () => {
    const { exposeApiNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultTunnelConfig({ enabled: false });
    const tunnelService = new TunnelService({ config, logLevel: 'error' });

    const state = createMinimalGraphState();
    const result = await exposeApiNode(state, createConfig(tunnelService));

    expect(result.currentState).toBe('running_kibana_eval');
    expect(result.tunnelUrl).toBeNull();
  });

  it('exposeApiNode handles tunnel failure gracefully', async () => {
    const { exposeApiNode } = await import('../../src/agent/nodes.js');
    const config = createDefaultTunnelConfig({
      enabled: true,
      provider: 'cloudrun', // Will fail
      retryAttempts: 0,
    });
    const tunnelService = new TunnelService({ config, logLevel: 'error' });

    const state = createMinimalGraphState();
    const result = await exposeApiNode(state, createConfig(tunnelService));

    // Should NOT error out, just continue without tunnel
    expect(result.currentState).toBe('running_kibana_eval');
    expect(result.tunnelUrl).toBeNull();
    expect(result.error).toBeNull();
  });

  it('exposeApiNode works without tunnel when configurable is empty', async () => {
    const { exposeApiNode } = await import('../../src/agent/nodes.js');

    const state = createMinimalGraphState();
    const result = await exposeApiNode(state, { configurable: {} });

    expect(result.currentState).toBe('running_kibana_eval');
    expect(result.tunnelUrl).toBeNull();
  });
});

// ─── Minimal state helper for agent node tests ──────────────────────────────

function createMinimalGraphState() {
  return {
    currentState: 'exposing_api',
    discoveredModels: [],
    currentModel: null,
    results: [],
    evaluatedModelIds: [],
    error: null,
    errorCount: 0,
    lastSuccessTimestamp: null,
    skippedModelIds: [],
    circuitBreakerSnapshot: null,
    recoveryRecords: [],
    lastErrorCategory: null,
    currentModelRetryCount: 0,
    tunnelUrl: null,
    kibanaConnectorId: null,
  };
}

describe('isPublicTunnelUrl', () => {
  it('accepts ngrok public HTTPS URLs', () => {
    expect(isPublicTunnelUrl('https://uninked-burton-unransomable.ngrok-free.dev')).toBe(true);
    expect(isPublicTunnelUrl('https://abc123.ngrok-free.app')).toBe(true);
  });

  it('accepts Cloudflare quick-tunnel HTTPS URLs', () => {
    expect(isPublicTunnelUrl('https://random-words-here.trycloudflare.com')).toBe(true);
  });

  it('rejects ngrok local inspector and non-HTTPS URLs', () => {
    expect(isPublicTunnelUrl('http://127.0.0.1:4040')).toBe(false);
    expect(isPublicTunnelUrl('http://localhost:4040')).toBe(false);
    expect(isPublicTunnelUrl('not-a-url')).toBe(false);
  });
});
