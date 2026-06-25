import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import type { TunnelConfig, TunnelProvider } from '../types/config.js';

const NGROK_LOCAL_API = 'http://127.0.0.1:4040';
const execFileAsync = promisify(execFile);

/** Kill zombie `ngrok http <port>` processes left by a prior daemon (API on :4040 may be dead). */
async function killOrphanNgrokForPort(localPort: number): Promise<void> {
  const pattern = `ngrok http ${localPort}`;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    const pids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(
      pids.map(async (pid) => {
        try {
          await execFileAsync('kill', ['-TERM', pid]);
        } catch {
          // already exited
        }
      }),
    );
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // pgrep exit 1 = no matches
  }
}

interface NgrokApiTunnel {
  name?: string;
  public_url?: string;
  config?: { addr?: string };
}

/** Fetch active tunnels from a running ngrok agent's local API. */
async function listNgrokApiTunnels(): Promise<NgrokApiTunnel[]> {
  try {
    const res = await fetch(`${NGROK_LOCAL_API}/api/tunnels`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { tunnels?: NgrokApiTunnel[] };
    return body.tunnels ?? [];
  } catch {
    return [];
  }
}

function tunnelMatchesLocalPort(tunnel: NgrokApiTunnel, localPort: number): boolean {
  const addr = tunnel.config?.addr ?? '';
  const portStr = String(localPort);
  return (
    addr === portStr ||
    addr === `http://localhost:${portStr}` ||
    addr === `http://127.0.0.1:${portStr}` ||
    addr === `https://localhost:${portStr}`
  );
}

function pickPublicTunnelUrl(tunnel: NgrokApiTunnel): string | null {
  const url = tunnel.public_url;
  if (url && isPublicTunnelUrl(url)) {
    return url;
  }
  return null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Information about an established tunnel */
export interface TunnelInfo {
  /** The public URL of the tunnel */
  publicUrl: string;
  /** The tunnel provider used */
  provider: TunnelProvider;
  /** The local port being tunneled */
  localPort: number;
  /** Timestamp when the tunnel was established */
  establishedAt: string;
  /** Optional tunnel/session ID from the provider */
  tunnelId: string | null;
  /** Optional ngrok region */
  region: string | null;
}

/** Result of a tunnel operation */
export interface TunnelResult {
  /** Whether the tunnel was successfully established */
  success: boolean;
  /** Tunnel information, if successful */
  tunnel: TunnelInfo | null;
  /** Error message, if unsuccessful */
  error: string | null;
  /** Whether an existing tunnel was reused */
  reused: boolean;
}

/** Options for the TunnelService constructor */
export interface TunnelServiceOptions {
  /** Tunnel configuration from app config */
  config: TunnelConfig;
  /** Winston log level (default: 'info') */
  logLevel?: string;
}

/** Status of the tunnel service */
export interface TunnelStatus {
  /** Whether the tunnel service is enabled */
  enabled: boolean;
  /** Whether a tunnel is currently active */
  active: boolean;
  /** Current tunnel information, if active */
  tunnel: TunnelInfo | null;
  /** The configured provider */
  provider: TunnelProvider;
}

/** Interface for provider-specific tunnel implementations */
interface TunnelProvider_Impl {
  /** Check for an existing tunnel and return its URL if found */
  checkExisting(localPort: number): Promise<TunnelInfo | null>;
  /** Create a new tunnel */
  create(localPort: number): Promise<TunnelInfo>;
  /** Disconnect/close the tunnel */
  disconnect(): Promise<void>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error for tunnel operations */
export class TunnelError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

/** Error thrown when tunnel creation fails */
export class TunnelCreationError extends TunnelError {
  constructor(
    provider: string,
    public readonly attempts: number,
    cause?: Error,
  ) {
    super(
      `Failed to create ${provider} tunnel after ${attempts} attempt(s): ${cause?.message ?? 'unknown error'}`,
      provider,
      cause,
    );
    this.name = 'TunnelCreationError';
  }
}

/** Error thrown when tunnel provider is not available */
export class TunnelProviderNotAvailableError extends TunnelError {
  constructor(provider: string, reason: string) {
    super(`Tunnel provider '${provider}' is not available: ${reason}`, provider);
    this.name = 'TunnelProviderNotAvailableError';
  }
}

// ─── Ngrok helpers ────────────────────────────────────────────────────────────

/**
 * True when `url` is a routable public tunnel endpoint (not ngrok's local inspector on :4040).
 */
export function isPublicTunnelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      return false;
    }
    return host.includes('ngrok') || host.endsWith('.dev') || host.endsWith('.app');
  } catch {
    return false;
  }
}

