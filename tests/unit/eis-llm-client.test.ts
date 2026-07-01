import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  EisLlmClient,
  parseEisSsePayload,
  resolveEisInferenceEndpointId,
} from '../../src/services/eis-llm-client.js';
import type { Client } from '@elastic/elasticsearch';
import type { Logger } from 'winston';

function createMockEsClient(): { client: Client; requestMock: ReturnType<typeof vi.fn> } {
  const requestMock = vi.fn();
  const client = {
    transport: { request: requestMock },
  } as unknown as Client;
  return { client, requestMock };
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

const SAMPLE_SSE = [
  'event: message',
  'data: {"choices":[{"delta":{"content":"Hello","role":"assistant"},"index":0}],"model":"anthropic-claude-4.6-opus","object":"chat.completion.chunk"}',
  '',
  'event: message',
  'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":"stop","index":0}],"model":"anthropic-claude-4.6-opus","usage":{"completion_tokens":5,"prompt_tokens":10,"total_tokens":15}}',
  '',
  'event: message',
  'data: [DONE]',
  '',
].join('\n');

describe('resolveEisInferenceEndpointId', () => {
  it('maps eis/ model ids to dot-prefixed chat_completion endpoints', () => {
    expect(resolveEisInferenceEndpointId('eis/anthropic-claude-4.6-opus')).toBe(
      '.anthropic-claude-4.6-opus-chat_completion',
    );
  });

  it('passes through already-resolved endpoint ids', () => {
    expect(resolveEisInferenceEndpointId('.anthropic-claude-4.6-opus-chat_completion')).toBe(
      '.anthropic-claude-4.6-opus-chat_completion',
    );
  });
});

describe('parseEisSsePayload', () => {
  it('aggregates streamed content, finish reason, and usage', () => {
    const result = parseEisSsePayload(SAMPLE_SSE);
    expect(result.content).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.model).toBe('anthropic-claude-4.6-opus');
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('throws on SSE error events', () => {
    const errorSse = 'event: error\ndata: {"error":{"message":"boom","type":"bad"}}\n\n';
    expect(() => parseEisSsePayload(errorSse)).toThrow('boom');
  });
});

describe('EisLlmClient', () => {
  let requestMock: ReturnType<typeof vi.fn>;
  let client: EisLlmClient;
  let logger: Logger;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockEsClient();
    requestMock = mock.requestMock;
    logger = createMockLogger();
    client = new EisLlmClient(
      mock.client,
      'test-eis-key',
      'eis/anthropic-claude-4.6-opus',
      'http://localhost:9223',
      'ApiKey test-es-key',
      logger,
    );

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Self-managed path: no endpoints initially → PUT _ccm → endpoints appear.
  function mockCcmActivation(): void {
    requestMock.mockResolvedValueOnce({ endpoints: [] });
    requestMock.mockResolvedValueOnce({});
    requestMock.mockResolvedValueOnce({
      endpoints: [{ task_type: 'chat_completion', service: 'elastic' }],
    });
  }

  // Serverless/native path: chat_completion endpoints already present.
  function mockEndpointsAlreadyPresent(): void {
    requestMock.mockResolvedValueOnce({
      endpoints: [{ task_type: 'chat_completion', service: 'elastic' }],
    });
  }

  function mockStreamResponse(sseBody: string): void {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseBody));
          controller.close();
        },
      }),
    });
  }

  describe('complete', () => {
    it('should activate CCM and complete via streaming endpoint', async () => {
      mockCcmActivation();
      mockStreamResponse(SAMPLE_SSE);

      const result = await client.complete({ userPrompt: 'Say hello' });

      expect(result.content).toBe('Hello');
      expect(result.finishReason).toBe('stop');
      expect(result.model).toBe('anthropic-claude-4.6-opus');
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      // GET _all (empty) → PUT _ccm → GET _all (present)
      expect(requestMock).toHaveBeenCalledTimes(3);
      const ccmCall = requestMock.mock.calls[1]![0];
      expect(ccmCall.method).toBe('PUT');
      expect(ccmCall.path).toBe('/_inference/_ccm');
      expect(ccmCall.body).toEqual({ api_key: 'test-eis-key' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/_inference/chat_completion/.anthropic-claude-4.6-opus-chat_completion/_stream');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe('ApiKey test-es-key');
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
    });

    it('should include system prompt when provided', async () => {
      mockCcmActivation();
      mockStreamResponse(SAMPLE_SSE);

      await client.complete({
        systemPrompt: 'You are helpful',
        userPrompt: 'Hello',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ]);
    });

    it('should only activate CCM once across multiple calls', async () => {
      mockCcmActivation();
      mockStreamResponse(SAMPLE_SSE);
      mockStreamResponse(SAMPLE_SSE);

      await client.complete({ userPrompt: 'First' });
      await client.complete({ userPrompt: 'Second' });

      // Activation happens on the first call (3 requests); the second is cached.
      expect(requestMock).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should accept JSON wrapped in markdown fences when responseFormat is json', async () => {
      mockCcmActivation();
      mockStreamResponse(
        'event: message\ndata: {"choices":[{"delta":{"content":"```json\\n{\\"suggestions\\":[]}\\n```","role":"assistant"},"finish_reason":"stop"}]}\n\n',
      );

      const result = await client.complete({
        userPrompt: 'Return JSON',
        responseFormat: 'json',
      });

      expect(result.content).toContain('suggestions');
    });

    it('should throw when JSON response format requested but content is invalid', async () => {
      mockCcmActivation();
      mockStreamResponse(
        'event: message\ndata: {"choices":[{"delta":{"content":"not json","role":"assistant"}}]}\n\n',
      );

      await expect(
        client.complete({ userPrompt: 'Return JSON', responseFormat: 'json' }),
      ).rejects.toThrow('EIS returned invalid JSON');
    });

    it('should wrap inference errors with model context', async () => {
      mockCcmActivation();
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service unavailable',
      });

      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        'EIS inference failed for eis/anthropic-claude-4.6-opus',
      );
    });
  });

  describe('CCM activation', () => {
    it('should throw when CCM activation fails', async () => {
      // GET _all (no endpoints) → PUT _ccm rejects
      requestMock.mockResolvedValueOnce({ endpoints: [] });
      requestMock.mockRejectedValueOnce(new Error('Forbidden'));

      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        'EIS CCM activation failed: Forbidden',
      );
    });

    it('should throw when chat_completion endpoints never appear', async () => {
      // initial check (empty) → PUT → 10× polls that never show chat_completion
      requestMock.mockResolvedValueOnce({ endpoints: [] });
      requestMock.mockResolvedValueOnce({});

      for (let i = 0; i < 10; i++) {
        requestMock.mockResolvedValueOnce({
          endpoints: [{ task_type: 'text_embedding', service: 'elastic' }],
        });
      }

      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        'Timed out waiting for EIS chat_completion endpoints',
      );
    }, 60_000);
  });

  describe('serverless / native EIS', () => {
    it('skips CCM activation when chat_completion endpoints already exist (no key needed)', async () => {
      const mock = createMockEsClient();
      const serverlessClient = new EisLlmClient(
        mock.client,
        undefined, // no EIS_CCM_API_KEY on serverless
        'eis/anthropic-claude-4.6-opus',
        'https://my-project.es.cloud',
        'ApiKey serverless-key',
        logger,
      );

      mock.requestMock.mockResolvedValueOnce({
        endpoints: [{ task_type: 'chat_completion', service: 'elastic' }],
      });
      mockStreamResponse(SAMPLE_SSE);

      const result = await serverlessClient.complete({ userPrompt: 'Say hello' });

      expect(result.content).toBe('Hello');
      // Only the endpoint check — no PUT _ccm.
      expect(mock.requestMock).toHaveBeenCalledTimes(1);
      expect(mock.requestMock.mock.calls[0]![0].method).toBe('GET');
      expect(mock.requestMock.mock.calls[0]![0].path).toBe('/_inference/_all');

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('ApiKey serverless-key');
    });

    it('throws a clear error when no endpoints exist and no key is provided', async () => {
      const mock = createMockEsClient();
      const noKeyClient = new EisLlmClient(
        mock.client,
        undefined,
        'eis/anthropic-claude-4.6-opus',
        'https://my-project.es.cloud',
        'ApiKey serverless-key',
        logger,
      );

      mock.requestMock.mockResolvedValueOnce({ endpoints: [] });

      await expect(noKeyClient.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        'EIS not available',
      );
    });
  });
});
