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

/**
 * Build the OpenAI-compatible chat-completions URL for a vLLM endpoint.
 *
 * Kibana's `.gen-ai` connector stores the FULL endpoint path in `apiUrl` and
 * posts to it verbatim (`streamApi` uses `this.url`), so the suffix must be
 * present exactly once. Blindly appending `/v1/chat/completions` produced
 * `.../v1/v1/chat/completions` whenever the caller passed an endpoint that
 * already carried `/v1` — vLLM answers that route with a bare
 * `{"detail":"Not Found"}` 404, which Kibana surfaces as the maximally
 * unhelpful `Error calling connector: Status code: 404. Message: API Error:
 * Not Found`. That is a ROUTE 404, not a model-not-found 404, and the two are
 * indistinguishable from the Kibana-side message alone.
 *
 * Normalising here (rather than at each call site) keeps the builder
 * idempotent for every endpoint shape the scheduler can hand us.
 */
export function buildChatCompletionsUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.replace(/\/+$/, '');

  if (/\/v1\/chat\/completions$/.test(trimmed)) {
    return trimmed;
  }

  if (/\/v1$/.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }

  return `${trimmed}/v1/chat/completions`;
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
  const apiUrl = buildChatCompletionsUrl(endpointUrl);
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