// ─── Ngrok Provider ───────────────────────────────────────────────────────────

/**
 * Ngrok tunnel provider implementation.
 *
 * Uses the ngrok **CLI** (`ngrok http <port>`) and the local agent API on :4040.
 * The npm `ngrok` package's `connect()` fails when the target port is already
 * bound (e.g. by our SSH port-forward to the GPU VM), so the CLI path is required.
 */
class NgrokProvider implements TunnelProvider_Impl {
  private readonly logger;
  private readonly authToken: string | undefined;
  private readonly region: string;
  private readonly domain: string | undefined;
  private cliProcess: ChildProcess | null = null;

  constructor(
    config: TunnelConfig,
    logLevel: string,
  ) {
    this.logger = createLogger(logLevel);
    this.authToken = config.ngrokAuthToken;
    this.region = config.ngrokRegion;
    this.domain = config.ngrokDomain;
  }

  private async findApiTunnel(localPort: number): Promise<TunnelInfo | null> {
    const tunnels = await listNgrokApiTunnels();
    for (const tunnel of tunnels) {
      if (!tunnelMatchesLocalPort(tunnel, localPort)) {
        continue;
      }
      const publicUrl = pickPublicTunnelUrl(tunnel);
      if (!publicUrl) {
        continue;
      }
      return {
        publicUrl,
        provider: 'ngrok',
        localPort,
        establishedAt: new Date().toISOString(),
        tunnelId: tunnel.name ?? null,
        region: this.region,
      };
    }
    return null;
  }

  async checkExisting(localPort: number): Promise<TunnelInfo | null> {
    const existing = await this.findApiTunnel(localPort);
    if (existing) {
      this.logger.info('Found existing ngrok tunnel via local API', {
        url: existing.publicUrl,
        localPort,
      });
    }
    return existing;
  }

  async create(localPort: number): Promise<TunnelInfo> {
    const reused = await this.findApiTunnel(localPort);
    if (reused) {
      return reused;
    }

    await this.disconnect();
    await killOrphanNgrokForPort(localPort);

    const apiDeadline = Date.now() + 15_000;
    while (Date.now() < apiDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${localPort}/v1/models`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) {
          break;
        }
      } catch {
        // wait for SSH forward / vLLM to become reachable
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const bin = process.env['NGROK_BIN'] ?? 'ngrok';
    const args = ['http', String(localPort), '--log=stdout', '--log-level=warn'];
    if (this.domain) {
      args.push('--domain', this.domain);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.authToken) {
      env['NGROK_AUTHTOKEN'] = this.authToken;
    }

    this.logger.info('Starting ngrok CLI tunnel', {
      localPort,
      region: this.region,
      domain: this.domain ?? 'auto-generated',
      bin,
    });

    this.cliProcess = spawn(bin, args, {
      env,
      stdio: 'ignore',
      detached: false,
    });

    const deadlineMs = 45_000;
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const tunnel = await this.findApiTunnel(localPort);
      if (tunnel) {
        this.logger.info('Ngrok tunnel established via CLI', {
          url: tunnel.publicUrl,
          localPort,
        });
        return tunnel;
      }
      if (this.cliProcess.exitCode !== null) {
        break;
      }
    }

    await this.disconnect();
    throw new Error(`ngrok CLI failed to expose port ${localPort} within ${deadlineMs}ms`);
  }

  async disconnect(): Promise<void> {
    if (this.cliProcess && this.cliProcess.exitCode === null) {
      this.cliProcess.kill('SIGTERM');
    }
    this.cliProcess = null;

    const tunnels = await listNgrokApiTunnels();
    await Promise.all(
      tunnels.map(async (tunnel) => {
        if (!tunnel.name) {
          return;
        }
        try {
          await fetch(`${NGROK_LOCAL_API}/api/tunnels/${tunnel.name}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(2_000),
          });
        } catch {
          // best-effort cleanup
        }
      }),
    );

    this.logger.info('Ngrok tunnel disconnected');
  }
}

