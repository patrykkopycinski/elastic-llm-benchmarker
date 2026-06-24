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
  /** URL downstream consumers should call (ngrok when tunneled, else direct VM URL) */
  endpointUrl: string;
  /** Original VM-direct URL before tunneling */
  directUrl: string;
  /** Whether a public ngrok URL was established */
  tunneled: boolean;
  /** Release SSH forward + ngrok; safe to call multiple times */
  cleanup: () => Promise<void>;
}

const DEFAULT_API_PORT = 8000;

/**
 * Exposes the GPU VM vLLM API via SSH local forward + ngrok when tunneling is enabled.
 *
 * Flow: laptop `localhost:localPort` → SSH → VM `localhost:apiPort` → ngrok public URL.
 * Buildkite CI smoke tests and weekly evals use the ngrok URL.
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
   * Resolves the endpoint URL for CI evals, Stage 2, and connector creation.
   * When tunneling is disabled, returns `directUrl` unchanged.
   */
  async resolve(directUrl: string): Promise<PublicEndpointResult> {
    const noopCleanup = async (): Promise<void> => {};

    if (!this.tunnel.enabled) {
      return {
        endpointUrl: directUrl,
        directUrl,
        tunneled: false,
        cleanup: noopCleanup,
      };
    }

    if (!this.tunnel.ngrokAuthToken) {
      this.logger.warn(
        'Tunnel enabled but NGROK_AUTH_TOKEN missing — using direct VM URL (CI evals may fail)',
      );
      return {
        endpointUrl: directUrl,
        directUrl,
        tunneled: false,
        cleanup: noopCleanup,
      };
    }

    const localPort = this.tunnel.localPort;
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
        this.logger.warn('SSH port forward failed — using direct VM URL');
        await cleanup();
        return {
          endpointUrl: directUrl,
          directUrl,
          tunneled: false,
          cleanup: noopCleanup,
        };
      }

      tunnelService = new TunnelService({
        config: this.tunnel,
        logLevel: this.logLevel,
      });

      const tunnelResult = await tunnelService.connect();
      if (!tunnelResult.success || !tunnelResult.tunnel) {
        this.logger.warn('Ngrok tunnel failed — using direct VM URL', {
          error: tunnelResult.error,
        });
        await cleanup();
        return {
          endpointUrl: directUrl,
          directUrl,
          tunneled: false,
          cleanup: noopCleanup,
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
