import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CiEvalInfrastructureGuard } from '../../src/services/ci-eval-infrastructure-guard.js';
import type { SSHClientPool } from '../../src/services/ssh-client.js';
import type { SshPortForward } from '../../src/utils/ssh-port-forward.js';
import type { SSHConfig } from '../../src/types/config.js';

const sshConfig = {
  host: '203.0.113.10',
  port: 22,
  username: 'test-user',
  privateKeyPath: '/tmp/key',
} satisfies SSHConfig;

describe('CiEvalInfrastructureGuard', () => {
  let sshForward: SshPortForward;
  let sshPool: SSHClientPool;

  beforeEach(() => {
    vi.useFakeTimers();
    sshForward = {
      stop: vi.fn(),
      start: vi.fn(),
      waitUntilReady: vi.fn().mockResolvedValue(true),
      isRunning: true,
    } as unknown as SshPortForward;

    sshPool = {
      exec: vi.fn().mockResolvedValue({ success: true, stdout: 'true', stderr: '', exitCode: 0 }),
    } as unknown as SSHClientPool;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true } as Response),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts container when docker inspect reports not running', async () => {
    vi.mocked(sshPool.exec)
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, stdout: 'false', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, stdout: '1|false|', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-test',
      sshForward,
      checkIntervalMs: 60_000,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();

    expect(sshPool.exec).toHaveBeenCalledWith(
      sshConfig,
      'docker update --restart unless-stopped vllm-model-test',
      expect.objectContaining({ sudo: true }),
    );
    expect(sshPool.exec).toHaveBeenCalledWith(
      sshConfig,
      "docker inspect -f '{{.State.Running}}' vllm-model-test",
      expect.objectContaining({ sudo: true }),
    );
    expect(sshPool.exec).toHaveBeenCalledWith(
      sshConfig,
      'docker start vllm-model-test',
      expect.objectContaining({ sudo: true }),
    );
    guard.stop();
  });

  it('restarts SSH forward when local probe fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-test',
      sshForward,
      checkIntervalMs: 60_000,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();

    expect(sshForward.stop).toHaveBeenCalled();
    expect(sshForward.start).toHaveBeenCalled();
    guard.stop();
  });

  it('aborts via onTakeover when the container was removed externally (no docker start)', async () => {
    const onTakeover = vi.fn();
    vi.mocked(sshPool.exec)
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 }) // restart policy
      .mockResolvedValueOnce({ success: true, stdout: 'false', stderr: '', exitCode: 0 }) // isContainerRunning -> stopped
      .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'No such object', exitCode: 1 }); // containerExists -> removed

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'Qwen/Qwen3.6-35B-A3B' }] }),
    } as unknown as Response);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-deepreinforce-ai-ornith-1.0-35b',
      sshForward,
      expectedModelId: 'deepreinforce-ai/Ornith-1.0-35B',
      onTakeover,
      checkIntervalMs: 60_000,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(onTakeover.mock.calls[0][0]).toContain('Qwen/Qwen3.6-35B-A3B');
    expect(sshPool.exec).not.toHaveBeenCalledWith(
      sshConfig,
      'docker start vllm-model-deepreinforce-ai-ornith-1.0-35b',
      expect.anything(),
    );
    guard.stop();
  });

  it('aborts via onTakeover when a foreign model serves on our endpoint', async () => {
    const onTakeover = vi.fn();
    vi.mocked(sshPool.exec)
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 }) // restart policy
      .mockResolvedValueOnce({ success: true, stdout: 'true', stderr: '', exitCode: 0 }); // isContainerRunning -> running

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'Qwen/Qwen3.6-35B-A3B' }] }),
    } as unknown as Response);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-ornith',
      sshForward,
      expectedModelId: 'deepreinforce-ai/Ornith-1.0-35B',
      onTakeover,
      checkIntervalMs: 60_000,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onTakeover).toHaveBeenCalledTimes(1);
    expect(onTakeover.mock.calls[0][0]).toContain('foreign model');
    guard.stop();
  });

  it('reconnects ngrok when public endpoint probe fails', async () => {
    const tunnelService = {
      reconnect: vi.fn().mockResolvedValue({
        success: true,
        tunnel: { publicUrl: 'https://new.ngrok-free.app' },
        error: null,
        reused: false,
      }),
    };

    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-test',
      sshForward,
      publicEndpointUrl: 'https://old.ngrok-free.app',
      tunnelService: tunnelService as never,
      checkIntervalMs: 60_000,
      // threshold 1: this test exercises the reconnect mechanism, not the debounce.
      publicProbeFailureThreshold: 1,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();

    expect(tunnelService.reconnect).toHaveBeenCalledTimes(1);
    guard.stop();
  });

  it('adopts the reconnected tunnel URL and does not loop when the hostname rotated', async () => {
    // reconnect hands back a DIFFERENT surviving-tunnel hostname (cloudflared reuse).
    const tunnelService = {
      reconnect: vi.fn().mockResolvedValue({
        success: true,
        tunnel: { publicUrl: 'https://ambien-underground-ball-pressure.trycloudflare.com' },
        error: null,
        reused: true,
      }),
    };

    // fetch order per interval: local-probe(ok), public-probe(fail), public-reprobe(ok).
    // The reprobe must hit the NEW url — if the guard kept the stale url it would fail and
    // the next interval would reconnect again. We assert reconnect fires exactly once across
    // two intervals to prove convergence.
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('wellness-rating-sensor-movers')) {
        return { ok: false } as Response; // stale original url is dead
      }
      return { ok: true } as Response; // local endpoint + new tunnel url are healthy
    });
    vi.stubGlobal('fetch', fetchMock);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-test',
      sshForward,
      publicEndpointUrl: 'https://wellness-rating-sensor-movers.trycloudflare.com',
      tunnelService: tunnelService as never,
      checkIntervalMs: 60_000,
      // threshold 1: this test asserts URL adoption + convergence, not the debounce.
      publicProbeFailureThreshold: 1,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();
    // Second interval: the guard should now probe the adopted url (healthy) and NOT reconnect.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(tunnelService.reconnect).toHaveBeenCalledTimes(1);
    // Every public probe after adoption targets the new hostname, never the dead original.
    const probedNewUrl = fetchMock.mock.calls.some((c) =>
      String(c[0]).includes('ambien-underground-ball-pressure'),
    );
    expect(probedNewUrl).toBe(true);
    guard.stop();
  });

  it('does not reconnect on transient public-probe failures below the threshold', async () => {
    const tunnelService = {
      reconnect: vi.fn().mockResolvedValue({
        success: true,
        tunnel: { publicUrl: 'https://replacement.trycloudflare.com' },
        error: null,
        reused: true,
      }),
    };

    // Local endpoint healthy; the public quick-tunnel edge fails every single-shot probe.
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('flaky-edge')) {
        return { ok: false } as Response;
      }
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-test',
      sshForward,
      publicEndpointUrl: 'https://flaky-edge.trycloudflare.com',
      tunnelService: tunnelService as never,
      checkIntervalMs: 60_000,
      publicProbeFailureThreshold: 3,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();
    // One or two failures accrued so far — below the threshold of 3, so no reconnect yet.
    expect(tunnelService.reconnect).not.toHaveBeenCalled();

    // Sustained failure across enough intervals must eventually cross the threshold.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tunnelService.reconnect).toHaveBeenCalled();
    guard.stop();
  });

  it('never reconnects when public-probe failures are intermittent (a success resets the run)', async () => {
    const tunnelService = { reconnect: vi.fn() };

    // The public edge alternates fail/ok — it never fails 3 times in a row, mirroring the
    // real quick-tunnel flakiness where sustained eval traffic flows fine. The guard must
    // treat this as healthy and never reconnect.
    let publicProbes = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('flaky-edge')) {
        publicProbes += 1;
        return { ok: publicProbes % 2 === 0 } as Response;
      }
      return { ok: true } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const guard = new CiEvalInfrastructureGuard({
      ssh: sshConfig,
      sshPool,
      localPort: 18000,
      deploymentName: 'vllm-model-test',
      sshForward,
      publicEndpointUrl: 'https://flaky-edge.trycloudflare.com',
      tunnelService: tunnelService as never,
      checkIntervalMs: 60_000,
      publicProbeFailureThreshold: 3,
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(tunnelService.reconnect).not.toHaveBeenCalled();
    guard.stop();
  });
});