// ─── Placeholder Providers ────────────────────────────────────────────────────

/**
 * Placeholder for future GCP Cloud Run tunnel provider.
 * Will support native GCP Cloud Run deployments for production use.
 */
class CloudRunProvider implements TunnelProvider_Impl {
  async checkExisting(_localPort: number): Promise<TunnelInfo | null> {
    throw new TunnelProviderNotAvailableError(
      'cloudrun',
      'GCP Cloud Run provider is not yet implemented. Use ngrok for now.',
    );
  }

  async create(_localPort: number): Promise<TunnelInfo> {
    throw new TunnelProviderNotAvailableError(
      'cloudrun',
      'GCP Cloud Run provider is not yet implemented. Use ngrok for now.',
    );
  }

  async disconnect(): Promise<void> {
    // No-op for unimplemented provider
  }
}

/**
 * Placeholder for future GCP Load Balancer tunnel provider.
 * Will support native GCP Load Balancer integration for production use.
 */
class LoadBalancerProvider implements TunnelProvider_Impl {
  async checkExisting(_localPort: number): Promise<TunnelInfo | null> {
    throw new TunnelProviderNotAvailableError(
      'load_balancer',
      'GCP Load Balancer provider is not yet implemented. Use ngrok for now.',
    );
  }

  async create(_localPort: number): Promise<TunnelInfo> {
    throw new TunnelProviderNotAvailableError(
      'load_balancer',
      'GCP Load Balancer provider is not yet implemented. Use ngrok for now.',
    );
  }

  async disconnect(): Promise<void> {
    // No-op for unimplemented provider
  }
}

// ─── Tunnel Service ───────────────────────────────────────────────────────────

/**
 * Service for managing tunnel connections to expose the vLLM API publicly.
 *
 * Supports multiple tunnel providers with ngrok as the primary implementation.
 * Handles the complete tunnel lifecycle:
 * 1. Check for an existing tunnel to reuse
 * 2. Create a new tunnel if none exists
 * 3. Retry on failure with configurable attempts
 * 4. Graceful disconnection and cleanup
 *
 * The public URL is stored in the benchmark results for use by
 * Kibana connector creation and other downstream consumers.
 *
 * @example
 * ```typescript
 * const tunnelService = new TunnelService({
 *   config: appConfig.tunnel,
 *   logLevel: 'info',
 * });
 *
 * const result = await tunnelService.connect();
 * if (result.success) {
 *   console.log(`Public URL: ${result.tunnel.publicUrl}`);
 * }
 *
 * await tunnelService.disconnect();
 * ```
 */
export class TunnelService {
  private readonly logger;
  private readonly config: TunnelConfig;
  private readonly provider: TunnelProvider_Impl;
  private currentTunnel: TunnelInfo | null = null;

  constructor(options: TunnelServiceOptions) {
    this.config = options.config;
    const logLevel = options.logLevel ?? 'info';
    this.logger = createLogger(logLevel);
    this.provider = this.createProvider(logLevel);

    this.logger.info('TunnelService initialized', {
      enabled: this.config.enabled,
      provider: this.config.provider,
      localPort: this.config.localPort,
    });
  }

  /**
   * Creates the appropriate tunnel provider based on configuration.
   */
  private createProvider(logLevel: string): TunnelProvider_Impl {
    switch (this.config.provider) {
      case 'ngrok':
        return new NgrokProvider(this.config, logLevel);
      case 'cloudrun':
        return new CloudRunProvider();
      case 'load_balancer':
        return new LoadBalancerProvider();
      default:
        throw new TunnelError(
          `Unknown tunnel provider: ${this.config.provider as string}`,
          this.config.provider as string,
        );
    }
  }

  /**
   * Whether the tunnel service is enabled in configuration.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * The currently active tunnel, if any.
   */
  get activeTunnel(): TunnelInfo | null {
    return this.currentTunnel;
  }

