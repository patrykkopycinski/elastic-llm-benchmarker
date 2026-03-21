---
name: benchmark-model
description: Benchmark OSS models via vLLM with autonomous config research, hardware/tool-calling/reasoning tests, and GitHub reporting
---

# Benchmark Model

Benchmark a specific OSS model on the GPU VM with comprehensive evaluation.

## When to Use

- User wants to benchmark a specific model
- User asks about model performance/capabilities
- User wants to evaluate tool calling or reasoning support

## Process

1. Extract model ID from user query
2. Call ConfigResearcherService to research optimal config
3. Add to priority queue
4. Stream progress as LangGraph processes
5. Show results with GitHub link

## Implementation

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Extract model ID (handle various formats)
let modelId = userQuery;
if (modelId.includes('llama')) modelId = 'meta-llama/Llama-3.3-70B-Instruct';
if (modelId.includes('qwen')) modelId = 'Qwen/Qwen2.5-72B-Instruct';
// Add more model aliases...

// Research config
const result = await execAsync(
  `cd elastic-llm-benchmarker && ` +
  `npx tsx src/cli.ts benchmark-model ${modelId} --wait`
);

// Parse and present results
console.log(result.stdout);
```

## Examples

**User:** "Benchmark Llama 3.3 70B"
**Agent:** Researches config, adds to queue, streams progress, shows results

**User:** "Test if Qwen 3 72B supports tool calling"
**Agent:** Benchmarks model, highlights tool calling results

**User:** "What's in the benchmark queue?"
**Agent:** Runs `queue-status` command, shows current queue
