import { createLogger } from '../utils/logger.js';
import type { TunnelConfig, TunnelProvider } from '../types/config.js';

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

// ─── Ngrok Module Interface ───────────────────────────────────────────────────

/**
 * Minimal type definition for the ngrok npm package.
 * Defined inline to avoid requiring ngrok as a compile-time dependency.
 * ngrok is an optional peer dependency loaded lazily at runtime.
 */
interface NgrokModule {
  connect(opts: { addr: number; region?: string; hostname?: string }): Promise<string>;
  disconnect(): Promise<void>;
  kill(): Promise<void>;
  getUrl(): string | undefined;
  authtoken(token: string): Promise<void>;
}

// ─── Ngrok Provider ───────────────────────────────────────────────────────────

/**
 * Ngrok tunnel provider implementation.
 *
 * Uses the ngrok npm package to create and manage tunnels.
 * Supports checking for existing tunnels, creating new ones,
 * and graceful disconnection.
 *
 * ngrok is loaded lazily at runtime to allow the service to be
 * instantiated even when ngrok is not installed.
 */
class NgrokProvider implements TunnelProvider_Impl {
  private readonly logger;
  private readonly authToken: string | undefined;
  private readonly region: string;
  private readonly domain: string | undefined;
  private ngrok: NgrokModule | null = null;

  constructor(
    config: TunnelConfig,
    logLevel: string,
  ) {
    this.logger = createLogger(logLevel);
    this.authToken = config.ngrokAuthToken;
    this.region = config.ngrokRegion;
    this.domain = config.ngrokDomain;
  }

  /**
   * Lazily loads the ngrok module.
   * This allows the service to be instantiated even if ngrok is not installed,
   * deferring the error to when tunnel operations are actually attempted.
   */
  private async loadNgrok(): Promise<NgrokModule> {
    if (this.ngrok) {
      return this.ngrok;
    }

    try {
      // Dynamic import of optional peer dependency.
      // Use a variable to prevent TypeScript from resolving the module at compile time.
      const ngrokModuleName = 'ngrok';
      const mod = (await import(ngrokModuleName)) as unknown;
      this.ngrok = mod as NgrokModule;
      return this.ngrok;
    } catch {
      throw new TunnelProviderNotAvailableError(
        'ngrok',
        'ngrok package is not installed. Run: npm install ngrok',
      );
    }
  }

  async checkExisting(localPort: number): Promise<TunnelInfo | null> {
    try {
      const ngrok = await this.loadNgrok();
      const url = ngrok.getUrl();

      if (url) {
        this.logger.info('Found existing ngrok tunnel', { url, localPort });
        return {
          publicUrl: url,
          provider: 'ngrok',
          localPort,
          establishedAt: new Date().toISOString(),
          tunnelId: null,
          region: this.region,
        };
      }
    } catch (error) {
      this.logger.debug('No existing ngrok tunnel found', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  async create(localPort: number): Promise<TunnelInfo> {
    const ngrok = await this.loadNgrok();

    // Set auth token if provided
    if (this.authToken) {
      await ngrok.authtoken(this.authToken);
    }

    const connectOptions: {
      addr: number;
      region?: string;
      hostname?: string;
    } = {
      addr: localPort,
      region: this.region,
    };

    if (this.domain) {
      connectOptions.hostname = this.domain;
    }

    this.logger.info('Creating ngrok tunnel', {
      localPort,
      region: this.region,
      domain: this.domain ?? 'auto-generated',
    });

    const url = await ngrok.connect(connectOptions);

    this.logger.info('Ngrok tunnel established', { url, localPort });

    return {
      publicUrl: url,
      provider: 'ngrok',
      localPort,
      establishedAt: new Date().toISOString(),
      tunnelId: null,
      region: this.region,
    };
  }

  async disconnect(): Promise<void> {
    try {
      const ngrok = await this.loadNgrok();
      await ngrok.disconnect();
      await ngrok.kill();
      this.logger.info('Ngrok tunnel disconnected');
    } catch (error) {
      this.logger.warn('Error disconnecting ngrok tunnel', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
