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
  /** Release SSH forward + ngrok; safe to call multiple times */
  cleanup: () => Promise<void>;
}

const DEFAULT_API_PORT = 8000;

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
      sshForward.start();
      const forwardReady = await sshForward.waitUntilReady();
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
          cleanup,
        };
      }

      if (!this.tunnel.ngrokAuthToken) {
        this.logger.warn(
          'Tunnel enabled but NGROK_AUTH_TOKEN missing — local smoke via SSH forward only',
        );
        return {
          endpointUrl: localUrl,
          directUrl,
          tunneled: false,
          cleanup,
        };
      }

      tunnelService = new TunnelService({
        config: this.tunnel,
        logLevel: this.logLevel,
      });

      const tunnelResult = await tunnelService.connect();
      if (!tunnelResult.success || !tunnelResult.tunnel) {
        this.logger.warn('Ngrok tunnel failed — local smoke via SSH forward only', {
          error: tunnelResult.error,
        });
        return {
          endpointUrl: localUrl,
          directUrl,
          tunneled: false,
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

      return {
        endpointUrl: publicUrl,
        publicEndpointUrl: publicUrl,
        directUrl,
        tunneled: true,
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
