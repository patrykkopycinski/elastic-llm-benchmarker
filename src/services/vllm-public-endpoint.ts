import type { SSHConfig, TunnelConfig } from '../types/config.js';
import { SshPortForward } from '../utils/ssh-port-forward.js';
import { TunnelService } from './tunnel-service.js';
import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';

export interface VllmPublicEndpointOptions {
  ssh: SSHConfig;
  tunnel: TunnelConfig;
  /** vLLM API port on the GPU VM (default 8000) */
  apiPort?: number;
  logLevel?: string;
}

export interface PublicEndpointResult {
  /** URL for local smoke tests (localhost SSH forward when available) */
  endpointUrl: string;
  /** Public ngrok URL for Buildkite; undefined when only local forward is available */
  publicEndpointUrl?: string;
  /** Original VM-direct URL before tunneling */
  directUrl: string;
  /** Whether a public ngrok URL was established */
  tunneled: boolean;
  /** Local bind port for SSH forward (when established) */
  localPort?: number;
  /** Active SSH forward instance (for deferred-poll keepalive) */
  sshForward?: SshPortForward;
  /** Active ngrok tunnel service (for deferred-poll recovery) */
  tunnelService?: TunnelService;
  /** Release SSH forward + ngrok; safe to call multiple times */
  cleanup: () => Promise<void>;
}

const DEFAULT_API_PORT = 8000;

async function probeLocalVllmApi(localPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${localPort}/v1/models`, {
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureSshForwardHealthy(
  sshForward: SshPortForward,
  localPort: number,
  logger: Logger,
  maxAttempts = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!sshForward.isRunning) {
      sshForward.start();
    }

    const tcpReady = await sshForward.waitUntilReady();
    const apiReady = tcpReady && (await probeLocalVllmApi(localPort));
    if (apiReady) {
      return true;
    }

    if (tcpReady) {
      // TCP forward is healthy but vLLM's /v1/models is not answering yet. During a
      // pre-warm that runs concurrently with Stage 1 deploy this is the EXPECTED state
      // (the model is still loading), not a broken forward — so keep the forward up
      // (tearing it down would just thrash a working tunnel) and log quietly. The
      // scheduler re-resolves the tunnel after Stage 1 passes, when vLLM is serving.
      logger.debug('SSH forward TCP-ready but vLLM API not serving yet — waiting', {
        attempt,
        localPort,
      });
    } else {
      // The SSH forward itself never came up — this is a genuine problem worth surfacing.
      logger.warn('SSH forward not healthy — retrying', { attempt, localPort, tcpReady });
      sshForward.stop();
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/**
 * Exposes the GPU VM vLLM API via SSH local forward + optional ngrok.
 *
 * Flow: laptop `localhost:localPort` → SSH → VM `localhost:apiPort` → ngrok public URL.
 * Smoke tests use the SSH forward (localhost). Buildkite requires the ngrok URL.
 */
export class VllmPublicEndpointResolver {
  private readonly ssh: SSHConfig;
  private readonly tunnel: TunnelConfig;
  private readonly apiPort: number;
  private readonly logLevel: string;
  private readonly logger: Logger;

  constructor(options: VllmPublicEndpointOptions) {
    this.ssh = options.ssh;
    this.tunnel = options.tunnel;
    this.apiPort = options.apiPort ?? DEFAULT_API_PORT;
    this.logLevel = options.logLevel ?? 'info';
    this.logger = createLogger(this.logLevel);
  }

  /**
   * Resolves endpoint URLs for CI evals and connector creation.
   * Always attempts SSH port forward; ngrok is optional but required for Buildkite.
   */
  async resolve(directUrl: string): Promise<PublicEndpointResult> {
    const noopCleanup = async (): Promise<void> => {};

    const localPort = this.tunnel.localPort;
    const localUrl = `http://127.0.0.1:${localPort}`;

    const sshForward = new SshPortForward({
      ssh: this.ssh,
      localPort,
      remotePort: this.apiPort,
      waitTimeoutMs: 30_000,
      logLevel: this.logLevel,
    });

    let tunnelService: TunnelService | null = null;
    let cleanedUp = false;

    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (tunnelService) {
        await tunnelService.disconnect();
        tunnelService = null;
      }
      sshForward.stop();
    };

    try {
      const forwardReady = await ensureSshForwardHealthy(sshForward, localPort, this.logger);
      if (!forwardReady) {
        this.logger.warn('SSH port forward failed — using direct VM URL (may be unreachable locally)');
        sshForward.stop();
        return {
          endpointUrl: directUrl,
          directUrl,
          tunneled: false,
          cleanup: noopCleanup,
        };
      }

      if (!this.tunnel.enabled) {
        this.logger.info('Tunnel disabled — using SSH local forward for smoke tests', { localUrl });
        return {
          endpointUrl: localUrl,
          directUrl,
          tunneled: false,
          localPort,
          sshForward,
          cleanup,
        };
      }

      // cloudflared quick tunnels need no auth token; only ngrok requires one.
      if (this.tunnel.provider === 'ngrok' && !this.tunnel.ngrokAuthToken) {
        this.logger.warn(
          'Ngrok tunnel enabled but NGROK_AUTH_TOKEN missing — local smoke via SSH forward only',
        );
        return {
          endpointUrl: localUrl,
          directUrl,
          tunneled: false,
          localPort,
          sshForward,
          cleanup,
        };
      }

      tunnelService = new TunnelService({
        config: this.tunnel,
        logLevel: this.logLevel,
      });

      if (!(await ensureSshForwardHealthy(sshForward, localPort, this.logger))) {
        this.logger.warn('SSH forward unhealthy before ngrok — local smoke only');
        return {
          endpointUrl: localUrl,
          directUrl,
          tunneled: false,
          localPort,
          sshForward,
          cleanup,
        };
      }

      const tunnelResult = await tunnelService.connect();
      if (!tunnelResult.success || !tunnelResult.tunnel) {
        this.logger.warn('Ngrok tunnel failed — local smoke via SSH forward only', {
          error: tunnelResult.error,
        });
        return {
          endpointUrl: localUrl,
          directUrl,
          tunneled: false,
          localPort,
          sshForward,
          cleanup,
        };
      }

      const publicUrl = tunnelResult.tunnel.publicUrl.replace(/\/+$/, '');
      this.logger.info('Public vLLM endpoint ready', {
        publicUrl,
        directUrl,
        localPort,
        reused: tunnelResult.reused,
      });

      // Smoke tests run in-process and must hit the reliable local SSH forward
      // (just health-checked above), NOT the public tunnel URL. A cloudflared
      // quick tunnel's edge can take several seconds to route after the CLI
      // reports "established", so probing the public URL immediately yields
      // false-negative 404s that abort Stage 2 before Buildkite is ever
      // triggered. Buildkite gets `publicEndpointUrl`; the CI eval infra guard
      // monitors and reconnects the tunnel during polling.
      return {
        endpointUrl: localUrl,
        publicEndpointUrl: publicUrl,
        directUrl,
        tunneled: true,
        localPort,
        sshForward,
        tunnelService,
        cleanup,
      };
    } catch (err) {
      this.logger.warn('Public endpoint setup failed — using direct VM URL', {
        error: err instanceof Error ? err.message : String(err),
      });
      await cleanup();
      return {
        endpointUrl: directUrl,
        directUrl,
        tunneled: false,
        cleanup: noopCleanup,
      };
    }
  }
}
