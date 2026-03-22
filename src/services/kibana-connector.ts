import { createLogger } from '../utils/logger.js';
import type { KibanaConnectorConfig } from '../types/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Information about a Kibana connector */
export interface KibanaConnectorInfo {
  /** The Kibana connector ID */
  id: string;
  /** The connector name */
  name: string;
  /** The connector type (e.g., '.gen-ai') */
  connectorTypeId: string;
  /** Whether the connector was newly created or already existed */
  isNewlyCreated: boolean;
  /** The API URL configured on the connector */
  apiUrl: string;
  /** The model ID configured on the connector */
  defaultModel: string;
}

/** Result of a connector creation operation */
export interface KibanaConnectorResult {
  /** Whether the operation was successful */
  success: boolean;
  /** Connector information, if successful */
  connector: KibanaConnectorInfo | null;
  /** Error message, if unsuccessful */
  error: string | null;
}

/** Options for creating a Kibana connector */
export interface CreateConnectorOptions {
  /** The public API URL for the vLLM endpoint (typically a tunnel URL) */
  apiUrl: string;
  /** The HuggingFace model ID (e.g., 'meta-llama/Llama-3-70B') */
  modelId: string;
  /** Optional custom connector name. Defaults to prefix + sanitized model ID */
  connectorName?: string;
}

/** Options for the KibanaConnectorService constructor */
export interface KibanaConnectorServiceOptions {
  /** Kibana connector configuration from app config */
  config: KibanaConnectorConfig;
  /** Winston log level (default: 'info') */
  logLevel?: string;
}

/** Status of the Kibana connector service */
export interface KibanaConnectorStatus {
  /** Whether the connector service is enabled */
  enabled: boolean;
  /** The Kibana URL target */
  kibanaUrl: string | null;
  /** The last created connector info, if any */
  lastConnector: KibanaConnectorInfo | null;
}

/** Response shape from the Kibana Create Connector API */
interface KibanaCreateConnectorResponse {
  id: string;
  [key: string]: unknown;
}

/** Response shape from the Kibana Find Connectors API */
interface KibanaFindConnectorsResponse {
  data?: Array<{
    id: string;
    name: string;
    connector_type_id: string;
    config?: {
      apiUrl?: string;
      defaultModel?: string;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error for Kibana connector operations */
export class KibanaConnectorError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'KibanaConnectorError';
  }
}

/** Error thrown when Kibana connector creation fails */
export class KibanaConnectorCreationError extends KibanaConnectorError {
  constructor(
    public readonly connectorName: string,
    statusCode?: number,
    cause?: Error,
  ) {
    super(
      `Failed to create Kibana connector '${connectorName}': ${cause?.message ?? 'unknown error'}`,
      statusCode,
      cause,
    );
    this.name = 'KibanaConnectorCreationError';
  }
}

/** Error thrown when Kibana connector service is misconfigured */
export class KibanaConnectorConfigError extends KibanaConnectorError {
  constructor(reason: string) {
    super(`Kibana connector misconfigured: ${reason}`);
    this.name = 'KibanaConnectorConfigError';
  }
}

// ─── Kibana Connector Service ────────────────────────────────────────────────

/**
 * Service for creating and managing Kibana Connectors pointing to the vLLM API.
 *
 * Creates OpenAI-compatible connectors in Kibana that point to the exposed
 * vLLM endpoint (typically via a tunnel URL). This enables the Agent builder
 * LLM features evaluation workflow.
 *
 * The connector is created using the Kibana Actions API:
 * - POST /api/actions/connector - Create a new connector
 * - GET /api/actions/connectors - List existing connectors
 *
 * @example
 * ```typescript
 * const service = new KibanaConnectorService({
 *   config: appConfig.kibanaConnector,
 *   logLevel: 'info',
 * });
 *
 * const result = await service.createConnector({
 *   apiUrl: 'https://abc123.ngrok-free.app/v1',
 *   modelId: 'meta-llama/Llama-3-70B',
 * });
 *
 * if (result.success) {
 *   console.log(`Connector created: ${result.connector.id}`);
 * }
 * ```
 */
export class KibanaConnectorService {
  private readonly logger;
  private readonly config: KibanaConnectorConfig;
  private lastConnector: KibanaConnectorInfo | null = null;

  constructor(options: KibanaConnectorServiceOptions) {
    this.config = options.config;
    const logLevel = options.logLevel ?? 'info';
    this.logger = createLogger(logLevel);

    this.logger.info('KibanaConnectorService initialized', {
      enabled: this.config.enabled,
      kibanaUrl: this.config.url ?? 'not configured',
      connectorNamePrefix: this.config.connectorNamePrefix,
    });
  }

  /**
   * Whether the Kibana connector service is enabled in configuration.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Returns the current status of the Kibana connector service.
   */
  getStatus(): KibanaConnectorStatus {
    return {
      enabled: this.config.enabled,
      kibanaUrl: this.config.url ?? null,
      lastConnector: this.lastConnector,
    };
  }

