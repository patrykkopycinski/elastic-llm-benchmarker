/**
 * Builds the base64-encoded KIBANA_TESTING_AI_CONNECTORS JSON string
 * used by Kibana's eval CI pipeline to configure AI connectors.
 *
 * Produces a `.gen-ai` connector with `apiProvider: "Other"` suitable
 * for OpenAI-compatible endpoints like vLLM.
 */

export interface ConnectorBuilderOptions {
  endpointUrl: string;
  modelId: string;
  connectorName?: string;
  apiKey?: string;
}

interface GenAIConnector {
  name: string;
  actionTypeId: string;
  config: {
    apiUrl: string;
    apiProvider: string;
    defaultModel: string;
  };
  secrets: {
    apiKey: string;
  };
}

export function buildConnectorJson(options: ConnectorBuilderOptions): string {
  const {
    endpointUrl,
    modelId,
    connectorName,
    apiKey = 'not-needed',
  } = options;

  const apiUrl = `${endpointUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const name = connectorName ?? `vllm-${modelId.replace(/\//g, '-')}`;

  const connector: GenAIConnector = {
    name,
    actionTypeId: '.gen-ai',
    config: {
      apiUrl,
      apiProvider: 'Other',
      defaultModel: modelId,
    },
    secrets: {
      apiKey,
    },
  };

  const jsonStr = JSON.stringify([connector]);
  return Buffer.from(jsonStr).toString('base64');
}
