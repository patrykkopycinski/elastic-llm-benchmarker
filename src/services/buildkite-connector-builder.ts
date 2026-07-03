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
    /**
     * Force Kibana's inference plugin to use the model's NATIVE OpenAI `tool_calls` instead of
     * simulated (inline `<|tool_use_start|>`) function calling. For `apiProvider: 'Other'` Kibana
     * defaults to simulated FC, whose inline parser throws `500 "Missing name for tool use"` on the
     * output our vLLM deployments produce. Our vLLM containers run with `--enable-auto-tool-choice
     * --tool-call-parser <hermes|mistral|llama3_json>`, so they emit native `tool_calls` — native FC
     * is the correct setting, not a workaround.
     */
    enableNativeFunctionCalling: boolean;
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
  } = options;

  const id = connectorId ?? buildConnectorId(modelId);
  const apiUrl = `${endpointUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const name = connectorName ?? id;

  const connector: GenAIConnector = {
    name,
    actionTypeId: '.gen-ai',
    config: {
      apiUrl,
      apiProvider: 'Other',
      defaultModel: modelId,
      enableNativeFunctionCalling: true,
    },
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
