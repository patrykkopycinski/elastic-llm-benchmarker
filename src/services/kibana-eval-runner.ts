import { createLogger } from '../utils/logger.js';
import type { KibanaConnectorConfig } from '../types/config.js';
import type {
  KibanaEvalTaskDefinition,
  KibanaEvalTaskResult,
  KibanaEvalClassification,
  KibanaEvalScoring,
  KibanaEvalReport,
  KibanaEvalRunnerConfig,
} from '../types/kibana-eval.js';
import { SEVERITY_WEIGHTS, DEFAULT_KIBANA_EVAL_CONFIG } from '../types/kibana-eval.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Options for creating a KibanaEvalRunner instance */
export interface KibanaEvalRunnerOptions {
  /** Kibana connector configuration (URL, API key, etc.) */
  kibanaConfig: KibanaConnectorConfig;
  /** Evaluation runner configuration */
  evalConfig?: Partial<KibanaEvalRunnerConfig>;
  /** Winston log level (default: 'info') */
  logLevel?: string;
}

/** Chat completions API response shape */
interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

// ─── Evaluation Task Definitions ──────────────────────────────────────────────

/**
 * Built-in evaluation tasks for testing Kibana Agent builder connector compatibility.
 */
export const KIBANA_EVAL_TASKS: KibanaEvalTaskDefinition[] = [
  {
    id: 'connector_health_check',
    name: 'Connector Health Check',
    description:
      'Verifies the Kibana connector is reachable and the underlying model endpoint responds to a basic API call',
    category: 'connector_health',
    severity: 'CRITICAL',
    timeoutMs: 30_000,
    retryAttempts: 2,
  },
  {
    id: 'chat_completion_basic',
    name: 'Basic Chat Completion',
    description:
      'Sends a simple chat completion request and validates the response contains expected content',
    category: 'chat_completion',
    severity: 'CRITICAL',
    timeoutMs: 30_000,
    retryAttempts: 1,
  },
  {
    id: 'chat_completion_system_prompt',
    name: 'System Prompt Handling',
    description:
      'Verifies the model correctly handles system prompts by following specific formatting instructions',
    category: 'chat_completion',
    severity: 'IMPORTANT',
    timeoutMs: 30_000,
    retryAttempts: 1,
  },
  {
    id: 'tool_calling_basic',
    name: 'Basic Tool Calling',
    description:
      'Tests the model can invoke a tool when given a tool definition and a prompt requiring tool use',
    category: 'tool_calling',
    severity: 'CRITICAL',
    timeoutMs: 30_000,
    retryAttempts: 2,
  },
  {
    id: 'streaming_response',
    name: 'Streaming Response',
    description:
      'Verifies the connector supports streaming responses (SSE) with proper chunk delivery',
    category: 'streaming',
    severity: 'IMPORTANT',
    timeoutMs: 30_000,
    retryAttempts: 1,
  },
  {
    id: 'error_handling_invalid_input',
    name: 'Error Handling - Invalid Input',
    description:
      'Sends an intentionally malformed request and verifies the connector returns a proper error response rather than crashing',
    category: 'error_handling',
    severity: 'NICE_TO_HAVE',
    timeoutMs: 15_000,
    retryAttempts: 0,
  },
];

// ─── Kibana Eval Runner ──────────────────────────────────────────────────────

/**
 * Evaluation runner for testing models via Kibana's Agent builder features.
 *
 * Executes a suite of evaluation tasks against a Kibana connector to validate
 * that a deployed model works correctly through Kibana's connector infrastructure.
 * This includes testing chat completions, tool calling, streaming, and error handling.
 *
 * ## Scoring Methodology
 *
 * Each task has a severity level that determines its weight:
 * - **CRITICAL** (weight 1.0): Must pass for the model to be usable
 * - **IMPORTANT** (weight 0.7): Should pass for good user experience
 * - **NICE_TO_HAVE** (weight 0.3): Marginal improvements
 *
 * The overall classification is:
 * - **PASS**: All critical tasks pass and weighted score >= passThreshold (default 80%)
 * - **PARTIAL**: All critical tasks pass but weighted score < passThreshold
 * - **FAIL**: One or more critical tasks failed
 *
 * ## Usage
 *
 * ```typescript
 * const runner = new KibanaEvalRunner({
 *   kibanaConfig: appConfig.kibanaConnector,
 *   evalConfig: { passThreshold: 80 },
 * });
 *
 * const report = await runner.runEvaluation({
 *   connectorId: 'my-connector-id',
 *   modelId: 'meta-llama/Llama-3-70B',
 * });
 *
 * console.log(`Classification: ${report.classification}`);
 * console.log(`Score: ${report.scoring.percentageScore}%`);
 * ```
 */
