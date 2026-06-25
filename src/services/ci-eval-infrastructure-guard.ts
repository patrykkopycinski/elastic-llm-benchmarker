import type { SSHConfig } from '../types/config.js';
import type { SSHClientPool } from './ssh-client.js';
import type { TunnelService } from './tunnel-service.js';
import { SshPortForward } from '../utils/ssh-port-forward.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';

export interface CiEvalInfrastructureGuardOptions {
  ssh: SSHConfig;
  sshPool: SSHClientPool;
  localPort: number;
  deploymentName: string;
  /** Existing SSH forward from public endpoint setup (may be dead). */
  sshForward: SshPortForward;
  /** Public ngrok URL for Buildkite (when tunneled). */
  publicEndpointUrl?: string;
  /** Ngrok tunnel service for reconnect when the public URL dies mid-poll. */
  tunnelService?: TunnelService;
  useSudo?: boolean;
  checkIntervalMs?: number;
  logLevel?: string;
}

/**
 * Keeps SSH port-forward, ngrok public URL, and the vLLM container alive while Buildkite polls.
 * Restarts the forward when it drops, reconnects ngrok when the public URL fails, and
 * `docker start`s the container when exited.
 */
export class CiEvalInfrastructureGuard {
  private readonly logger: Logger;
  private readonly options: Required<Pick<CiEvalInfrastructureGuardOptions, 'checkIntervalMs' | 'useSudo'>> &
    CiEvalInfrastructureGuardOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(options: CiEvalInfrastructureGuardOptions) {
    this.options = {
      checkIntervalMs: 15_000,
      useSudo: true,
      ...options,
    };
    this.logger = createLogger(options.logLevel ?? 'info');
  }

  start(): void {
    if (this.timer) return;
    this.logger.info('CI eval infrastructure guard started', {
      localPort: this.options.localPort,
      deploymentName: this.options.deploymentName,
      intervalMs: this.options.checkIntervalMs,
    });
    void this.ensureRestartPolicy();
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), this.options.checkIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('CI eval infrastructure guard stopped', {
      deploymentName: this.options.deploymentName,
    });
  }

  private async checkOnce(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.ensureContainerRunning();
      await this.ensureForwardHealthy();
      await this.ensureNgrokHealthy();
    } catch (err) {
      this.logger.warn('CI eval infrastructure guard check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.checking = false;
    }
  }

  private async probeLocalEndpoint(): Promise<boolean> {
    const url = `http://127.0.0.1:${this.options.localPort}/v1/models`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async probePublicEndpoint(): Promise<boolean> {
    const base = this.options.publicEndpointUrl?.replace(/\/+$/, '');
    if (!base) {
      return true;
    }
    const url = `${base}/v1/models`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async ensureNgrokHealthy(): Promise<void> {
    if (!this.options.tunnelService || !this.options.publicEndpointUrl) {
      return;
    }

    if (await this.probePublicEndpoint()) {
      return;
    }

    this.logger.warn('CI eval guard: public ngrok endpoint unhealthy — reconnecting tunnel', {
      publicEndpointUrl: this.options.publicEndpointUrl,
    });

    const reconnectResult = await this.options.tunnelService.reconnect();
    if (!reconnectResult.success || !reconnectResult.tunnel) {
      this.logger.error('CI eval guard: ngrok reconnect failed', {
        error: reconnectResult.error,
      });
      return;
    }

    const ok = await this.probePublicEndpoint();
    this.logger.info('CI eval guard: ngrok tunnel recovered', {
      healthy: ok,
      publicUrl: reconnectResult.tunnel.publicUrl,
    });
  }

  private async ensureForwardHealthy(): Promise<void> {
    if (await this.probeLocalEndpoint()) {
      return;
    }

    this.logger.warn('CI eval guard: local vLLM forward unhealthy — restarting SSH tunnel', {
      localPort: this.options.localPort,
    });

    this.options.sshForward.stop();
    this.options.sshForward.start();
    const ready = await this.options.sshForward.waitUntilReady();
    if (!ready) {
      this.logger.error('CI eval guard: SSH port forward failed to recover', {
        localPort: this.options.localPort,
      });
      return;
    }

    const ok = await this.probeLocalEndpoint();
    this.logger.info('CI eval guard: SSH port forward recovered', { healthy: ok });
  }

  private async ensureRestartPolicy(): Promise<void> {
    const result = await this.options.sshPool.exec(
      this.options.ssh,
      `docker update --restart unless-stopped ${this.options.deploymentName}`,
      { timeout: 30_000, sudo: this.options.useSudo },
    );
    if (!result.success) {
      this.logger.warn('CI eval guard: failed to set docker restart policy', {
        deploymentName: this.options.deploymentName,
        stderr: result.stderr,
      });
    }
  }

  private async ensureContainerRunning(): Promise<void> {
    const running = await this.isContainerRunning();
    if (running) return;

    const exitInfo = await this.getContainerExitInfo();
    this.logger.warn('CI eval guard: vLLM container not running — starting', {
      deploymentName: this.options.deploymentName,
      ...exitInfo,
    });

    const result = await this.options.sshPool.exec(
      this.options.ssh,
      `docker start ${this.options.deploymentName}`,
      { timeout: 120_000, sudo: this.options.useSudo },
    );

    if (!result.success) {
      this.logger.error('CI eval guard: failed to start vLLM container', {
        deploymentName: this.options.deploymentName,
        stderr: result.stderr,
      });
      return;
    }

    await this.waitForContainerApi();
  }

  private async isContainerRunning(): Promise<boolean> {
    const result = await this.options.sshPool.exec(
      this.options.ssh,
      `docker inspect -f '{{.State.Running}}' ${this.options.deploymentName}`,
      { timeout: 30_000, sudo: this.options.useSudo },
    );
    if (!result.success) {
      return false;
    }
    return result.stdout.trim() === 'true';
  }

  private async getContainerExitInfo(): Promise<{
    exitCode?: string;
    oomKilled?: string;
    error?: string;
  }> {
    const result = await this.options.sshPool.exec(
      this.options.ssh,
      `docker inspect -f '{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}' ${this.options.deploymentName}`,
      { timeout: 30_000, sudo: this.options.useSudo },
    );
    if (!result.success) {
      return {};
    }
    const [exitCode, oomKilled, error] = result.stdout.trim().split('|');
    return {
      exitCode: exitCode || undefined,
      oomKilled: oomKilled || undefined,
      error: error || undefined,
    };
  }

  private async waitForContainerApi(maxWaitMs = 600_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (await this.probeLocalEndpoint()) {
        this.logger.info('CI eval guard: vLLM container API ready after start', {
          deploymentName: this.options.deploymentName,
          elapsedMs: Date.now() - start,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    this.logger.warn('CI eval guard: vLLM container started but API not ready before timeout', {
      deploymentName: this.options.deploymentName,
      maxWaitMs,
    });
  }
}
