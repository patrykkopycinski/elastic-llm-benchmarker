import type { Logger } from 'winston';
import type { AppConfig } from '../types/config.js';

export interface LlmResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
  model: string;
}

export interface LlmClient {
  complete(opts: {
    systemPrompt?: string;
    userPrompt: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'json' | 'text';
  }): Promise<LlmResponse>;
}

export class LlmClientImpl implements LlmClient {
  constructor(private config: AppConfig, private logger?: Logger) {}

  async complete(opts: Parameters<LlmClient['complete']>[0]): Promise<LlmResponse> {
    if (!this.config.llmApiKey) {
      this.logger?.error('LLM API key is not configured');
      throw new Error('LLM API key is not configured');
    }

    const baseUrl = this.config.llmBaseUrl ?? 'https://api.openai.com/v1';
    const url = `${baseUrl}/chat/completions`;

    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: opts.userPrompt });

    const body: Record<string, unknown> = {
      model: opts.model ?? this.config.llmModel,
      messages,
      temperature: opts.temperature ?? this.config.llmTemperature,
      max_tokens: opts.maxTokens ?? this.config.llmMaxTokens,
    };

    if (opts.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    this.logger?.debug(`Sending LLM request to ${url}`, { model: body.model });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.llmApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const snippet = text.slice(0, 200);
        this.logger?.error(`LLM API error ${response.status}: ${snippet}`);
        throw new Error(`LLM API error ${response.status}: ${snippet}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        model?: string;
      };

      const choices = data.choices;
      const choice = choices && choices.length > 0 ? choices[0] : undefined;
      const content = choice?.message?.content ?? '';
      const finishReason = choice?.finish_reason ?? 'unknown';
      const model = data.model ?? opts.model ?? this.config.llmModel ?? 'unknown';

      if (opts.responseFormat === 'json' && content) {
        try {
          JSON.parse(content);
        } catch {
          this.logger?.error('LLM returned invalid JSON', { content: content.slice(0, 200) });
          throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}`);
        }
      }

      this.logger?.debug('LLM request completed', { model, finishReason });

      return {
        content,
        finishReason,
        model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