export class KibanaEvalRunner {
  private readonly logger;
  private readonly kibanaConfig: KibanaConnectorConfig;
  private readonly evalConfig: KibanaEvalRunnerConfig;

  constructor(options: KibanaEvalRunnerOptions) {
    this.kibanaConfig = options.kibanaConfig;
    this.evalConfig = {
      ...DEFAULT_KIBANA_EVAL_CONFIG,
      ...options.evalConfig,
    };
    this.logger = createLogger(options.logLevel ?? 'info');

    this.logger.info('KibanaEvalRunner initialized', {
      enabled: this.evalConfig.enabled,
      passThreshold: this.evalConfig.passThreshold,
      taskCount: KIBANA_EVAL_TASKS.length,
    });
  }

  /**
   * Whether the evaluation runner is enabled.
   */
  get enabled(): boolean {
    return this.evalConfig.enabled && this.kibanaConfig.enabled;
  }

  /**
   * Returns the current evaluation configuration.
   */
  getConfig(): KibanaEvalRunnerConfig {
    return { ...this.evalConfig };
  }

  /**
   * Runs the complete evaluation suite against a Kibana connector.
   *
   * @param options - Connector and model identification
   * @returns Complete evaluation report with classification and task results
   */
  async runEvaluation(options: {
    connectorId: string;
    modelId: string;
  }): Promise<KibanaEvalReport> {
    const startTime = Date.now();

    this.logger.info('Starting Kibana evaluation', {
      connectorId: options.connectorId,
      modelId: options.modelId,
      taskCount: KIBANA_EVAL_TASKS.length,
    });

    const taskResults: KibanaEvalTaskResult[] = [];
    let criticalFailureEncountered = false;

    for (const task of KIBANA_EVAL_TASKS) {
      // If a critical task failed and we don't continue on critical failure, skip remaining
      if (criticalFailureEncountered && !this.evalConfig.continueOnCriticalFailure) {
        taskResults.push(this.createSkippedResult(task, 'Skipped due to prior critical failure'));
        continue;
      }

      const result = await this.executeTask(task, options.connectorId);
      taskResults.push(result);

      // Track critical failures
      if (
        task.severity === 'CRITICAL' &&
        (result.outcome === 'FAIL' || result.outcome === 'ERROR')
      ) {
        criticalFailureEncountered = true;
        this.logger.warn(`Critical task failed: ${task.id}`, {
          outcome: result.outcome,
          error: result.error,
        });
      }
    }

    const scoring = this.calculateScoring(taskResults);
    const classification = this.deriveClassification(taskResults, scoring);
    const failedTasks = taskResults.filter(
      (r) => r.outcome === 'FAIL' || r.outcome === 'ERROR',
    );
    const totalDurationMs = Date.now() - startTime;
    const summary = this.generateSummary(
      options.modelId,
      classification,
      scoring,
      failedTasks,
    );

    const report: KibanaEvalReport = {
      modelId: options.modelId,
      connectorId: options.connectorId,
      timestamp: new Date().toISOString(),
      classification,
      summary,
      scoring,
      taskResults,
      failedTasks,
      totalDurationMs,
      evalConfig: { ...this.evalConfig },
    };

    this.logger.info('Kibana evaluation completed', {
      modelId: options.modelId,
      classification,
      percentageScore: scoring.percentageScore,
      passedCount: scoring.passedCount,
      failedCount: scoring.failedCount,
      totalDurationMs,
    });

    return report;
  }

