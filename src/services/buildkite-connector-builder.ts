/**
 * Builds the base64-encoded KIBANA_TESTING_AI_CONNECTORS JSON string
 * used by Kibana's eval CI pipeline to configure AI connectors.
 *
 * Produces a `.gen-ai` connector map keyed by connector id (object, not array)
 * suitable for OpenAI-compatible endpoints like vLLM.
 */

export interface ConnectorBuilderOptions {
  endpointUrl: string;
  modelId: string;
  connectorName?: string;
  connectorId?: string;
  apiKey?: string;
  /** Optional max output tokens for the connector (helps avoid context blow-ups on small models). */
  maxTokens?: number;
}

export interface ConnectorBuildResult {
  connectorId: string;
  connectorJson: string;
}

interface GenAIConnector {
  name: string;
  actionTypeId: string;
  config: {
    apiUrl: string;
    apiProvider: string;
    defaultModel: string;
    maxTokens?: number;
  };
  secrets: {
    apiKey: string;
  };
}

export function buildConnectorId(modelId: string, prefix = 'vllm-'): string {
  return `${prefix}${modelId.replace(/\//g, '-').toLowerCase()}`;
}

export function buildConnectorPayload(options: ConnectorBuilderOptions): ConnectorBuildResult {
  const {
    endpointUrl,
    modelId,
    connectorName,
    connectorId,
    apiKey = 'not-needed',
    maxTokens,
  } = options;

  const id = connectorId ?? buildConnectorId(modelId);
  const apiUrl = `${endpointUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const name = connectorName ?? id;

  const connectorConfig: GenAIConnector['config'] = {
    apiUrl,
    apiProvider: 'Other',
    defaultModel: modelId,
  };
  if (maxTokens !== undefined) {
    connectorConfig.maxTokens = maxTokens;
  }

  const connector: GenAIConnector = {
    name,
    actionTypeId: '.gen-ai',
    config: connectorConfig,
    secrets: {
      apiKey,
    },
  };

  const payload: Record<string, GenAIConnector> = { [id]: connector };
  const connectorJson = Buffer.from(JSON.stringify(payload)).toString('base64');

  return { connectorId: id, connectorJson };
}

/** @deprecated Prefer {@link buildConnectorPayload} for connector id + JSON. */
export function buildConnectorJson(options: ConnectorBuilderOptions): string {
  return buildConnectorPayload(options).connectorJson;
}
