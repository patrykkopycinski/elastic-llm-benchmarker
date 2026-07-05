import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VllmPublicEndpointResolver } from '../../src/services/vllm-public-endpoint.js';
import type { SSHConfig, TunnelConfig } from '../../src/types/config.js';

const mockStart = vi.fn();
const mockWaitUntilReady = vi.fn();
const mockStop = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

let running = false;

vi.mock('../../src/utils/ssh-port-forward.js', () => ({
  SshPortForward: vi.fn().mockImplementation(() => ({
    start: () => {
      mockStart();
      running = true;
    },
    waitUntilReady: mockWaitUntilReady,
    stop: () => {
      mockStop();
      running = false;
    },
    get isRunning() {
      return running;
    },
  })),
}));

vi.mock('../../src/services/tunnel-service.js', () => ({
  TunnelService: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
  })),
}));

const ssh: SSHConfig = {
  host: '203.0.113.10',
  port: 22,
  username: 'testuser',
  privateKeyPath: '/tmp/key',
  useSudo: true,
};

describe('VllmPublicEndpointResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    running = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true } as Response));
    mockWaitUntilReady.mockResolvedValue(true);
    mockConnect.mockResolvedValue({
      success: true,
      tunnel: {
        publicUrl: 'https://abc123.ngrok-free.app',
        provider: 'ngrok',
        localPort: 18000,
        establishedAt: new Date().toISOString(),
        tunnelId: 't1',
        region: 'us',
      },
      error: null,
      reused: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses SSH local forward when tunnel disabled', async () => {
    const tunnel: TunnelConfig = {
      enabled: false,
      provider: 'ngrok',
      ngrokRegion: 'us',
      localPort: 18000,
      timeoutMs: 30_000,
      retryAttempts: 3,
      retryDelayMs: 5_000,
    };

    const resolver = new VllmPublicEndpointResolver({ ssh, tunnel });
    const result = await resolver.resolve('http://203.0.113.10:8000');

    expect(result.endpointUrl).toBe('http://127.0.0.1:18000');
    expect(result.publicEndpointUrl).toBeUndefined();
    expect(result.tunneled).toBe(false);
    expect(mockStart).toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('establishes SSH forward + ngrok when tunnel enabled', async () => {
    const tunnel: TunnelConfig = {
      enabled: true,
      provider: 'ngrok',
      ngrokAuthToken: 'test-token',
      ngrokRegion: 'us',
      localPort: 18000,
      timeoutMs: 30_000,
      retryAttempts: 3,
      retryDelayMs: 5_000,
    };

    const resolver = new VllmPublicEndpointResolver({ ssh, tunnel });
    const directUrl = 'http://203.0.113.10:8000';
    const result = await resolver.resolve(directUrl);

    expect(mockStart).toHaveBeenCalled();
    expect(mockWaitUntilReady).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    // endpointUrl is the STABLE local SSH forward (used by the daemon's own smoke test),
    // not the public tunnel URL — a transient tunnel-edge blip must not fail the local
    // smoke check. publicEndpointUrl carries the tunnel URL for Buildkite / the CI guard.
    expect(result.endpointUrl).toBe('http://127.0.0.1:18000');
    expect(result.publicEndpointUrl).toBe('https://abc123.ngrok-free.app');
    expect(result.directUrl).toBe(directUrl);
    expect(result.tunneled).toBe(true);

    await result.cleanup();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
  });

  it('uses local forward when ngrok token missing', async () => {
    const tunnel: TunnelConfig = {
      enabled: true,
      provider: 'ngrok',
      ngrokRegion: 'us',
      localPort: 18000,
      timeoutMs: 30_000,
      retryAttempts: 3,
      retryDelayMs: 5_000,
    };

    const resolver = new VllmPublicEndpointResolver({ ssh, tunnel });
    const directUrl = 'http://203.0.113.10:8000';
    const result = await resolver.resolve(directUrl);

    expect(result.endpointUrl).toBe('http://127.0.0.1:18000');
    expect(result.publicEndpointUrl).toBeUndefined();
    expect(result.tunneled).toBe(false);
    expect(mockStart).toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('uses local forward when ngrok fails', async () => {
    mockConnect.mockResolvedValue({ success: false, error: 'failed to start tunnel' });

    const tunnel: TunnelConfig = {
      enabled: true,
      provider: 'ngrok',
      ngrokAuthToken: 'test-token',
      ngrokRegion: 'us',
      localPort: 18000,
      timeoutMs: 30_000,
      retryAttempts: 3,
      retryDelayMs: 5_000,
    };

    const resolver = new VllmPublicEndpointResolver({ ssh, tunnel });
    const directUrl = 'http://203.0.113.10:8000';
    const result = await resolver.resolve(directUrl);

    expect(result.endpointUrl).toBe('http://127.0.0.1:18000');
    expect(result.tunneled).toBe(false);
    expect(mockConnect).toHaveBeenCalled();
  });

  it('falls back to direct URL when SSH forward fails', async () => {
    mockWaitUntilReady.mockResolvedValue(false);

    const tunnel: TunnelConfig = {
      enabled: true,
      provider: 'ngrok',
      ngrokAuthToken: 'test-token',
      ngrokRegion: 'us',
      localPort: 18000,
      timeoutMs: 30_000,
      retryAttempts: 3,
      retryDelayMs: 5_000,
    };

    const resolver = new VllmPublicEndpointResolver({ ssh, tunnel });
    const directUrl = 'http://203.0.113.10:8000';
    const result = await resolver.resolve(directUrl);

    expect(result.endpointUrl).toBe(directUrl);
    expect(result.tunneled).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
