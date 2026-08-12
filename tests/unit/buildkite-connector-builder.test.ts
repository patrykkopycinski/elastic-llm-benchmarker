import { describe, it, expect } from 'vitest';
import {
  buildConnectorId,
  buildConnectorPayload,
  buildChatCompletionsUrl,
} from '../../src/services/buildkite-connector-builder.js';

describe('buildChatCompletionsUrl', () => {
  it('appends the suffix for a bare endpoint', () => {
    expect(buildChatCompletionsUrl('http://127.0.0.1:18000')).toBe(
      'http://127.0.0.1:18000/v1/chat/completions',
    );
  });

  it('does NOT double /v1 when the endpoint already carries it', () => {
    // Regression: the doubled path made vLLM answer `{"detail":"Not Found"}`,
    // which Kibana surfaced as `Error calling connector: Status code: 404.
    // Message: API Error: Not Found` — a route 404 masquerading as a model
    // rejection, failing every Stage 2 suite.
    expect(buildChatCompletionsUrl('http://127.0.0.1:18000/v1')).toBe(
      'http://127.0.0.1:18000/v1/chat/completions',
    );
    expect(buildChatCompletionsUrl('http://127.0.0.1:18000/v1/')).toBe(
      'http://127.0.0.1:18000/v1/chat/completions',
    );
  });

  it('is idempotent for an already-complete URL', () => {
    expect(buildChatCompletionsUrl('http://127.0.0.1:18000/v1/chat/completions')).toBe(
      'http://127.0.0.1:18000/v1/chat/completions',
    );
  });
});

describe('buildConnectorPayload', () => {
  it('never emits a doubled /v1 in the connector apiUrl', () => {
    const { connectorId, connectorJson } = buildConnectorPayload({
      endpointUrl: 'http://127.0.0.1:18000/v1',
      modelId: 'bodenmaurice/dendrite-qwen3.6-35b-stages-v2',
    });

    const decoded = JSON.parse(Buffer.from(connectorJson, 'base64').toString('utf8')) as Record<
      string,
      { config: { apiUrl: string } }
    >;

    expect(decoded[connectorId]?.config.apiUrl).toBe('http://127.0.0.1:18000/v1/chat/completions');
    expect(decoded[connectorId]?.config.apiUrl).not.toContain('/v1/v1/');
  });

  it('builds object-keyed base64 connector map for vLLM', () => {
    const { connectorId, connectorJson } = buildConnectorPayload({
      endpointUrl: 'https://example.ngrok.dev/',
      modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
    });

    expect(connectorId).toBe('vllm-qwen-qwen2.5-1.5b-instruct');

    const decoded = JSON.parse(Buffer.from(connectorJson, 'base64').toString('utf8')) as Record<
      string,
      {
        name: string;
        actionTypeId: string;
        config: { apiUrl: string; defaultModel: string };
      }
    >;

    expect(Array.isArray(decoded)).toBe(false);
    expect(Object.keys(decoded)).toEqual([connectorId]);
    expect(decoded[connectorId]?.actionTypeId).toBe('.gen-ai');
    expect(decoded[connectorId]?.config.apiUrl).toBe(
      'https://example.ngrok.dev/v1/chat/completions',
    );
    expect(decoded[connectorId]?.config.defaultModel).toBe('Qwen/Qwen2.5-1.5B-Instruct');
  });

  it('buildConnectorId normalizes slashes and casing', () => {
    expect(buildConnectorId('Org/My-Model')).toBe('vllm-org-my-model');
  });

  it('emits only supported connector config keys (incl. native function calling)', () => {
    const { connectorJson } = buildConnectorPayload({
      endpointUrl: 'https://example.ngrok.dev/',
      modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
    });

    const decoded = JSON.parse(Buffer.from(connectorJson, 'base64').toString('utf8')) as Record<
      string,
      { config: Record<string, unknown> }
    >;
    const id = Object.keys(decoded)[0]!;
    // enableNativeFunctionCalling is a schema-accepted `.gen-ai` config key (kbn-connector-schemas
    // openai/schemas/v1.ts). It forces native tool_calls parsing, matching kbn-evals' own LiteLLM
    // connector generator — required because our vLLM deployments emit native tool_calls.
    expect(decoded[id]?.config).toEqual({
      apiUrl: 'https://example.ngrok.dev/v1/chat/completions',
      apiProvider: 'Other',
      defaultModel: 'Qwen/Qwen2.5-1.5B-Instruct',
      enableNativeFunctionCalling: true,
    });
  });
});
