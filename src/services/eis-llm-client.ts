import type { Client } from '@elastic/elasticsearch';
import type { Logger } from 'winston';
import type { LlmClient, LlmResponse } from './llm-client.js';

interface EisStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

export interface ParsedEisStreamResult {
  content: string;
  finishReason: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Map kbn/evals model id (eis/…) to ES inference endpoint id (.…-chat_completion). */
export function resolveEisInferenceEndpointId(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.startsWith('.') && trimmed.endsWith('-chat_completion')) {
    return trimmed;
  }
  if (trimmed.startsWith('eis/')) {
    return `.${trimmed.slice('eis/'.length)}-chat_completion`;
  }
  if (!trimmed.startsWith('.')) {
    return `.${trimmed}-chat_completion`;
  }
  return trimmed;
}

/** Parse SSE payload from EIS `/_stream` responses (testable without network). */
export function parseEisSsePayload(raw: string): ParsedEisStreamResult {
  let content = '';
  let finishReason = 'unknown';
  let model = '';
  let usage: ParsedEisStreamResult['usage'];

  const normalized = raw.replace(/\uFEFF/g, '');
  const blocks = normalized.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const dataLine = block
      .split(/\r?\n/)
      .find((line) => line.startsWith('data:'));
    if (!dataLine) {
      continue;
    }

    const payload = dataLine.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }

    let chunk: EisStreamChunk;
    try {
      chunk = JSON.parse(payload) as EisStreamChunk;
    } catch {
      continue;
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    if (chunk.model) {
      model = chunk.model;
    }

    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      content += choice.delta.content;
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }
  }

  return { content, finishReason, model, usage };
}

export function extractJsonContent(content: string): string {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }
  return trimmed;
}

export class EisLlmClient implements LlmClient {
  private ccmActivated = false;

  constructor(
    private readonly esClient: Client,
    // Optional: only needed to activate CCM on self-managed/local ES. On
    // serverless (and cloud with EIS provisioned) the chat_completion
    // endpoints already exist, so no CCM key is required.
    private readonly eisApiKey: string | undefined,
    private readonly eisModel: string,
    private readonly esBaseUrl: string,
    // Authorization header value (e.g. `ApiKey <key>` / `Basic <b64>`) for the
    // raw streaming fetch, which does not go through the ES client transport.
    private readonly authHeader?: string,
    private readonly logger?: Logger,
  ) {}

  async complete(opts: Parameters<LlmClient['complete']>[0]): Promise<LlmResponse> {
    await this.ensureCcmActivated();

    const messages: Array<{ role: string; content: string }> = [];
    if (opts.systemPrompt) {
      messages.push({ role: 'system', content: opts.systemPrompt });
    }
    messages.push({ role: 'user', content: opts.userPrompt });

    const body: Record<string, unknown> = { messages };
    if (opts.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    const modelId = opts.model ?? this.eisModel;
    const inferenceId = resolveEisInferenceEndpointId(modelId);
    this.logger?.debug('Sending EIS inference stream request', { modelId, inferenceId });

    try {
      const streamResult = await this.streamChatCompletion(inferenceId, body, modelId);

      if (opts.responseFormat === 'json' && streamResult.content) {
        const jsonPayload = extractJsonContent(streamResult.content);
        try {
          JSON.parse(jsonPayload);
        } catch {
          this.logger?.error('EIS returned invalid JSON', {
            content: streamResult.content.slice(0, 200),
          });
          throw new Error(`EIS returned invalid JSON: ${streamResult.content.slice(0, 200)}`);
        }
      }

      this.logger?.debug('EIS inference request completed', {
        model: streamResult.model,
        finishReason: streamResult.finishReason,
      });

      return {
        content: streamResult.content,
        finishReason: streamResult.finishReason,
        model: streamResult.model || modelId,
        usage: streamResult.usage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error('EIS inference request failed', { modelId, inferenceId, error: message });
      throw new Error(`EIS inference failed for ${modelId}: ${message}`);
    }
  }

  private async streamChatCompletion(
    inferenceId: string,
    body: Record<string, unknown>,
    fallbackModel: string,
  ): Promise<ParsedEisStreamResult> {
    const baseUrl = this.esBaseUrl.replace(/\/+$/, '');
    const path = `/_inference/chat_completion/${encodeURIComponent(inferenceId)}/_stream?timeout=3m`;
    const url = `${baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Elastic-Product-Use-Case': 'elastic-llm-benchmarker',
      };
      if (this.authHeader) {
        headers.Authorization = this.authHeader;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      if (!response.body) {
        throw new Error('EIS stream response had no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let finishReason = 'unknown';
      let model = fallbackModel;
      let usage: ParsedEisStreamResult['usage'];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let splitIndex = buffer.search(/\r?\n\r?\n/);
        while (splitIndex >= 0) {
          const block = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex).replace(/^\r?\n\r?\n/, '');

          const parsed = parseEisSsePayload(`${block}\n\n`);
          if (parsed.content) {
            content += parsed.content;
          }
          if (parsed.finishReason !== 'unknown') {
            finishReason = parsed.finishReason;
          }
          if (parsed.model) {
            model = parsed.model;
          }
          if (parsed.usage) {
            usage = parsed.usage;
          }

          splitIndex = buffer.search(/\r?\n\r?\n/);
        }
      }

      if (buffer.trim()) {
        const parsed = parseEisSsePayload(buffer);
        if (parsed.content) {
          content += parsed.content;
        }
        if (parsed.finishReason !== 'unknown') {
          finishReason = parsed.finishReason;
        }
        if (parsed.model) {
          model = parsed.model;
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }

      return { content, finishReason, model, usage };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async hasChatCompletionEndpoints(): Promise<boolean> {
    try {
      const endpoints = await this.esClient.transport.request<{
        endpoints?: Array<{ task_type?: string; service?: string }>;
      }>({
        method: 'GET',
        path: '/_inference/_all',
      });
      return (
        endpoints.endpoints?.some(
          (ep) => ep.task_type === 'chat_completion' && ep.service === 'elastic',
        ) ?? false
      );
    } catch {
      return false;
    }
  }

  private async ensureCcmActivated(): Promise<void> {
    if (this.ccmActivated) {
      return;
    }

    // Serverless (and EIS-provisioned cloud) already expose chat_completion
    // endpoints — no CCM activation and no EIS_CCM_API_KEY required.
    if (await this.hasChatCompletionEndpoints()) {
      this.logger?.info('EIS chat_completion endpoints already available — skipping CCM activation');
      this.ccmActivated = true;
      return;
    }

    // Self-managed/local ES: activate CCM with the operator-supplied key.
    if (!this.eisApiKey) {
      throw new Error(
        'EIS not available: cluster exposes no chat_completion endpoints and no ' +
          'EIS_CCM_API_KEY was provided to activate Cloud Connected Mode.',
      );
    }

    this.logger?.info('Activating EIS Cloud Connected Mode (CCM) on ES cluster');

    try {
      await this.esClient.transport.request({
        method: 'PUT',
        path: '/_inference/_ccm',
        body: { api_key: this.eisApiKey },
      });

      for (let attempt = 1; attempt <= 10; attempt++) {
        if (await this.hasChatCompletionEndpoints()) {
          this.logger?.info('EIS CCM activated — chat_completion endpoints available');
          this.ccmActivated = true;
          return;
        }

        if (attempt === 10) {
          throw new Error('Timed out waiting for EIS chat_completion endpoints');
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error('Failed to activate EIS CCM', { error: message });
      throw new Error(`EIS CCM activation failed: ${message}`);
    }
  }
}
