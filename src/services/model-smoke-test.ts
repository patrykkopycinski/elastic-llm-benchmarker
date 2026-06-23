import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';

export type SmokeTestTier = 'health' | 'inference' | 'tool-calling';

export interface SmokeTestResult {
  passed: boolean;
  tier: SmokeTestTier;
  details: string;
  durationMs: number;
  tiers: Record<SmokeTestTier, { passed: boolean; durationMs: number; error?: string }>;
}

export interface SmokeTestConfig {
  healthTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  toolCallingTimeoutMs?: number;
  maxRetries?: number;
  testPrompt?: string;
  expectedKeywords?: string[];
  toolName?: string;
  toolPrompt?: string;
  depth?: 'health' | 'inference' | 'full';
}

export interface ModelSmokeTest {
  run(endpointUrl: string, modelId: string): Promise<SmokeTestResult>;
}

export class ModelSmokeTestImpl implements ModelSmokeTest {
  private readonly logger: Logger;
  private readonly config: Required<SmokeTestConfig>;

  constructor(config?: SmokeTestConfig, logLevel?: string) {
    this.logger = createLogger(logLevel ?? 'info');
    this.config = {
      healthTimeoutMs: config?.healthTimeoutMs ?? 10_000,
      inferenceTimeoutMs: config?.inferenceTimeoutMs ?? 30_000,
      toolCallingTimeoutMs: config?.toolCallingTimeoutMs ?? 60_000,
      maxRetries: config?.maxRetries ?? 2,
      testPrompt: config?.testPrompt ?? 'What is 2 + 2? Answer with just the number.',
      expectedKeywords: config?.expectedKeywords ?? ['4'],
      toolName: config?.toolName ?? 'get_current_time',
      toolPrompt: config?.toolPrompt ?? 'What is the current time? Use the get_current_time tool.',
      depth: config?.depth ?? 'full',
    };
  }

  async run(endpointUrl: string, modelId: string): Promise<SmokeTestResult> {
    const startTime = Date.now();
    const baseUrl = endpointUrl.replace(/\/+$/, '');
    const tiers: SmokeTestResult['tiers'] = {
      'health': { passed: false, durationMs: 0 },
      'inference': { passed: false, durationMs: 0 },
      'tool-calling': { passed: false, durationMs: 0 },
    };

    // Tier 1: Health check
    const healthResult = await this.runHealthCheck(baseUrl);
    tiers['health'] = healthResult;
    if (!healthResult.passed) {
      return {
        passed: false,
        tier: 'health',
        details: healthResult.error ?? 'Health check failed',
        durationMs: Date.now() - startTime,
        tiers,
      };
    }

    if (this.config.depth === 'health') {
      return {
        passed: true,
        tier: 'health',
        details: 'Health check passed (depth=health)',
        durationMs: Date.now() - startTime,
        tiers,
      };
    }

    // Tier 2: Single inference
    const inferenceResult = await this.runInferenceCheck(baseUrl, modelId);
    tiers['inference'] = inferenceResult;
    if (!inferenceResult.passed) {
      return {
        passed: false,
        tier: 'inference',
        details: inferenceResult.error ?? 'Inference check failed',
        durationMs: Date.now() - startTime,
        tiers,
      };
    }

    if (this.config.depth === 'inference') {
      return {
        passed: true,
        tier: 'inference',
        details: 'Inference check passed (depth=inference)',
        durationMs: Date.now() - startTime,
        tiers,
      };
    }

    // Tier 3: Tool calling
    const toolResult = await this.runToolCallingCheck(baseUrl, modelId);
    tiers['tool-calling'] = toolResult;
    if (!toolResult.passed) {
      return {
        passed: false,
        tier: 'tool-calling',
        details: toolResult.error ?? 'Tool calling check failed',
        durationMs: Date.now() - startTime,
        tiers,
      };
    }

    return {
      passed: true,
      tier: 'tool-calling',
      details: 'All smoke test tiers passed',
      durationMs: Date.now() - startTime,
      tiers,
    };
  }

