import type { PipelineRun, HFCardResult, Stage1Result, Stage2Result } from '../scheduler/pipeline-state.js';
import type { TraceSummary } from './trace-query-builder.js';

export interface ReasoningPromptBuilder {
  build(opts: {
    pipelineRun: PipelineRun;
    vllmConfig: HFCardResult | undefined;
    stage1Result: Stage1Result | undefined;
    stage2Result: Stage2Result | undefined;
    traceSummary: TraceSummary | undefined;
  }): string;
}

const MAX_PROMPT_LENGTH = 32_000;
const MAX_TOP_ERRORS = 5;
const MAX_TRACE_OPS = 10;
const MAX_RAW_OUTPUT_LENGTH = 2_000;

export class ReasoningPromptBuilderImpl implements ReasoningPromptBuilder {
  build(opts: {
    pipelineRun: PipelineRun;
    vllmConfig: HFCardResult | undefined;
    stage1Result: Stage1Result | undefined;
    stage2Result: Stage2Result | undefined;
    traceSummary: TraceSummary;
  }): string {
    const sections: string[] = [];

    sections.push(this.buildModelSection(opts.pipelineRun, opts.vllmConfig));
    sections.push(this.buildVllmConfigSection(opts.vllmConfig));
    sections.push(this.buildStage1Section(opts.stage1Result));
    sections.push(this.buildStage2Section(opts.stage2Result));
    sections.push(this.buildTraceSection(opts.traceSummary));
    sections.push(this.buildInstructionsSection());

    let prompt = sections.join('\n\n');

    if (prompt.length > MAX_PROMPT_LENGTH) {
      prompt = this.truncatePrompt(prompt, opts.stage1Result, opts.traceSummary);
    }

    return prompt;
  }

  private buildModelSection(pipelineRun: PipelineRun, vllmConfig: HFCardResult | undefined): string {
    const modelId = pipelineRun.modelId;
    const architecture = vllmConfig?.architecture ?? 'Unknown';
    const contextLength = vllmConfig?.contextLength ?? 'Unknown';
    const quantization = vllmConfig?.quantization?.join(', ') ?? 'Unknown';
    const tensorParallel = vllmConfig?.tensorParallelSize ?? 'Unknown';
    const gpuMemory = vllmConfig?.gpuMemoryRequired ?? 'Unknown';

    return `## Model Information
- Model ID: ${modelId}
- Architecture: ${architecture}
- Context Length: ${contextLength}
- Quantization: ${quantization}
- Tensor Parallel: ${tensorParallel}
- GPU Memory Required: ${gpuMemory} GB`;
  }

  private buildVllmConfigSection(vllmConfig: HFCardResult | undefined): string {
    const flags = vllmConfig?.vllmFlags?.join(', ') ?? 'None';
    const maxModelLen = vllmConfig?.maxModelLen ?? 'Default';
    const tensorParallelSize = vllmConfig?.tensorParallelSize ?? 'Default';

    return `## vLLM Deployment Configuration
- Flags used: ${flags}
- max_model_len: ${maxModelLen}
- tensor_parallel_size: ${tensorParallelSize}`;
  }

  private buildStage1Section(stage1Result: Stage1Result | undefined): string {
    if (!stage1Result) {
      return `## Stage 1 Benchmark Results
No Stage 1 benchmark results available.`;
    }

    const lines: string[] = [`## Stage 1 Benchmark Results`];
    lines.push(`- Status: ${stage1Result.status}`);

    if (stage1Result.metrics) {
      lines.push(`- ITL p50: ${stage1Result.metrics.itl_p50_ms} ms`);
      lines.push(`- ITL p99: ${stage1Result.metrics.itl_p99_ms} ms`);
      lines.push(`- TTFT: ${stage1Result.metrics.ttft_ms} ms`);
      lines.push(`- Throughput: ${stage1Result.metrics.throughput_tps} tps`);
      lines.push(`- Duration: ${stage1Result.metrics.duration_sec} sec`);
    } else {
      lines.push(`- Metrics: No metrics collected`);
    }

    if (stage1Result.error) {
      lines.push(`- Error: ${stage1Result.error}`);
    }

    const rawOutput = stage1Result.rawOutput;
    if (rawOutput && rawOutput.length > 0) {
      const truncated = rawOutput.length > MAX_RAW_OUTPUT_LENGTH
        ? rawOutput.slice(0, MAX_RAW_OUTPUT_LENGTH) + '\n... [truncated]'
        : rawOutput;
      lines.push(`- Raw Output:\n\`\`\`\n${truncated}\n\`\`\``);
    }

    return lines.join('\n');
  }

