import type { SSHConfig } from '../types/config.js';
import type { SSHClientPool } from './ssh-client.js';
import type { TunnelService } from './tunnel-service.js';
import type { SshPortForward } from '../utils/ssh-port-forward.js';
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
  /**
   * Model id this deployment is expected to serve. When set, the guard verifies the
   * local endpoint still serves this model and flags a takeover if a foreign model
   * is served on the shared VM (see `onTakeover`).
   */
  expectedModelId?: string;
  /**
   * Fired once when the guard detects the deployment was taken over externally on a
   * shared VM — either the container was `docker rm`'d (a `docker start` can never
   * recover it) or a foreign model now serves on the endpoint. After firing, the guard
   * stops attempting restarts. The caller should abort Stage 2 cleanly (retriable),
   * NOT redeploy over the foreign container.
   */
  onTakeover?: (reason: string) => void;
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
  /** Set once an unrecoverable external takeover is detected; halts all guard actions. */
  private fatal = false;
  /**
   * The public URL currently probed. Seeded from `options.publicEndpointUrl` but MUTABLE:
   * a cloudflared reconnect can hand back a *different* surviving-tunnel hostname, and we
   * must adopt it — otherwise every probe keeps hitting the dead original URL, fails, and
   * triggers an endless reconnect-every-interval loop (observed with the guard "recovering"
   * to `healthy:false` forever).
   */
  private currentPublicUrl: string | undefined;

  constructor(options: CiEvalInfrastructureGuardOptions) {
    this.options = {
      checkIntervalMs: 15_000,
      useSudo: true,
      ...options,
    };
    this.currentPublicUrl = options.publicEndpointUrl;
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
    if (this.checking || this.fatal) return;
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
    const base = this.currentPublicUrl?.replace(/\/+$/, '');
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
    if (!this.options.tunnelService || !this.currentPublicUrl) {
      return;
    }

    if (await this.probePublicEndpoint()) {
      return;
    }

    this.logger.warn('CI eval guard: public ngrok endpoint unhealthy — reconnecting tunnel', {
      publicEndpointUrl: this.currentPublicUrl,
    });

    const reconnectResult = await this.options.tunnelService.reconnect();
    if (!reconnectResult.success || !reconnectResult.tunnel) {
      this.logger.error('CI eval guard: ngrok reconnect failed', {
        error: reconnectResult.error,
      });
      return;
    }

    // Adopt whatever URL reconnect handed back. A cloudflared reconnect reattaches to a
    // surviving tunnel that may carry a DIFFERENT hostname than the one we were probing;
    // keeping the stale URL would make every subsequent probe fail and re-trigger this
    // reconnect forever. When the hostname actually changed, warn loudly — the URL already
    // injected into the in-flight Buildkite build is now stale and that eval can no longer
    // reach the model (nothing the guard can do to re-inject a detached build, but the
    // operator needs to see it).
    const newUrl = reconnectResult.tunnel.publicUrl;
    const changed = newUrl !== this.currentPublicUrl;
    if (changed) {
      this.logger.warn(
        'CI eval guard: public tunnel URL changed on reconnect — Buildkite-injected URL is now stale',
        { previousUrl: this.currentPublicUrl, newUrl },
      );
      this.currentPublicUrl = newUrl;
    }

    const ok = await this.probePublicEndpoint();
    this.logger.info('CI eval guard: ngrok tunnel recovered', {
      healthy: ok,
      publicUrl: this.currentPublicUrl,
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
    if (this.fatal) return;

    const running = await this.isContainerRunning();
    if (running) {
      // Our named container is up. On a shared VM, confirm it still serves the expected
      // model — guards against a foreign redeploy that reused the port under our name.
      if (this.options.expectedModelId) {
        const served = await this.servedModelId();
        if (served && served !== this.options.expectedModelId) {
          this.markTakeover(
            `endpoint serves foreign model "${served}" (expected "${this.options.expectedModelId}")`,
          );
        }
      }
      return;
    }

    // Not running. Distinguish a recoverable stop from an unrecoverable external teardown:
    // if the container no longer exists it was `docker rm`'d (often because another
    // benchmarker instance redeployed on the shared VM). `docker start` can never recover
    // this, so abort instead of spinning every interval forever.
    if (!(await this.containerExists())) {
      const served = await this.servedModelId();
      this.markTakeover(
        served
          ? `container removed externally; endpoint now serves "${served}"`
          : 'container removed externally',
      );
      return;
    }

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

  /**
   * True when the named container still exists (any state). `docker inspect` returns
   * non-zero for a removed container, which is how we tell "stopped" (recoverable) from
   * "removed" (external teardown, unrecoverable via `docker start`).
   */
  private async containerExists(): Promise<boolean> {
    const result = await this.options.sshPool.exec(
      this.options.ssh,
      `docker inspect -f '{{.State.Status}}' ${this.options.deploymentName}`,
      { timeout: 30_000, sudo: this.options.useSudo },
    );
    return result.success;
  }

  /** The first model id served by the local vLLM endpoint, or undefined if unreachable. */
  private async servedModelId(): Promise<string | undefined> {
    const url = `http://127.0.0.1:${this.options.localPort}/v1/models`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return body.data?.[0]?.id;
    } catch {
      return undefined;
    }
  }

  /** Records an unrecoverable external takeover exactly once and halts the guard. */
  private markTakeover(reason: string): void {
    if (this.fatal) return;
    this.fatal = true;
    this.logger.error(
      'CI eval guard: vLLM deployment taken over externally — halting guard (Stage 2 must abort, not redeploy over foreign container)',
      { deploymentName: this.options.deploymentName, reason },
    );
    this.options.onTakeover?.(reason);
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
