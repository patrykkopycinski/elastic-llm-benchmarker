import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VllmPublicEndpointResolver } from '../../src/services/vllm-public-endpoint.js';
import type { SSHConfig, TunnelConfig } from '../../src/types/config.js';

const mockStart = vi.fn();
const mockWaitUntilReady = vi.fn();
const mockStop = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('../../src/utils/ssh-port-forward.js', () => ({
  SshPortForward: vi.fn().mockImplementation(() => ({
    start: mockStart,
    waitUntilReady: mockWaitUntilReady,
    stop: mockStop,
  })),
}));

vi.mock('../../src/services/tunnel-service.js', () => ({
  TunnelService: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
  })),
}));

const ssh: SSHConfig = {
  host: 'your-gpu-vm-host',
  port: 22,
  username: 'patryk',
  privateKeyPath: '/tmp/key',
  useSudo: true,
};

describe('VllmPublicEndpointResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('returns direct URL when tunnel disabled', async () => {
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
    const result = await resolver.resolve('http://your-gpu-vm-host:8000');

    expect(result.endpointUrl).toBe('http://your-gpu-vm-host:8000');
    expect(result.tunneled).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
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
    const directUrl = 'http://your-gpu-vm-host:8000';
    const result = await resolver.resolve(directUrl);

    expect(mockStart).toHaveBeenCalled();
    expect(mockWaitUntilReady).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(result.endpointUrl).toBe('https://abc123.ngrok-free.app');
    expect(result.directUrl).toBe(directUrl);
    expect(result.tunneled).toBe(true);

    await result.cleanup();
    expect(mockDisconnect).toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
  });

  it('falls back to direct URL when ngrok token missing', async () => {
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
    const directUrl = 'http://your-gpu-vm-host:8000';
    const result = await resolver.resolve(directUrl);

    expect(result.endpointUrl).toBe(directUrl);
    expect(result.tunneled).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
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
    const directUrl = 'http://your-gpu-vm-host:8000';
    const result = await resolver.resolve(directUrl);

    expect(result.endpointUrl).toBe(directUrl);
    expect(result.tunneled).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
