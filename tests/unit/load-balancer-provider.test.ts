import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { TunnelConfig } from '../../src/types/config.js';
import { TunnelService, TunnelProviderNotAvailableError } from '../../src/services/tunnel-service.js';

function lbConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    enabled: true,
    provider: 'load_balancer',
    localPort: 8000,
    timeoutMs: 10_000,
    retryAttempts: 0,
    retryDelayMs: 100,
    loadBalancerUrl: 'https://vllm-benchmarker.example.com',
    loadBalancerApiKey: undefined,
    ...overrides,
  };
}

describe('LoadBalancerProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mocks fetch so localhost probes (waitForLocalBackend) get 200,
   * while the LB endpoint gets the configured response.
   */
  function mockFetch(lbStatus: number, lbBody = '{"data":[]}'): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('127.0.0.1') || url.includes('localhost')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(lbBody, { status: lbStatus });
    });
  }

  describe('constructor validation', () => {
    it('throws when loadBalancerUrl is missing', () => {
      const config = lbConfig({ loadBalancerUrl: undefined });
      expect(() => new TunnelService({ config })).toThrow(TunnelProviderNotAvailableError);
    });
  });

  describe('connect — endpoint reachable', () => {
    it('returns the configured public URL when /v1/models responds 200', async () => {
      const fetchSpy = mockFetch(200);

      const config = lbConfig();
      const service = new TunnelService({ config });
      const result = await service.connect();

      expect(result.success).toBe(true);
      expect(result.tunnel?.publicUrl).toBe('https://vllm-benchmarker.example.com');
      expect(result.tunnel?.provider).toBe('load_balancer');
      // checkExisting runs first and succeeds (LB reachable) → reused: true
      expect(result.reused).toBe(true);
      // The LB URL was probed
      const lbCalls = fetchSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('vllm-benchmarker'),
      );
      expect(lbCalls.length).toBeGreaterThan(0);
    });

    it('sends Authorization header when loadBalancerApiKey is set', async () => {
      const fetchSpy = mockFetch(200);

      const config = lbConfig({ loadBalancerApiKey: 'secret-key-123' });
      const service = new TunnelService({ config });
      const result = await service.connect();

      expect(result.success).toBe(true);
      const lbCall = fetchSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('vllm-benchmarker'),
      );
      expect(lbCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer secret-key-123' });
    });
  });

  describe('connect — endpoint unreachable', () => {
    it('fails when /v1/models returns 502 (LB up, backend down)', async () => {
      // Local backend (127.0.0.1) returns 200 so waitForLocalBackend passes,
      // but the LB returns 502 → checkExisting returns null → create() throws.
      mockFetch(502, 'Bad Gateway');

      const config = lbConfig({ retryAttempts: 0, timeoutMs: 30_000 });
      const service = new TunnelService({ config });
      const result = await service.connect();

      expect(result.success).toBe(false);
    });

    it('fails on network error to the LB', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('127.0.0.1') || url.includes('localhost')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        throw new Error('ECONNREFUSED');
      });

      const config = lbConfig({ retryAttempts: 0, timeoutMs: 30_000 });
      const service = new TunnelService({ config });
      const result = await service.connect();

      expect(result.success).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('is a no-op that does not throw', async () => {
      mockFetch(200);

      const config = lbConfig();
      const service = new TunnelService({ config });
      await service.connect();

      await expect(service.disconnect()).resolves.toBeUndefined();
    });
  });
});
