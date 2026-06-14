import type { Logger } from 'winston';
import type { PipelineRun, Stage3Result, Stage3Suggestion } from '../scheduler/pipeline-state.js';
import type { AppConfig } from '../types/config.js';
import type { TraceQueryBuilder, TraceSummary } from '../services/trace-query-builder.js';
import type { ReasoningPromptBuilder } from '../services/reasoning-prompt-builder.js';
import type { LlmClient } from '../services/llm-client.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';

export interface Stage3Worker {
  execute(run: PipelineRun): Promise<Stage3Result>;
}

export interface Stage3WorkerDependencies {
  config: AppConfig;
  traceQueryBuilder: TraceQueryBuilder;
  promptBuilder: ReasoningPromptBuilder;
  llmClient: LlmClient;
  resultsStore: ElasticsearchResultsStore;
  logger?: Logger;
}

export class Stage3WorkerImpl implements Stage3Worker {
  private readonly deps: Stage3WorkerDependencies;

  constructor(deps: Stage3WorkerDependencies) {
    this.deps = deps;
  }

  async execute(run: PipelineRun): Promise<Stage3Result> {
    const startedAt = new Date().toISOString();
    try {
      const modelId = run.modelId;
      const runId = run.runId;
      const stage1Result = run.benchmarkResult;
      const stage2Result = run.stage2Result;
      const vllmConfig = run.hfCard;

      const timeRange = {
        from: run.startedAt,
        to: run.completedAt || new Date().toISOString(),
      };

      let traceSummary: TraceSummary | undefined;
      try {
        traceSummary = await this.deps.traceQueryBuilder.buildSummary(modelId, runId, timeRange);
      } catch {
        traceSummary = undefined;
      }

      const prompt = this.deps.promptBuilder.build({
        pipelineRun: run,
        vllmConfig,
        stage1Result,
        stage2Result,
        traceSummary,
      });

      const systemPrompt = 'You are a vLLM performance optimization expert. Return ONLY valid JSON.';
      const llmResponse = await this.deps.llmClient.complete({
        systemPrompt,
        userPrompt: prompt,
        responseFormat: 'json',
      });

      let suggestions: Stage3Suggestion[] | undefined;
      try {
        const parsed = JSON.parse(this.extractJson(llmResponse.content));
        suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : undefined;
        if (suggestions) {
          suggestions = suggestions.map((s: any) => ({
            category: ['config', 'quantization', 'hardware', 'other'].includes(s.category)
              ? s.category
              : 'other',
            title: String(s.title || ''),
            description: String(s.description || ''),
            estimatedImpact: ['high', 'medium', 'low'].includes(s.estimatedImpact)
              ? s.estimatedImpact
              : 'medium',
          }));
        }
      } catch {
        suggestions = undefined;
      }

      const result: Stage3Result = {
        runId,
        modelId,
        status: 'success',
        suggestions,
        traceSummary,
        rawResponse: llmResponse.content,
        startedAt,
        completedAt: new Date().toISOString(),
      };

      try {
        await this.deps.resultsStore.saveReasoningResult(result);
      } catch {
        /* ignore */
      }

      return result;
    } catch (error) {
      return {
        runId: run.runId,
        modelId: run.modelId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  private extractJson(content: string): string {
    const trimmed = content.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      return fenceMatch[1]!.trim();
    }
    return trimmed;
  }
}