  private buildStage2Section(stage2Result: Stage2Result | undefined): string {
    if (!stage2Result) {
      return `## Stage 2 Evaluation Results
Stage 2 was not run.`;
    }

    const lines: string[] = [`## Stage 2 Evaluation Results`];
    lines.push(`- Status: ${stage2Result.status}`);

    if (stage2Result.scores && Object.keys(stage2Result.scores).length > 0) {
      lines.push(`- Overall Scores:`);
      for (const [key, value] of Object.entries(stage2Result.scores)) {
        lines.push(`  - ${key}: ${value}`);
      }
    }

    if (stage2Result.suiteResults && stage2Result.suiteResults.length > 0) {
      lines.push(`- Suite Results:`);
      for (const suite of stage2Result.suiteResults) {
        const scoreStr = suite.score !== undefined ? ` (score: ${suite.score})` : '';
        const errorStr = suite.error ? ` [error: ${suite.error}]` : '';
        lines.push(`  - ${suite.suite}: ${suite.status}${scoreStr}${errorStr}`);
      }

      const passCount = stage2Result.suiteResults.filter((s) => s.status === 'success' || s.status === 'passed').length;
      const failCount = stage2Result.suiteResults.filter((s) => s.status === 'failed' || s.status === 'error').length;
      lines.push(`- Pass/Fail Count: ${passCount} passed, ${failCount} failed`);
    }

    if (stage2Result.reason) {
      lines.push(`- Reason: ${stage2Result.reason}`);
    }

    return lines.join('\n');
  }

  private buildTraceSection(traceSummary: TraceSummary): string {
    const lines: string[] = [`## Trace Analysis`];
    lines.push(`- Total spans: ${traceSummary.totalSpans}`);
    lines.push(`- Error count: ${traceSummary.errorCount}`);

    const topErrors = traceSummary.topErrors.slice(0, MAX_TOP_ERRORS);
    if (topErrors.length > 0) {
      lines.push(`- Top errors:`);
      for (const err of topErrors) {
        lines.push(`  - ${err.operation}: ${err.count} occurrences — ${err.sampleMessage}`);
      }
    } else {
      lines.push(`- Top errors: None`);
    }

    lines.push(`- Latency percentiles:`);
    lines.push(`  - p50: ${traceSummary.latencyPercentiles.p50_ms.toFixed(2)} ms`);
    lines.push(`  - p95: ${traceSummary.latencyPercentiles.p95_ms.toFixed(2)} ms`);
    lines.push(`  - p99: ${traceSummary.latencyPercentiles.p99_ms.toFixed(2)} ms`);

    const ops = traceSummary.operations.slice(0, MAX_TRACE_OPS);
    if (ops.length > 0) {
      lines.push(`- Operations (top ${ops.length}):`);
      for (const op of ops) {
        lines.push(
          `  - ${op.name}: count=${op.count}, avgDuration=${op.avgDurationMs.toFixed(2)} ms, errorRate=${(op.errorRate * 100).toFixed(1)}%`,
        );
      }
    } else {
      lines.push(`- Operations: None`);
    }

    return lines.join('\n');
  }

  private buildInstructionsSection(): string {
    return `## Instructions
You are a vLLM performance optimization expert. Analyze the results and suggest 1-3 concrete, actionable improvements.

Each suggestion must include:
- category: one of config | quantization | hardware | other
- title: a short, actionable title
- description: a clear explanation of what to change and why
- estimatedImpact: one of high | medium | low

Return your response as valid JSON matching this schema:
\`\`\`json
{
  "suggestions": [
    {
      "category": "config",
      "title": "...",
      "description": "...",
      "estimatedImpact": "high"
    }
  ]
}
\`\`\``;
  }

  private truncatePrompt(
    prompt: string,
    stage1Result: Stage1Result | undefined,
    traceSummary: TraceSummary | undefined,
  ): string {
    // First attempt: remove rawOutput from stage1
    if (stage1Result?.rawOutput && stage1Result.rawOutput.length > 0) {
      const rawOutputPattern = /- Raw Output:\s*```[\s\S]*?```/;
      prompt = prompt.replace(rawOutputPattern, '- Raw Output: [truncated for length]');
    }

    if (prompt.length <= MAX_PROMPT_LENGTH) {
      return prompt;
    }

    // Second attempt: limit trace operations further
    if (traceSummary?.operations && traceSummary.operations.length > 5) {
      const opsSectionMatch = prompt.match(/- Operations \(top \d+\):([\s\S]*?)(?=\n## |\n- [A-Z]|$)/);
      if (opsSectionMatch) {
        const limitedOps = traceSummary.operations.slice(0, 5);
        const newOpsLines = limitedOps.map(
          (op) =>
            `  - ${op.name}: count=${op.count}, avgDuration=${op.avgDurationMs.toFixed(2)} ms, errorRate=${(op.errorRate * 100).toFixed(1)}%`,
        );
        prompt = prompt.replace(opsSectionMatch[0], `- Operations (top 5):\n${newOpsLines.join('\n')}`);
      }
    }

    if (prompt.length <= MAX_PROMPT_LENGTH) {
      return prompt;
    }

    // Final fallback: hard truncate with a notice
    return prompt.slice(0, MAX_PROMPT_LENGTH - 50) + '\n\n[Additional data truncated to fit context window]';
  }
}