  /**
   * Creates or finds an existing Kibana connector for the given model.
   *
   * First checks for an existing connector with the same name.
   * If none exists, creates a new OpenAI-compatible connector
   * configured with the vLLM endpoint URL and model ID.
   *
   * @param options - Connector creation options
   * @returns KibanaConnectorResult with connector info on success
   */
  async createConnector(options: CreateConnectorOptions): Promise<KibanaConnectorResult> {
    if (!this.config.enabled) {
      this.logger.info('Kibana connector service is disabled, skipping connector creation');
      return {
        success: false,
        connector: null,
        error: 'Kibana connector service is disabled',
      };
    }

    // Validate required configuration
    if (!this.config.url) {
      return {
        success: false,
        connector: null,
        error: 'Kibana URL is not configured (set KIBANA_CONNECTOR_URL)',
      };
    }

    if (!this.config.apiKey) {
      return {
        success: false,
        connector: null,
        error: 'Kibana API key is not configured (set KIBANA_CONNECTOR_API_KEY)',
      };
    }

    const connectorName =
      options.connectorName ?? this.buildConnectorName(options.modelId);

    this.logger.info('Creating Kibana connector', {
      connectorName,
      apiUrl: options.apiUrl,
      modelId: options.modelId,
      kibanaUrl: this.config.url,
    });

    try {
      // Step 1: Check for existing connector with the same name
      const existing = await this.findExistingConnector(connectorName);
      if (existing) {
        this.lastConnector = existing;
        this.logger.info('Found existing Kibana connector, reusing', {
          connectorId: existing.id,
          connectorName: existing.name,
        });
        return {
          success: true,
          connector: existing,
          error: null,
        };
      }

      // Step 2: Create new connector
      const connector = await this.createNewConnector(
        connectorName,
        options.apiUrl,
        options.modelId,
      );

      this.lastConnector = connector;

      this.logger.info('Kibana connector created successfully', {
        connectorId: connector.id,
        connectorName: connector.name,
        apiUrl: connector.apiUrl,
        defaultModel: connector.defaultModel,
      });

      return {
        success: true,
        connector,
        error: null,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to create Kibana connector', {
        connectorName,
        error: errorMessage,
      });

      return {
        success: false,
        connector: null,
        error: errorMessage,
      };
    }
  }

  /**
   * Builds the connector name from the prefix and model ID.
   * Sanitizes the model ID to be a valid connector name.
   */
  private buildConnectorName(modelId: string): string {
    // Replace '/' with '-' and remove any characters that aren't alphanumeric, dash, or dot
    const sanitized = modelId
      .replace(/\//g, '-')
      .replace(/[^a-zA-Z0-9\-._]/g, '');
    return `${this.config.connectorNamePrefix}${sanitized}`;
  }

  /**
   * Searches for an existing connector by name.
   *
   * @param connectorName - The connector name to search for
   * @returns The existing connector info, or null if not found
   */
  private async findExistingConnector(
    connectorName: string,
  ): Promise<KibanaConnectorInfo | null> {
    const url = `${this.config.url}/api/actions/connectors`;

    this.logger.debug('Searching for existing Kibana connectors', { url });

    try {
      const response = await this.kibanaFetch<KibanaFindConnectorsResponse>(url, {
        method: 'GET',
      });

      // The connectors list endpoint returns an array directly
      const connectors = Array.isArray(response) ? response : (response.data ?? []);

      for (const connector of connectors) {
        if (connector.name === connectorName) {
          return {
            id: connector.id,
            name: connector.name,
            connectorTypeId: connector.connector_type_id,
            isNewlyCreated: false,
            apiUrl: connector.config?.apiUrl ?? '',
            defaultModel: connector.config?.defaultModel ?? '',
          };
        }
      }

      return null;
    } catch (error) {
      this.logger.debug('Could not search existing connectors', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-fatal: if we can't search, we'll just try to create
      return null;
    }
  }

  /**
   * Creates a new OpenAI-compatible connector in Kibana.
   *
   * Uses the Kibana Actions API to create a '.gen-ai' connector type
   * configured for the OpenAI API provider, pointing to the vLLM endpoint.
   *
   * @param connectorName - Name for the connector
   * @param apiUrl - The vLLM API endpoint URL
   * @param modelId - The model ID to configure as default
   * @returns The created connector info
   */
  private async createNewConnector(
    connectorName: string,
    apiUrl: string,
    modelId: string,
  ): Promise<KibanaConnectorInfo> {
    const url = `${this.config.url}/api/actions/connector`;

    // Ensure the API URL ends with /v1 for OpenAI compatibility
    const normalizedApiUrl = apiUrl.endsWith('/v1') ? apiUrl : `${apiUrl}/v1`;

    const body = {
      connector_type_id: '.gen-ai',
      name: connectorName,
      config: {
        apiProvider: 'Other',
        apiUrl: `${normalizedApiUrl}/chat/completions`,
        defaultModel: modelId,
      },
      secrets: {
        // vLLM does not require an API key by default,
        // but Kibana requires a non-empty value for the secrets field
        apiKey: 'vllm-no-key-required',
      },
    };

    this.logger.debug('Creating Kibana connector via API', {
      url,
      connectorName,
      apiUrl: normalizedApiUrl,
      modelId,
    });

    const response = await this.kibanaFetch<KibanaCreateConnectorResponse>(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.id) {
      throw new KibanaConnectorCreationError(
        connectorName,
        undefined,
        new Error('Kibana API did not return a connector ID'),
      );
    }

    return {
      id: response.id,
      name: connectorName,
      connectorTypeId: '.gen-ai',
      isNewlyCreated: true,
      apiUrl: normalizedApiUrl,
      defaultModel: modelId,
    };
  }

  /**
   * Makes an authenticated HTTP request to the Kibana API.
   *
   * @param url - The full Kibana API URL
   * @param options - Fetch options (method, body, etc.)
   * @returns The parsed JSON response
   */
  private async kibanaFetch<T>(
    url: string,
    options: { method: string; body?: string },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          'kbn-xsrf': 'true',
          Authorization: `ApiKey ${this.config.apiKey}`,
        },
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        throw new KibanaConnectorError(
          `Kibana API request failed: ${response.status} ${response.statusText} - ${errorBody}`,
          response.status,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof KibanaConnectorError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new KibanaConnectorError(
          `Kibana API request timed out after ${this.config.requestTimeoutMs}ms`,
        );
      }

      throw new KibanaConnectorError(
        `Kibana API request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error instanceof Error ? error : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