  /**
   * Returns the current status of the tunnel service.
   */
  getStatus(): TunnelStatus {
    return {
      enabled: this.config.enabled,
      active: this.currentTunnel !== null,
      tunnel: this.currentTunnel,
      provider: this.config.provider,
    };
  }

  /**
   * Establishes a tunnel connection to the local vLLM API.
   *
   * First checks for an existing tunnel that can be reused.
   * If none exists, creates a new tunnel with retry logic.
   *
   * @returns TunnelResult with the public URL on success
   */
  async connect(): Promise<TunnelResult> {
    if (!this.config.enabled) {
      this.logger.info('Tunnel service is disabled, skipping connection');
      return {
        success: false,
        tunnel: null,
        error: 'Tunnel service is disabled',
        reused: false,
      };
    }

    const localPort = this.config.localPort;

    // Step 1: Check for existing tunnel
    try {
      const existing = await this.provider.checkExisting(localPort);
      if (existing) {
        this.currentTunnel = existing;
        this.logger.info('Reusing existing tunnel', {
          publicUrl: existing.publicUrl,
          provider: existing.provider,
        });
        return {
          success: true,
          tunnel: existing,
          error: null,
          reused: true,
        };
      }
    } catch (error) {
      this.logger.debug('Could not check for existing tunnel', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 2: Create new tunnel with retries
    const maxAttempts = this.config.retryAttempts + 1; // +1 for the initial attempt
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.info(`Creating tunnel (attempt ${attempt}/${maxAttempts})`, {
          provider: this.config.provider,
          localPort,
        });

        const tunnel = await this.createWithTimeout(localPort);
        this.currentTunnel = tunnel;

        this.logger.info('Tunnel established successfully', {
          publicUrl: tunnel.publicUrl,
          provider: tunnel.provider,
          attempt,
        });

        return {
          success: true,
          tunnel,
          error: null,
          reused: false,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Tunnel creation failed (attempt ${attempt}/${maxAttempts}): ${lastError.message}`,
        );

        if (attempt < maxAttempts) {
          await this.provider.disconnect().catch(() => {});
          this.logger.info(`Retrying in ${this.config.retryDelayMs}ms...`);
          await this.delay(this.config.retryDelayMs);
        }
      }
    }

    const creationError = new TunnelCreationError(
      this.config.provider,
      maxAttempts,
      lastError ?? undefined,
    );

    this.logger.error('Failed to establish tunnel after all attempts', {
      provider: this.config.provider,
      attempts: maxAttempts,
      error: creationError.message,
    });

    return {
      success: false,
      tunnel: null,
      error: creationError.message,
      reused: false,
    };
  }

  /**
   * Tear down and re-establish the public tunnel (used when ngrok dies mid-poll).
   */
  async reconnect(): Promise<TunnelResult> {
    this.logger.info('Reconnecting tunnel', {
      provider: this.config.provider,
      localPort: this.config.localPort,
    });
    await this.provider.disconnect();
    this.currentTunnel = null;
    await killOrphanNgrokForPort(this.config.localPort);
    return this.connect();
  }

  /**
   * Disconnects the current tunnel and cleans up resources.
   */
  async disconnect(): Promise<void> {
    if (!this.currentTunnel) {
      this.logger.debug('No active tunnel to disconnect');
      return;
    }

    this.logger.info('Disconnecting tunnel', {
      publicUrl: this.currentTunnel.publicUrl,
      provider: this.currentTunnel.provider,
    });

    await this.provider.disconnect();
    this.currentTunnel = null;

    this.logger.info('Tunnel disconnected successfully');
  }

  /**
   * Creates a tunnel with a timeout wrapper.
   */
  private async createWithTimeout(localPort: number): Promise<TunnelInfo> {
    const timeoutMs = this.config.timeoutMs;

    return new Promise<TunnelInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new TunnelError(
            `Tunnel creation timed out after ${timeoutMs}ms`,
            this.config.provider,
          ),
        );
      }, timeoutMs);

      this.provider
        .create(localPort)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Helper to delay execution.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
