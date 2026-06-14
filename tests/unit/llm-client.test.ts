import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LlmClientImpl } from '../../src/services/llm-client.js';
import type { AppConfig } from '../../src/types/config.js';
import type { Logger } from 'winston';

function createMockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ssh: {
      host: '10.0.0.1',
      port: 22,
      username: 'user',
      password: 'pass',
    },
    huggingfaceToken: 'hf_test',
    llmApiKey: 'sk-test-key',
    llmBaseUrl: undefined,
    llmModel: 'gpt-4o',
    llmMaxTokens: 4096,
    llmTemperature: 0.3,
    benchmarkThresholds: {},
    vmHardwareProfile: {},
    logLevel: 'info',
    resultsDir: './results',
    daemon: {},
    tunnel: {},
    engine: {},
    kibanaConnector: {},
    notifications: {},
    kibanaEval: {},
    elasticsearch: {},
    elasticAgent: {},
    stage2Thresholds: {},
    enableStage2: false,
    goldenCluster: {},
    edotCollector: {},
    kibanaRepo: {},
    ...overrides,
  } as AppConfig;
}

const mockFetch = vi.fn();

describe('LlmClientImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('complete', () => {
    it('should complete successfully with text format', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: 'Hello world' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
          model: 'gpt-4o',
        }),
      });

      const result = await client.complete({ userPrompt: 'Say hello' });

      expect(result.content).toBe('Hello world');
      expect(result.finishReason).toBe('stop');
      expect(result.model).toBe('gpt-4o');
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0]!;
      expect(call[0]).toBe('https://api.openai.com/v1/chat/completions');
      expect(call[1].method).toBe('POST');
      expect(call[1].headers['Authorization']).toBe('Bearer sk-test-key');
      expect(call[1].headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(call[1].body);
      expect(body.model).toBe('gpt-4o');
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
      expect(body.temperature).toBe(0.3);
      expect(body.max_tokens).toBe(4096);
      expect(body.response_format).toBeUndefined();
    });

    it('should include system prompt when provided', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
        }),
      });

      await client.complete({
        systemPrompt: 'You are a helpful assistant',
        userPrompt: 'Hello',
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
      ]);
    });

    it('should omit system message when systemPrompt is absent', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
        }),
      });

      await client.complete({ userPrompt: 'Hello' });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('should use overrides for model, temperature, and maxTokens', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          model: 'custom-model',
        }),
      });

      await client.complete({
        userPrompt: 'Hello',
        model: 'custom-model',
        temperature: 0.7,
        maxTokens: 512,
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.model).toBe('custom-model');
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(512);
    });

    it('should use custom baseUrl when configured', async () => {
      const config = createMockConfig({ llmBaseUrl: 'https://custom.api.com/v1' });
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
        }),
      });

      await client.complete({ userPrompt: 'Hello' });

      expect(mockFetch.mock.calls[0]![0]).toBe('https://custom.api.com/v1/chat/completions');
    });

    it('should complete successfully with JSON format and parse', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: '{"answer": 42}' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
          },
          model: 'gpt-4o',
        }),
      });

      const result = await client.complete({
        userPrompt: 'Return JSON',
        responseFormat: 'json',
      });

      expect(result.content).toBe('{"answer": 42}');
      expect(result.finishReason).toBe('stop');

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('should throw when API returns non-2xx status', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized: invalid api key',
      });

      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        'LLM API error 401: Unauthorized: invalid api key',
      );
    });

    it('should throw when API key is missing', async () => {
      const config = createMockConfig({ llmApiKey: undefined });
      const client = new LlmClientImpl(config);

      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        'LLM API key is not configured',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when response_format=json but API returns non-JSON', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: 'not valid json' },
              finish_reason: 'stop',
            },
          ],
          model: 'gpt-4o',
        }),
      });

      await expect(
        client.complete({ userPrompt: 'Return JSON', responseFormat: 'json' }),
      ).rejects.toThrow('LLM returned invalid JSON: not valid json');
    });

    it('should handle responses without usage', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'No usage' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
        }),
      });

      const result = await client.complete({ userPrompt: 'Hello' });
      expect(result.usage).toBeUndefined();
    });

    it('should handle empty choices array', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [],
          model: 'gpt-4o',
        }),
      });

      const result = await client.complete({ userPrompt: 'Hello' });
      expect(result.content).toBe('');
      expect(result.finishReason).toBe('unknown');
    });

    it('should handle truncated error text to 200 chars', async () => {
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      const longError = 'x'.repeat(500);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => longError,
      });

      await expect(client.complete({ userPrompt: 'Hello' })).rejects.toThrow(
        `LLM API error 500: ${longError.slice(0, 200)}`,
      );
    });
  });

  describe('timeout', () => {
    it('should abort request after timeout', async () => {
      vi.useFakeTimers();
      const config = createMockConfig();
      const client = new LlmClientImpl(config);

      mockFetch.mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });

      const promise = client.complete({ userPrompt: 'Hello' });

      // Advance past the 120s timeout
      vi.advanceTimersByTime(121_000);

      await expect(promise).rejects.toThrow();

      vi.useRealTimers();
    });
  });

  describe('logger', () => {
    it('should accept an optional logger', async () => {
      const config = createMockConfig();
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger;

      const client = new LlmClientImpl(config, logger);
      expect(client).toBeInstanceOf(LlmClientImpl);
    });
  });
});