  /**
   * Formats an evaluation report as a human-readable text report.
   */
  formatReport(report: KibanaEvalReport): string {
    const lines: string[] = [];

    lines.push('═'.repeat(72));
    lines.push('  KIBANA AGENT BUILDER EVALUATION REPORT');
    lines.push('═'.repeat(72));
    lines.push('');
    lines.push(`  Model:          ${report.modelId}`);
    lines.push(`  Connector:      ${report.connectorId}`);
    lines.push(`  Classification: ${report.classification}`);
    lines.push(`  Score:          ${report.scoring.percentageScore.toFixed(1)}%`);
    lines.push(`  Timestamp:      ${report.timestamp}`);
    lines.push(`  Duration:       ${report.totalDurationMs}ms`);
    lines.push('');
    lines.push('─'.repeat(72));
    lines.push('  SUMMARY');
    lines.push('─'.repeat(72));
    lines.push(`  ${report.summary}`);
    lines.push('');
    lines.push('─'.repeat(72));
    lines.push('  TASK RESULTS');
    lines.push('─'.repeat(72));

    for (const result of report.taskResults) {
      const statusIcon =
        result.outcome === 'PASS'
          ? '✓'
          : result.outcome === 'FAIL'
            ? '✗'
            : result.outcome === 'SKIP'
              ? '○'
              : '!';
      const severityTag = `[${result.task.severity}]`;
      lines.push('');
      lines.push(
        `  ${statusIcon} ${result.outcome} ${severityTag} ${result.task.name}`,
      );
      lines.push(`         Score:    ${(result.score * 100).toFixed(0)}%`);
      lines.push(`         Duration: ${result.durationMs}ms`);
      lines.push(`         ${result.message}`);
      if (result.error) {
        lines.push(`         Error: ${result.error}`);
      }
    }

    if (report.failedTasks.length > 0) {
      lines.push('');
      lines.push('─'.repeat(72));
      lines.push('  FAILED TASKS');
      lines.push('─'.repeat(72));
      for (const failed of report.failedTasks) {
        lines.push(
          `  [${failed.task.severity}] ${failed.task.id}: ${failed.message}`,
        );
      }
    }

    lines.push('');
    lines.push('─'.repeat(72));
    lines.push('  SCORING BREAKDOWN');
    lines.push('─'.repeat(72));
    lines.push(
      `  Passed: ${report.scoring.passedCount}/${report.scoring.totalCount}`,
    );
    lines.push(`  Failed: ${report.scoring.failedCount}`);
    lines.push(`  Skipped: ${report.scoring.skippedCount}`);
    lines.push(`  Errored: ${report.scoring.erroredCount}`);
    lines.push(
      `  Weighted Score: ${report.scoring.totalWeightedScore.toFixed(2)}/${report.scoring.maxWeightedScore.toFixed(2)}`,
    );
    lines.push(
      `  Percentage: ${report.scoring.percentageScore.toFixed(1)}%`,
    );
    lines.push('');
    lines.push('═'.repeat(72));

    return lines.join('\n');
  }

  // ─── Task Execution ─────────────────────────────────────────────────────────

