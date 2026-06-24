import { describe, it, expect } from 'vitest';
import {
  buildConnectorId,
  buildConnectorPayload,
} from '../../src/services/buildkite-connector-builder.js';

describe('buildConnectorPayload', () => {
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

  it('includes maxTokens in connector config when provided', () => {
    const { connectorJson } = buildConnectorPayload({
      endpointUrl: 'https://example.ngrok.dev/',
      modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
      maxTokens: 4096,
    });

    const decoded = JSON.parse(Buffer.from(connectorJson, 'base64').toString('utf8')) as Record<
      string,
      { config: { maxTokens?: number } }
    >;
    const id = Object.keys(decoded)[0]!;
    expect(decoded[id]?.config.maxTokens).toBe(4096);
  });
});