  private async runHealthCheck(
    baseUrl: string,
  ): Promise<{ passed: boolean; durationMs: number; error?: string }> {
    const start = Date.now();
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.healthTimeoutMs);

        const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          this.logger.info('Smoke test: health check passed');
          return { passed: true, durationMs: Date.now() - start };
        }

        this.logger.warn('Smoke test: health check returned non-OK', {
          status: response.status,
          attempt,
        });
      } catch (err) {
        this.logger.warn('Smoke test: health check error', {
          error: err instanceof Error ? err.message : String(err),
          attempt,
        });
      }

      if (attempt < this.config.maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return { passed: false, durationMs: Date.now() - start, error: 'Health endpoint unreachable' };
  }

  private async runInferenceCheck(
    baseUrl: string,
    modelId: string,
  ): Promise<{ passed: boolean; durationMs: number; error?: string }> {
    const start = Date.now();
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.inferenceTimeoutMs);

        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: this.config.testPrompt }],
            max_tokens: 50,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          this.logger.warn('Smoke test: inference returned non-OK', { status: response.status, body: text, attempt });
          if (attempt < this.config.maxRetries) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          return { passed: false, durationMs: Date.now() - start, error: `Inference API returned ${response.status}` };
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content ?? '';

        const hasKeyword = this.config.expectedKeywords.some((kw) =>
          content.toLowerCase().includes(kw.toLowerCase()),
        );

        if (hasKeyword) {
          this.logger.info('Smoke test: inference check passed', { content: content.slice(0, 100) });
          return { passed: true, durationMs: Date.now() - start };
        }

        this.logger.warn('Smoke test: inference response missing expected keywords', {
          content: content.slice(0, 200),
          expected: this.config.expectedKeywords,
        });
        return { passed: false, durationMs: Date.now() - start, error: `Response lacks expected keywords: ${content.slice(0, 100)}` };
      } catch (err) {
        this.logger.warn('Smoke test: inference error', {
          error: err instanceof Error ? err.message : String(err),
          attempt,
        });
        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    return { passed: false, durationMs: Date.now() - start, error: 'Inference check failed after retries' };
  }

  private async runToolCallingCheck(
    baseUrl: string,
    modelId: string,
  ): Promise<{ passed: boolean; durationMs: number; error?: string }> {
    const start = Date.now();
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: this.config.toolName,
          description: 'Get the current time in UTC',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.toolCallingTimeoutMs);

        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: this.config.toolPrompt }],
            tools,
            tool_choice: 'auto',
            max_tokens: 200,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          this.logger.warn('Smoke test: tool calling returned non-OK', { status: response.status, body: text, attempt });
          if (attempt < this.config.maxRetries) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          return { passed: false, durationMs: Date.now() - start, error: `Tool calling API returned ${response.status}` };
        }

        const data = (await response.json()) as {
          choices?: Array<{
            message?: { tool_calls?: Array<{ function?: { name?: string } }> };
          }>;
        };
        const toolCalls = data.choices?.[0]?.message?.tool_calls ?? [];

        if (toolCalls.length > 0 && toolCalls[0]?.function?.name === this.config.toolName) {
          this.logger.info('Smoke test: tool calling check passed');
          return { passed: true, durationMs: Date.now() - start };
        }

        this.logger.warn('Smoke test: model did not produce expected tool call', {
          toolCalls: toolCalls.map((tc) => tc.function?.name),
        });
        return { passed: false, durationMs: Date.now() - start, error: 'Model did not invoke expected tool' };
      } catch (err) {
        this.logger.warn('Smoke test: tool calling error', {
          error: err instanceof Error ? err.message : String(err),
          attempt,
        });
        if (attempt < this.config.maxRetries) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    return { passed: false, durationMs: Date.now() - start, error: 'Tool calling check failed after retries' };
  }
}
