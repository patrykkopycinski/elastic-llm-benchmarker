import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CiEvalInfrastructureGuard } from '../../src/services/ci-eval-infrastructure-guard.js';
import type { SSHClientPool } from '../../src/services/ssh-client.js';
import type { SshPortForward } from '../../src/utils/ssh-port-forward.js';
import type { SSHConfig } from '../../src/types/config.js';

const sshConfig = {
  host: '34.29.5.12',
  port: 22,
  username: 'patryk',
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
    });

    guard.start();
    await vi.runOnlyPendingTimersAsync();

    expect(tunnelService.reconnect).toHaveBeenCalledTimes(1);
    guard.stop();
  });
});