  /**
   * Executes a single evaluation task with retry logic.
   */
  private async executeTask(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
  ): Promise<KibanaEvalTaskResult> {
    let lastError: string | null = null;
    let attempts = 0;
    const maxAttempts = task.retryAttempts + 1;

    while (attempts < maxAttempts) {
      attempts++;
      const startTime = Date.now();

      try {
        const result = await this.runTaskWithTimeout(task, connectorId);
        const durationMs = Date.now() - startTime;

        return {
          ...result,
          durationMs,
          attempts,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.debug(`Task ${task.id} attempt ${attempts}/${maxAttempts} failed`, {
          error: lastError,
        });

        // Don't retry on the last attempt
        if (attempts < maxAttempts) {
          // Brief delay before retry
          await this.sleep(1000);
        }
      }
    }

    // All attempts exhausted
    return {
      task,
      outcome: 'ERROR',
      durationMs: 0,
      message: `Task failed after ${attempts} attempt(s): ${lastError}`,
      error: lastError,
      score: 0,
      weightedScore: 0,
      attempts,
      metadata: {},
    };
  }

  /**
   * Runs a task with timeout enforcement.
   */
  private async runTaskWithTimeout(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);

    try {
      const result = await this.dispatchTask(task, connectorId, controller.signal);
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          task,
          outcome: 'ERROR',
          message: `Task timed out after ${task.timeoutMs}ms`,
          error: `Timeout: ${task.timeoutMs}ms exceeded`,
          score: 0,
          weightedScore: 0,
          metadata: {},
        };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Dispatches a task to its specific handler based on task ID.
   */
  private async dispatchTask(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    switch (task.id) {
      case 'connector_health_check':
        return this.taskConnectorHealthCheck(task, connectorId, signal);
      case 'chat_completion_basic':
        return this.taskChatCompletionBasic(task, connectorId, signal);
      case 'chat_completion_system_prompt':
        return this.taskChatCompletionSystemPrompt(task, connectorId, signal);
      case 'tool_calling_basic':
        return this.taskToolCallingBasic(task, connectorId, signal);
      case 'streaming_response':
        return this.taskStreamingResponse(task, connectorId, signal);
      case 'error_handling_invalid_input':
        return this.taskErrorHandlingInvalidInput(task, connectorId, signal);
      default:
        return {
          task,
          outcome: 'SKIP',
          message: `Unknown task ID: ${task.id}`,
          error: null,
          score: 0,
          weightedScore: 0,
          metadata: {},
        };
    }
  }

  // ─── Individual Task Implementations ────────────────────────────────────────

  /**
   * Task: Connector Health Check
   *
   * Verifies the Kibana connector is reachable by executing a minimal
   * chat completion request through the connector's API.
   */
  private async taskConnectorHealthCheck(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    const response = await this.executeConnectorAction(
      connectorId,
      {
        params: {
          subAction: 'invokeAI',
          subActionParams: {
            messages: [{ role: 'user', content: 'ping' }],
          },
        },
      },
      signal,
    );

    if (response.status === 'ok') {
      return this.createPassResult(task, 'Connector health check passed — model is reachable', {
        status: response.status,
      });
    }

    return this.createFailResult(
      task,
      `Connector health check failed with status: ${response.status}`,
      response.errorMessage ?? 'Unknown error',
      { status: response.status },
    );
  }

  /**
   * Task: Basic Chat Completion
   *
   * Sends a simple chat completion request and validates the response
   * structure and content.
   */
  private async taskChatCompletionBasic(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    const response = await this.executeConnectorAction(
      connectorId,
      {
        params: {
          subAction: 'invokeAI',
          subActionParams: {
            messages: [
              { role: 'user', content: this.evalConfig.testPrompt },
            ],
          },
        },
      },
      signal,
    );

    if (response.status !== 'ok' || !response.data) {
      return this.createFailResult(
        task,
        `Chat completion failed with status: ${response.status}`,
        response.errorMessage ?? 'No response data',
        { status: response.status },
      );
    }

    // Validate response has content
    const content = this.extractResponseContent(response.data);
    if (!content || content.trim().length === 0) {
      return this.createFailResult(
        task,
        'Chat completion returned empty content',
        'Response content is empty or null',
        { responseData: response.data },
      );
    }

    // Check for expected keywords
    const hasExpectedContent = this.evalConfig.expectedResponseKeywords.some((keyword) =>
      content.toLowerCase().includes(keyword.toLowerCase()),
    );

    if (!hasExpectedContent) {
      return this.createFailResult(
        task,
        `Response did not contain expected keywords: ${this.evalConfig.expectedResponseKeywords.join(', ')}`,
        `Actual response: "${content.substring(0, 200)}"`,
        { content: content.substring(0, 500) },
      );
    }

    return this.createPassResult(
      task,
      'Chat completion returned valid response with expected content',
      { contentLength: content.length },
    );
  }

  /**
   * Task: System Prompt Handling
   *
   * Verifies the model correctly follows system prompt instructions.
   */
  private async taskChatCompletionSystemPrompt(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    const systemPrompt =
      'You are a helpful assistant. Always start your response with the word "ACKNOWLEDGED".';
    const userPrompt = 'Tell me a fun fact about space.';

    const response = await this.executeConnectorAction(
      connectorId,
      {
        params: {
          subAction: 'invokeAI',
          subActionParams: {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          },
        },
      },
      signal,
    );

    if (response.status !== 'ok' || !response.data) {
      return this.createFailResult(
        task,
        `System prompt test failed with status: ${response.status}`,
        response.errorMessage ?? 'No response data',
        { status: response.status },
      );
    }

    const content = this.extractResponseContent(response.data);
    if (!content) {
      return this.createFailResult(
        task,
        'System prompt test returned empty content',
        'Response content is empty or null',
        {},
      );
    }

    // Check if the response follows the system prompt instruction
    const followsInstruction = content.trim().toUpperCase().startsWith('ACKNOWLEDGED');

    if (!followsInstruction) {
      return this.createFailResult(
        task,
        'Model did not follow system prompt instruction (expected response starting with "ACKNOWLEDGED")',
        `Actual start: "${content.substring(0, 100)}"`,
        { content: content.substring(0, 500) },
      );
    }

    return this.createPassResult(
      task,
      'Model correctly followed system prompt instructions',
      { contentLength: content.length },
    );
  }

  /**
   * Task: Basic Tool Calling
   *
   * Tests the model's ability to invoke a tool through the Kibana connector.
   */
  private async taskToolCallingBasic(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    const toolName = this.evalConfig.toolCallTestToolName;

    const response = await this.executeConnectorAction(
      connectorId,
      {
        params: {
          subAction: 'invokeAI',
          subActionParams: {
            messages: [
              {
                role: 'user',
                content: this.evalConfig.toolCallTestPrompt,
              },
            ],
            tools: [
              {
                type: 'function',
                function: {
                  name: toolName,
                  description: 'Get the current date and time in ISO 8601 format',
                  parameters: {
                    type: 'object',
                    properties: {
                      timezone: {
                        type: 'string',
                        description: 'IANA timezone name (e.g., "America/New_York"). Defaults to UTC.',
                      },
                    },
                    required: [],
                  },
                },
              },
            ],
          },
        },
      },
      signal,
    );

    if (response.status !== 'ok' || !response.data) {
      return this.createFailResult(
        task,
        `Tool calling test failed with status: ${response.status}`,
        response.errorMessage ?? 'No response data',
        { status: response.status },
      );
    }

    // Check if the response contains tool calls
    const toolCalls = this.extractToolCalls(response.data);

    if (!toolCalls || toolCalls.length === 0) {
      // Check if the model just responded with text instead of a tool call
      const content = this.extractResponseContent(response.data);
      return this.createFailResult(
        task,
        'Model did not generate any tool calls',
        `Response was text instead of tool call: "${(content ?? '').substring(0, 200)}"`,
        { content: content?.substring(0, 500) },
      );
    }

    // Verify the correct tool was called
    const hasCorrectToolCall = toolCalls.some((tc) => tc.function.name === toolName);

    if (!hasCorrectToolCall) {
      const calledTools = toolCalls.map((tc) => tc.function.name).join(', ');
      return this.createFailResult(
        task,
        `Model called wrong tool(s): ${calledTools} (expected: ${toolName})`,
        `Called tools: ${calledTools}`,
        { toolCalls },
      );
    }

    return this.createPassResult(
      task,
      `Model correctly invoked tool '${toolName}'`,
      { toolCallCount: toolCalls.length },
    );
  }

  /**
   * Task: Streaming Response
   *
   * Verifies the connector supports streaming (SSE) responses.
   */
  private async taskStreamingResponse(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    const response = await this.executeConnectorAction(
      connectorId,
      {
        params: {
          subAction: 'invokeStream',
          subActionParams: {
            messages: [
              { role: 'user', content: 'Say the word hello.' },
            ],
          },
        },
      },
      signal,
    );

    if (response.status !== 'ok') {
      // Streaming might not be supported — that's an IMPORTANT but not CRITICAL issue
      return this.createFailResult(
        task,
        `Streaming response test failed with status: ${response.status}`,
        response.errorMessage ?? 'Streaming may not be supported',
        { status: response.status },
      );
    }

    // If we got a response, streaming is supported
    const data = response.data;
    const hasContent =
      typeof data === 'string'
        ? data.length > 0
        : data != null;

    if (!hasContent) {
      return this.createFailResult(
        task,
        'Streaming response returned empty data',
        'No streaming chunks received',
        {},
      );
    }

    return this.createPassResult(
      task,
      'Streaming response is supported and returned data',
      { dataType: typeof data },
    );
  }

  /**
   * Task: Error Handling - Invalid Input
   *
   * Sends a malformed request and checks the connector returns a proper error.
   */
  private async taskErrorHandlingInvalidInput(
    task: KibanaEvalTaskDefinition,
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'>> {
    // Send an empty messages array, which should be invalid
    const response = await this.executeConnectorAction(
      connectorId,
      {
        params: {
          subAction: 'invokeAI',
          subActionParams: {
            messages: [],
          },
        },
      },
      signal,
    );

    // We expect an error response (non-ok status) — that's the correct behavior
    if (response.status === 'error') {
      return this.createPassResult(
        task,
        'Connector correctly returned an error for invalid input',
        { errorMessage: response.errorMessage },
      );
    }

    // If it returned ok, that's still acceptable (model handled empty gracefully)
    if (response.status === 'ok') {
      return this.createPassResult(
        task,
        'Connector handled invalid input gracefully (returned ok with valid response)',
        {},
      );
    }

    return this.createFailResult(
      task,
      `Unexpected status for error handling test: ${response.status}`,
      'Expected either "error" or "ok" status',
      { status: response.status },
    );
  }

  // ─── Kibana Connector API ───────────────────────────────────────────────────

  /**
   * Executes an action through a Kibana connector using the connector
   * execute API.
   *
   * POST /api/actions/connector/{connectorId}/_execute
   */
  private async executeConnectorAction(
    connectorId: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    status: string;
    data: unknown;
    errorMessage: string | null;
  }> {
    const url = `${this.kibanaConfig.url}/api/actions/connector/${connectorId}/_execute`;

    this.logger.debug('Executing connector action', { url, connectorId });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'kbn-xsrf': 'true',
          Authorization: `ApiKey ${this.kibanaConfig.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        return {
          status: 'error',
          data: null,
          errorMessage: `HTTP ${response.status}: ${errorBody}`,
        };
      }

      const json = await response.json() as Record<string, unknown>;
      return {
        status: (json.status as string) ?? 'unknown',
        data: json.data ?? json,
        errorMessage: (json.message as string) ?? null,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error; // Let the caller handle abort
      }

      return {
        status: 'error',
        data: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ─── Response Parsing Helpers ───────────────────────────────────────────────

  /**
   * Extracts text content from a connector response data payload.
   */
  private extractResponseContent(data: unknown): string | null {
    if (typeof data === 'string') {
      return data;
    }

    if (typeof data === 'object' && data !== null) {
      const obj = data as ChatCompletionResponse;

      // Standard OpenAI-like response
      if (obj.choices?.[0]?.message?.content) {
        return obj.choices[0].message.content;
      }

      // Kibana connector response wraps content as a string
      if ('message' in obj && typeof (obj as Record<string, unknown>).message === 'string') {
        return (obj as Record<string, unknown>).message as string;
      }
    }

    return null;
  }

  /**
   * Extracts tool calls from a connector response data payload.
   */
  private extractToolCalls(
    data: unknown,
  ): Array<{ function: { name: string; arguments: string } }> | null {
    if (typeof data !== 'object' || data === null) {
      return null;
    }

    const obj = data as ChatCompletionResponse;

    // Standard OpenAI-like response
    if (obj.choices?.[0]?.message?.tool_calls) {
      return obj.choices[0].message.tool_calls;
    }

    // Check if data directly contains tool_calls
    if ('tool_calls' in obj && Array.isArray((obj as Record<string, unknown>).tool_calls)) {
      return (obj as Record<string, unknown>).tool_calls as Array<{
        function: { name: string; arguments: string };
      }>;
    }

    return null;
  }

  // ─── Scoring & Classification ───────────────────────────────────────────────

  /**
   * Calculates the scoring breakdown from task results.
   */
  private calculateScoring(
    taskResults: KibanaEvalTaskResult[],
  ): KibanaEvalScoring {
    let totalScore = 0;
    let maxScore = 0;
    let totalWeightedScore = 0;
    let maxWeightedScore = 0;
    let passedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let erroredCount = 0;

    for (const result of taskResults) {
      const weight = SEVERITY_WEIGHTS[result.task.severity];
      maxScore += 1;
      maxWeightedScore += weight;

      totalScore += result.score;
      totalWeightedScore += result.weightedScore;

      switch (result.outcome) {
        case 'PASS':
          passedCount++;
          break;
        case 'FAIL':
          failedCount++;
          break;
        case 'SKIP':
          skippedCount++;
          break;
        case 'ERROR':
          erroredCount++;
          break;
      }
    }

    const percentageScore =
      maxWeightedScore > 0 ? (totalWeightedScore / maxWeightedScore) * 100 : 0;

    return {
      totalScore,
      maxScore,
      totalWeightedScore,
      maxWeightedScore,
      percentageScore,
      passedCount,
      failedCount,
      skippedCount,
      erroredCount,
      totalCount: taskResults.length,
    };
  }

  /**
   * Derives the overall classification from task results and scoring.
   */
  private deriveClassification(
    taskResults: KibanaEvalTaskResult[],
    scoring: KibanaEvalScoring,
  ): KibanaEvalClassification {
    // Check for critical failures
    const hasCriticalFailure = taskResults.some(
      (r) =>
        r.task.severity === 'CRITICAL' &&
        (r.outcome === 'FAIL' || r.outcome === 'ERROR'),
    );

    if (hasCriticalFailure) {
      return 'FAIL';
    }

    // All critical tasks passed — check score threshold
    if (scoring.percentageScore >= this.evalConfig.passThreshold) {
      return 'PASS';
    }

    return 'PARTIAL';
  }

  /**
   * Generates a human-readable summary for the evaluation report.
   */
  private generateSummary(
    modelId: string,
    classification: KibanaEvalClassification,
    scoring: KibanaEvalScoring,
    failedTasks: KibanaEvalTaskResult[],
  ): string {
    switch (classification) {
      case 'PASS':
        return `Model ${modelId} PASSED Kibana Agent builder evaluation with a score of ${scoring.percentageScore.toFixed(1)}%. All ${scoring.passedCount} tasks passed successfully.`;

      case 'PARTIAL':
        return `Model ${modelId} PARTIALLY PASSED Kibana Agent builder evaluation with a score of ${scoring.percentageScore.toFixed(1)}% (threshold: ${this.evalConfig.passThreshold}%). ${scoring.passedCount}/${scoring.totalCount} tasks passed. Failed: ${failedTasks.map((t) => t.task.name).join(', ')}.`;

      case 'FAIL': {
        const criticalFailures = failedTasks
          .filter((t) => t.task.severity === 'CRITICAL')
          .map((t) => t.task.name);
        return `Model ${modelId} FAILED Kibana Agent builder evaluation. Critical failures: ${criticalFailures.join(', ')}. Score: ${scoring.percentageScore.toFixed(1)}%.`;
      }
    }
  }

  // ─── Result Helpers ─────────────────────────────────────────────────────────

  private createPassResult(
    task: KibanaEvalTaskDefinition,
    message: string,
    metadata: Record<string, unknown>,
  ): Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'> {
    const weight = SEVERITY_WEIGHTS[task.severity];
    return {
      task,
      outcome: 'PASS',
      message,
      error: null,
      score: 1.0,
      weightedScore: weight,
      metadata,
    };
  }

  private createFailResult(
    task: KibanaEvalTaskDefinition,
    message: string,
    error: string,
    metadata: Record<string, unknown>,
  ): Omit<KibanaEvalTaskResult, 'durationMs' | 'attempts'> {
    return {
      task,
      outcome: 'FAIL',
      message,
      error,
      score: 0,
      weightedScore: 0,
      metadata,
    };
  }

  private createSkippedResult(
    task: KibanaEvalTaskDefinition,
    message: string,
  ): KibanaEvalTaskResult {
    return {
      task,
      outcome: 'SKIP',
      durationMs: 0,
      message,
      error: null,
      score: 0,
      weightedScore: 0,
      attempts: 0,
      metadata: {},
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
