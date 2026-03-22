#!/usr/bin/env node
/**
 * Imports benchmark results into Elasticsearch for Kibana dashboards.
 * Contains all historical benchmark data from the evaluation campaign.
 *
 * Run from repo root: npx tsx src/scripts/import-mock-benchmarks.ts
 * Or: npm run import-mock
 */

import { Client } from '@elastic/elasticsearch';
import type { BenchmarkResult, GpuUtilization } from '../types/benchmark.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { loadConfig } from '../config/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface MockRow {
  modelId: string;
  passed: boolean;
  timestamp: string;
  metrics: Record<
    number,
    { itlMs: number; ttftMs: number; throughputTokensPerSec: number; p99LatencyMs: number }
  >;
  toolCallResults: BenchmarkResult['toolCallResults'];
  rejectionReason?: string;
  gpuUtilization?: GpuUtilization;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const HW_2xA100 = {
  gpuType: 'nvidia-a100-80gb',
  gpuCount: 2,
  ramGb: 128,
  cpuCores: 16,
  diskGb: 400,
  machineType: 'a2-highgpu-2g',
  hardwareProfileId: '2xa100-80gb',
};

function estimateMetrics(
  itlMs: number,
  throughputC16: number,
  ttftBase?: number,
): MockRow['metrics'] {
  const ttft1 = ttftBase ?? itlMs * 8;
  return {
    1: {
      itlMs,
      ttftMs: ttft1,
      throughputTokensPerSec: Math.round(throughputC16 / 4),
      p99LatencyMs: Math.round(ttft1 * 1.5),
    },
    4: {
      itlMs: itlMs * 1.05,
      ttftMs: ttft1 * 1.2,
      throughputTokensPerSec: Math.round(throughputC16 / 2),
      p99LatencyMs: Math.round(ttft1 * 2.5),
    },
    16: {
      itlMs: itlMs * 1.15,
      ttftMs: ttft1 * 3,
      throughputTokensPerSec: throughputC16,
      p99LatencyMs: Math.round(ttft1 * 5),
    },
  };
}

function toolResult(
  successRate: number,
  latencyMs: number,
  parallel: boolean,
  maxConcurrent = parallel ? 4 : 1,
  totalTests = 50,
): BenchmarkResult['toolCallResults'] {
  return {
    supportsParallelCalls: parallel,
    maxConcurrentCalls: maxConcurrent,
    avgToolCallLatencyMs: latencyMs,
    successRate,
    totalTests,
  };
}

function gpuUtil(usedPerGpuGb: number, totalPerGpuGb = 80, gpuCount = 2): GpuUtilization {
  const vramUsedGb = Array(gpuCount).fill(usedPerGpuGb) as number[];
  const vramTotalGb = Array(gpuCount).fill(totalPerGpuGb) as number[];
  const totalUsed = usedPerGpuGb * gpuCount;
  const totalTotal = totalPerGpuGb * gpuCount;
  return {
    vramUsedGb,
    vramTotalGb,
    totalVramUsedGb: totalUsed,
    totalVramTotalGb: totalTotal,
    vramUtilizationPct: Math.round((totalUsed / totalTotal) * 10000) / 100,
    gpuUtilizationPct: Array(gpuCount).fill(Math.round(Math.random() * 30 + 10)) as number[],
  };
}

function crashed(modelId: string, reason: string, timestamp = '2026-01-23T08:00:00Z'): MockRow {
  return { modelId, passed: false, timestamp, metrics: {}, toolCallResults: null, rejectionReason: reason };
}

function rowToResult(row: MockRow): BenchmarkResult {
  const benchmarkMetrics = Object.entries(row.metrics).map(([level, m]) => ({
    itlMs: m.itlMs,
    ttftMs: m.ttftMs,
    throughputTokensPerSec: m.throughputTokensPerSec,
    p99LatencyMs: m.p99LatencyMs,
    concurrencyLevel: Number(level),
  }));

  return {
    modelId: row.modelId,
    timestamp: row.timestamp,
    vllmVersion: 'v0.15.1',
    dockerCommand: 'docker run ... (imported)',
    hardwareConfig: HW_2xA100,
    benchmarkMetrics,
    toolCallResults: row.toolCallResults,
    passed: row.passed,
    rejectionReasons: row.rejectionReason ? [row.rejectionReason] : [],
    tensorParallelSize: 2,
    toolCallParser: 'hermes',
    rawOutput: '',
    gpuUtilization: row.gpuUtilization ?? null,
  };
}

// ─── All benchmark results ──────────────────────────────────────────────────────

const ALL_MODELS: MockRow[] = [
  // ===== APPROVED MODELS (15) =====
  {
    modelId: 'Qwen/Qwen3-4B-Instruct-2507',
    passed: true, timestamp: '2026-01-24T14:00:00Z',
    metrics: estimateMetrics(3.2, 2110, 25),
    toolCallResults: toolResult(1.0, 605, true, 5),
    gpuUtilization: gpuUtil(5, 80),
  },
  {
    modelId: 'cyankiwi/Qwen3-Next-80B-A3B-Instruct-AWQ-4bit',
    passed: true, timestamp: '2026-01-25T10:00:00Z',
    metrics: estimateMetrics(8, 124, 80),
    toolCallResults: toolResult(1.0, 385, true, 4),
    gpuUtilization: gpuUtil(22, 80),
  },
  {
    modelId: 'AIDXteam/Qwen3-235B-A22B-Instruct-2507-AWQ',
    passed: true, timestamp: '2026-01-25T12:00:00Z',
    metrics: { 1: { itlMs: 15.4, ttftMs: 500, throughputTokensPerSec: 65, p99LatencyMs: 750 } },
    toolCallResults: toolResult(1.0, 645, true, 3),
    gpuUtilization: gpuUtil(68, 80),
  },
  {
    modelId: 'arcee-ai/Trinity-Nano-Preview',
    passed: true, timestamp: '2026-01-24T16:00:00Z',
    metrics: estimateMetrics(5.8, 1361, 40),
    toolCallResults: toolResult(1.0, 777, true, 4),
    gpuUtilization: gpuUtil(4, 80),
  },
  {
    modelId: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
    passed: true, timestamp: '2026-01-23T10:00:00Z',
    metrics: {
      1: { itlMs: 6.5, ttftMs: 32, throughputTokensPerSec: 322, p99LatencyMs: 48 },
      4: { itlMs: 6.5, ttftMs: 35, throughputTokensPerSec: 645, p99LatencyMs: 53 },
      16: { itlMs: 6.5, ttftMs: 40, throughputTokensPerSec: 1288, p99LatencyMs: 60 },
    },
    toolCallResults: toolResult(1.0, 800, true, 5, 50),
    gpuUtilization: gpuUtil(20, 80),
  },
  {
    modelId: 'mistralai/Devstral-Small-2-24B-Instruct-2512',
    passed: true, timestamp: '2026-01-23T11:00:00Z',
    metrics: {
      1: { itlMs: 10.3, ttftMs: 45, throughputTokensPerSec: 333, p99LatencyMs: 68 },
      4: { itlMs: 10.3, ttftMs: 50, throughputTokensPerSec: 667, p99LatencyMs: 75 },
      16: { itlMs: 10.3, ttftMs: 55, throughputTokensPerSec: 1335, p99LatencyMs: 83 },
    },
    toolCallResults: toolResult(1.0, 700, true, 5, 50),
    gpuUtilization: gpuUtil(28, 80),
  },
  {
    modelId: 'mistralai/Ministral-3-14B-Instruct-2512',
    passed: true, timestamp: '2026-01-23T12:00:00Z',
    metrics: {
      1: { itlMs: 10.8, ttftMs: 46, throughputTokensPerSec: 91, p99LatencyMs: 69 },
      4: { itlMs: 11.0, ttftMs: 35, throughputTokensPerSec: 335, p99LatencyMs: 53 },
      16: { itlMs: 11.6, ttftMs: 54, throughputTokensPerSec: 1246, p99LatencyMs: 81 },
    },
    toolCallResults: toolResult(1.0, 734, true, 4, 50),
    gpuUtilization: gpuUtil(16, 80),
  },
  {
    modelId: 'nvidia/Llama-3.1-Nemotron-Nano-8B-v1',
    passed: true, timestamp: '2026-01-24T13:00:00Z',
    metrics: estimateMetrics(10.8, 1255, 50),
    toolCallResults: toolResult(1.0, 1010, true, 3),
    gpuUtilization: gpuUtil(10, 80),
  },
  {
    modelId: 'NousResearch/Hermes-3-Llama-3.1-8B',
    passed: true, timestamp: '2026-01-24T15:00:00Z',
    metrics: estimateMetrics(10.8, 1264, 50),
    toolCallResults: toolResult(1.0, 925, true, 4),
    gpuUtilization: gpuUtil(10, 80),
  },
  {
    modelId: 'Salesforce/Llama-xLAM-2-8b-fc-r',
    passed: true, timestamp: '2026-01-24T17:00:00Z',
    metrics: estimateMetrics(10.8, 1255, 50),
    toolCallResults: toolResult(1.0, 887, true, 3),
    gpuUtilization: gpuUtil(10, 80),
  },
  {
    modelId: 'mistralai/Mistral-Nemo-Instruct-2407',
    passed: true, timestamp: '2026-01-24T18:00:00Z',
    metrics: {
      1: { itlMs: 16.1, ttftMs: 40, throughputTokensPerSec: 216, p99LatencyMs: 60 },
      4: { itlMs: 16.1, ttftMs: 45, throughputTokensPerSec: 432, p99LatencyMs: 68 },
      16: { itlMs: 16.1, ttftMs: 55, throughputTokensPerSec: 864, p99LatencyMs: 83 },
    },
    toolCallResults: toolResult(1.0, 1160, true, 3),
    gpuUtilization: gpuUtil(14, 80),
  },
  {
    modelId: 'zai-org/GLM-4.7-Flash',
    passed: true, timestamp: '2026-01-23T14:00:00Z',
    metrics: { 16: { itlMs: 23.7, ttftMs: 377, throughputTokensPerSec: 750, p99LatencyMs: 566 } },
    toolCallResults: toolResult(1.0, 1507, true, 3, 5),
    gpuUtilization: gpuUtil(6, 80),
  },
  {
    modelId: 'casperhansen/llama-3.3-70b-instruct-awq',
    passed: true, timestamp: '2026-01-23T15:00:00Z',
    metrics: {
      1: { itlMs: 17.6, ttftMs: 110, throughputTokensPerSec: 55, p99LatencyMs: 165 },
      4: { itlMs: 17.9, ttftMs: 61, throughputTokensPerSec: 206, p99LatencyMs: 92 },
      16: { itlMs: 19.9, ttftMs: 137, throughputTokensPerSec: 717, p99LatencyMs: 206 },
    },
    toolCallResults: toolResult(0.0, 789, false, 1),
    gpuUtilization: gpuUtil(38, 80),
  },
  {
    modelId: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
    passed: true, timestamp: '2026-01-23T09:00:00Z',
    metrics: {
      1: { itlMs: 16.6, ttftMs: 27, throughputTokensPerSec: 168, p99LatencyMs: 41 },
      4: { itlMs: 16.6, ttftMs: 35, throughputTokensPerSec: 335, p99LatencyMs: 53 },
      16: { itlMs: 16.6, ttftMs: 45, throughputTokensPerSec: 671, p99LatencyMs: 68 },
    },
    toolCallResults: toolResult(1.0, 887, true, 4),
    gpuUtilization: gpuUtil(28, 80),
  },
  {
    modelId: 'Qwen/Qwen2.5-32B-Instruct',
    passed: true, timestamp: '2026-01-22T10:00:00Z',
    metrics: {
      1: { itlMs: 23.4, ttftMs: 53, throughputTokensPerSec: 149, p99LatencyMs: 80 },
      4: { itlMs: 23.4, ttftMs: 60, throughputTokensPerSec: 298, p99LatencyMs: 90 },
      16: { itlMs: 23.4, ttftMs: 75, throughputTokensPerSec: 595, p99LatencyMs: 113 },
    },
    toolCallResults: toolResult(1.0, 1478, true, 4),
    gpuUtilization: gpuUtil(35, 80),
  },

  // ===== CONDITIONAL MODELS (6) =====
  {
    modelId: 'ai21labs/AI21-Jamba2-3B',
    passed: true, timestamp: '2026-01-24T19:00:00Z',
    metrics: estimateMetrics(6.4, 1024, 35),
    toolCallResults: toolResult(1.0, 857, true, 3),
    gpuUtilization: gpuUtil(4, 80),
  },
  {
    modelId: 'ai21labs/AI21-Jamba-Reasoning-3B',
    passed: true, timestamp: '2026-01-24T19:30:00Z',
    metrics: estimateMetrics(6.4, 1027, 35),
    toolCallResults: toolResult(1.0, 3705, true, 3),
    gpuUtilization: gpuUtil(4, 80),
  },
  {
    modelId: 'Alibaba-NLP/Tongyi-DeepResearch-30B-A3B',
    passed: true, timestamp: '2026-01-23T16:00:00Z',
    metrics: estimateMetrics(6.5, 1240, 35),
    toolCallResults: toolResult(1.0, 1910, true, 3),
    gpuUtilization: gpuUtil(20, 80),
  },
  {
    modelId: 'Qwen/Qwen3-4B-Thinking-2507',
    passed: true, timestamp: '2026-01-24T20:00:00Z',
    metrics: estimateMetrics(6.9, 1855, 30),
    toolCallResults: toolResult(1.0, 2325, true, 3),
    gpuUtilization: gpuUtil(5, 80),
  },
  {
    modelId: 'openbmb/AgentCPM-Explore',
    passed: true, timestamp: '2026-01-24T20:30:00Z',
    metrics: estimateMetrics(6.9, 1858, 30),
    toolCallResults: toolResult(0.5, 1485, false, 1),
    gpuUtilization: gpuUtil(10, 80),
  },
  {
    modelId: 'Qwen/Qwen2.5-72B-Instruct',
    passed: true, timestamp: '2026-01-22T12:00:00Z',
    metrics: {
      1: { itlMs: 48, ttftMs: 91, throughputTokensPerSec: 79, p99LatencyMs: 137 },
      4: { itlMs: 48, ttftMs: 100, throughputTokensPerSec: 158, p99LatencyMs: 150 },
      16: { itlMs: 48, ttftMs: 120, throughputTokensPerSec: 316, p99LatencyMs: 180 },
    },
    toolCallResults: toolResult(1.0, 2758, true, 4),
    gpuUtilization: gpuUtil(72, 80),
  },

  // ===== REJECTED - No Tool Calling (with benchmark data) =====
  {
    modelId: 'LiquidAI/LFM2.5-1.2B-Instruct',
    passed: false, timestamp: '2026-01-24T10:00:00Z',
    metrics: estimateMetrics(2.3, 4859, 15),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
    gpuUtilization: gpuUtil(2, 80),
  },
  {
    modelId: 'openai/gpt-oss-20b',
    passed: false, timestamp: '2026-01-23T17:00:00Z',
    metrics: {
      1: { itlMs: 4.3, ttftMs: 30, throughputTokensPerSec: 223, p99LatencyMs: 45 },
      4: { itlMs: 5.8, ttftMs: 41, throughputTokensPerSec: 612, p99LatencyMs: 62 },
      16: { itlMs: 8.4, ttftMs: 70, throughputTokensPerSec: 1675, p99LatencyMs: 105 },
    },
    toolCallResults: toolResult(0.4, 800, false, 1, 5),
    rejectionReason: 'Sequential tool calling only',
    gpuUtilization: gpuUtil(24, 80),
  },
  {
    modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    passed: false, timestamp: '2026-01-23T18:00:00Z',
    metrics: {
      1: { itlMs: 4.6, ttftMs: 30, throughputTokensPerSec: 205, p99LatencyMs: 45 },
      4: { itlMs: 4.6, ttftMs: 35, throughputTokensPerSec: 367, p99LatencyMs: 53 },
      16: { itlMs: 4.6, ttftMs: 50, throughputTokensPerSec: 99, p99LatencyMs: 75 },
    },
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
    gpuUtilization: gpuUtil(20, 80),
  },
  {
    modelId: 'microsoft/Phi-4-mini-instruct',
    passed: false, timestamp: '2026-01-24T11:00:00Z',
    metrics: estimateMetrics(6.3, 1887, 30),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
    gpuUtilization: gpuUtil(5, 80),
  },
  {
    modelId: 'QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ',
    passed: false, timestamp: '2026-01-24T11:30:00Z',
    metrics: estimateMetrics(6.6, 151, 50),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
    gpuUtilization: gpuUtil(9, 80),
  },
  {
    modelId: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    passed: false, timestamp: '2026-01-24T12:00:00Z',
    metrics: estimateMetrics(6.5, 1231, 35),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
    gpuUtilization: gpuUtil(20, 80),
  },
  {
    modelId: 'casperhansen/deepseek-r1-distill-llama-70b-awq',
    passed: false, timestamp: '2026-01-24T08:00:00Z',
    metrics: estimateMetrics(18, 55, 150),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (R1 reasoning)',
    gpuUtilization: gpuUtil(38, 80),
  },
  {
    modelId: 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    passed: false, timestamp: '2026-01-24T09:00:00Z',
    metrics: estimateMetrics(10.9, 1239, 50),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (R1 reasoning)',
    gpuUtilization: gpuUtil(10, 80),
  },
  {
    modelId: 'ibm-granite/granite-4.0-h-small',
    passed: false, timestamp: '2026-01-23T19:00:00Z',
    metrics: {
      1: { itlMs: 14.3, ttftMs: 60, throughputTokensPerSec: 93, p99LatencyMs: 90 },
      4: { itlMs: 24, ttftMs: 80, throughputTokensPerSec: 141, p99LatencyMs: 120 },
      16: { itlMs: 51.2, ttftMs: 150, throughputTokensPerSec: 93, p99LatencyMs: 225 },
    },
    toolCallResults: toolResult(1.0, 1232, true, 3),
    rejectionReason: 'Poor concurrency scaling',
    gpuUtilization: gpuUtil(10, 80),
  },
  {
    modelId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
    passed: false, timestamp: '2026-01-24T07:00:00Z',
    metrics: estimateMetrics(19.4, 800, 100),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (R1 reasoning)',
    gpuUtilization: gpuUtil(16, 80),
  },
  {
    modelId: 'deepseek-ai/DeepSeek-Coder-V2-Lite',
    passed: false, timestamp: '2026-01-23T20:00:00Z',
    metrics: estimateMetrics(22.8, 622, 120),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling',
    gpuUtilization: gpuUtil(18, 80),
  },
  {
    modelId: 'mistralai/Magistral-Small-2509',
    passed: false, timestamp: '2026-01-23T21:00:00Z',
    metrics: estimateMetrics(29.4, 470, 180),
    toolCallResults: toolResult(1.0, 1234, true, 3),
    rejectionReason: 'Too slow (29.4ms ITL)',
    gpuUtilization: gpuUtil(28, 80),
  },
  {
    modelId: 'tiiuae/Falcon-H1-34B-Instruct',
    passed: false, timestamp: '2026-01-23T22:00:00Z',
    metrics: estimateMetrics(44.9, 233, 250),
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'Very slow + no tool calling',
    gpuUtilization: gpuUtil(34, 80),
  },
  {
    modelId: 'arcee-ai/Trinity-Mini',
    passed: false, timestamp: '2026-01-24T21:00:00Z',
    metrics: estimateMetrics(6.7, 817, 40),
    toolCallResults: toolResult(1.0, 900, true, 3),
    rejectionReason: 'Too slow throughput',
    gpuUtilization: gpuUtil(2, 80),
  },
  {
    modelId: 'zai-org/GLM-4-32B-0414',
    passed: false, timestamp: '2026-01-22T08:00:00Z',
    metrics: {
      1: { itlMs: 24.9, ttftMs: 51, throughputTokensPerSec: 40, p99LatencyMs: 77 },
      4: { itlMs: 23.9, ttftMs: 71, throughputTokensPerSec: 155, p99LatencyMs: 107 },
      16: { itlMs: 23.9, ttftMs: 102, throughputTokensPerSec: 609, p99LatencyMs: 153 },
    },
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
    gpuUtilization: gpuUtil(35, 80),
  },
  {
    modelId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
    passed: false, timestamp: '2026-01-22T09:00:00Z',
    metrics: {
      1: { itlMs: 25.1, ttftMs: 116, throughputTokensPerSec: 39, p99LatencyMs: 174 },
      4: { itlMs: 23.4, ttftMs: 73, throughputTokensPerSec: 158, p99LatencyMs: 110 },
      16: { itlMs: 24.4, ttftMs: 105, throughputTokensPerSec: 598, p99LatencyMs: 158 },
    },
    toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling + very slow',
    gpuUtilization: gpuUtil(35, 80),
  },
  {
    modelId: 'microsoft/Phi-3-mini-128k-instruct',
    passed: false, timestamp: '2026-01-24T06:00:00Z',
    metrics: {}, toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
  },
  {
    modelId: 'THUDM/glm-4-9b-chat-1m',
    passed: false, timestamp: '2026-01-24T06:30:00Z',
    metrics: {}, toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'No tool calling (0%)',
  },
  {
    modelId: 'google/gemma-3-27b-it',
    passed: false, timestamp: '2026-01-23T13:00:00Z',
    metrics: {}, toolCallResults: toolResult(0.0, 0, false, 0, 5),
    rejectionReason: 'No tool calling + only 8K context',
  },
  {
    modelId: 'google/gemma-3-12b-it',
    passed: false, timestamp: '2026-01-23T13:30:00Z',
    metrics: {}, toolCallResults: toolResult(0.0, 0, false, 0, 5),
    rejectionReason: 'No tool calling + only 8K context',
  },
  {
    modelId: 'deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct',
    passed: false, timestamp: '2026-01-24T05:00:00Z',
    metrics: {}, toolCallResults: toolResult(0.0, 0, false, 0, 50),
    rejectionReason: 'Coder variant, no tool calling',
  },

  // ===== REJECTED - OOM / Too Large =====
  crashed('Qwen/Qwen3-235B-A22B-Instruct-2507-FP8', 'OOM even at 32K context (FP8)', '2026-01-25T08:00:00Z'),
  crashed('deepseek-ai/DeepSeek-V3-Base', 'Too large (671B params)', '2026-01-24T04:00:00Z'),
  crashed('deepseek-ai/DeepSeek-V3.2', 'Too large (685B params)', '2026-01-23T04:00:00Z'),
  crashed('MiniMaxAI/MiniMax-M1-40k', 'Too large (456B params)', '2026-01-23T03:00:00Z'),
  crashed('MiniMaxAI/MiniMax-Text-01-hf', 'Too large (456B params)', '2026-01-23T03:10:00Z'),
  crashed('MiniMaxAI/MiniMax-M2.1', 'Too large (228B params)', '2026-01-23T03:20:00Z'),
  crashed('XiaomiMiMo/MiMo-V2-Flash', 'Too large (309B params)', '2026-01-23T03:30:00Z'),
  crashed('Qwen/Qwen3-Next-80B-A3B-Instruct', 'OOM even with FP8', '2026-01-23T07:00:00Z'),
  crashed('meta-llama/Llama-3.3-70B-Instruct', 'Timeout loading (70B dense)', '2026-01-23T06:00:00Z'),
  crashed('moonshotai/Kimi-Linear-48B-A3B-Instruct', 'OOM (48B MoE)', '2026-01-23T05:00:00Z'),
  crashed('moonshotai/Kimi-K2-Instruct', 'Too large (1T params)', '2026-01-23T04:30:00Z'),
  crashed('moonshotai/Kimi-K2-Thinking', 'Too large (1T+ params)', '2026-01-23T04:40:00Z'),
  crashed('NousResearch/Hermes-4.3-36B', 'OOM (36B dense)', '2026-01-23T05:30:00Z'),
  crashed('ByteDance-Seed/Seed-OSS-36B-Instruct', 'OOM (36B dense)', '2026-01-24T03:00:00Z'),
  crashed('01-ai/Yi-34B-200K', 'OOM (34B dense)', '2026-01-24T03:30:00Z'),
  crashed('meta-llama/Llama-4-Scout-17B-16E-Instruct', 'OOM (MoE 17B/16E)', '2026-01-23T06:30:00Z'),
  crashed('meta-llama/Llama-4-Maverick-17B-128E-Instruct', 'OOM even with FP8 (128 experts)', '2026-01-23T06:40:00Z'),
  crashed('NousResearch/Meta-Llama-3.1-70B-Instruct', 'OOM (70B dense)', '2026-01-23T06:50:00Z'),
  crashed('zai-org/GLM-4.7', 'Too large (358B MoE)', '2026-01-23T04:50:00Z'),

  // ===== REJECTED - Gated / Access Required =====
  crashed('meta-llama/Llama-3.1-8B-Instruct', 'HuggingFace gated access required', '2026-01-24T02:00:00Z'),
  crashed('CohereForAI/c4ai-command-r-08-2024', 'HuggingFace gated access required', '2026-01-24T02:10:00Z'),
  crashed('google/gemma-3-4b-it', 'HuggingFace gated access required', '2026-01-24T02:20:00Z'),

  // ===== REJECTED - vLLM Architecture Issues =====
  crashed('LGAI-EXAONE/K-EXAONE-236B-A23B', 'vLLM architecture not supported', '2026-01-24T01:00:00Z'),
  crashed('cerebras/GLM-4.7-Flash-REAP-23B-A3B', 'vLLM architecture issue', '2026-01-24T01:10:00Z'),

  // ===== REJECTED - Insufficient Context <128K =====
  crashed('Qwen/Qwen3-32B', 'Context too small (41K < 128K)', '2026-01-24T00:00:00Z'),
  crashed('Qwen/Qwen3-8B', 'Context too small (41K < 128K)', '2026-01-24T00:01:00Z'),
  crashed('Qwen/Qwen2.5-14B-Instruct', 'Context too small (32K < 128K)', '2026-01-24T00:02:00Z'),
  crashed('Qwen/Qwen2.5-72B-Instruct-AWQ', 'Context too small (32K < 128K)', '2026-01-24T00:03:00Z'),
  crashed('Qwen/Qwen2.5-Coder-32B-Instruct', 'Context too small (32K < 128K)', '2026-01-24T00:04:00Z'),
  crashed('kakaocorp/kanana-2-30b-a3b-instruct-2601', 'Context too small (32K < 128K)', '2026-01-24T00:05:00Z'),
  crashed('mistralai/Mistral-7B-Instruct-v0.2', 'Context too small (32K < 128K)', '2026-01-24T00:06:00Z'),
  crashed('mistralai/Mistral-Small-24B-Instruct-2501', 'Context too small (33K < 128K)', '2026-01-24T00:07:00Z'),
  crashed('stelterlab/Mistral-Small-24B-Instruct-2501-AWQ', 'Context too small (32K < 128K)', '2026-01-24T00:08:00Z'),
  crashed('mistralai/Codestral-22B-v0.1', 'Context too small (33K < 128K)', '2026-01-24T00:09:00Z'),
  crashed('nvidia/Nemotron-Orchestrator-8B', 'Context too small (41K < 128K)', '2026-01-24T00:10:00Z'),
  crashed('nvidia/Nemotron-Cascade-14B-Thinking', 'Context too small (32K < 128K)', '2026-01-24T00:11:00Z'),
  crashed('internlm/internlm2-chat-20b', 'Context too small (32K < 128K)', '2026-01-24T00:12:00Z'),
  crashed('google/gemma-3-1b-it', 'Context too small (33K < 128K)', '2026-01-24T00:13:00Z'),
  crashed('google/gemma-2-9b-it', 'Context too small (8K < 128K)', '2026-01-24T00:14:00Z'),
  crashed('google/gemma-2-27b-it', 'Context too small (8K < 128K)', '2026-01-24T00:15:00Z'),
  crashed('google/functiongemma-270m-it', 'Context too small (33K < 128K)', '2026-01-24T00:16:00Z'),
  crashed('HuggingFaceTB/SmolLM2-1.7B-Instruct', 'Context too small (8K < 128K)', '2026-01-24T00:17:00Z'),
  crashed('HuggingFaceTB/SmolLM3-3B', 'Context too small (66K < 128K)', '2026-01-24T00:18:00Z'),
  crashed('NousResearch/Hermes-4-14B', 'Context too small (41K < 128K)', '2026-01-24T00:19:00Z'),
  crashed('allenai/Olmo-3.1-32B-Instruct', 'Context too small (66K < 128K)', '2026-01-24T00:20:00Z'),
  crashed('allenai/OLMo-2-1124-13B-Instruct', 'Context too small (4K < 128K)', '2026-01-24T00:21:00Z'),
  crashed('stabilityai/stablelm-2-zephyr-1_6b', 'Context too small (4K < 128K)', '2026-01-24T00:22:00Z'),
  crashed('microsoft/Phi-4', 'Context too small (16K < 128K)', '2026-01-24T00:23:00Z'),
  crashed('LGAI-EXAONE/EXAONE-3.5-2.4B-Instruct', 'Context too small (33K < 128K)', '2026-01-24T00:24:00Z'),
  crashed('tencent/Hunyuan-A13B-Instruct', 'Context too small (33K < 128K)', '2026-01-24T00:25:00Z'),
];

// ─── Main ───────────────────────────────────────────────────────────────────────

function createEsClient(config: ReturnType<typeof loadConfig>): Client {
  const es = config.elasticsearch;
  if (es.cloudId) {
    return new Client({
      cloud: { id: es.cloudId },
      ...(es.apiKey ? { auth: { apiKey: es.apiKey } } : {}),
      ...(es.username && es.password ? { auth: { username: es.username, password: es.password } } : {}),
    });
  }
  return new Client({
    node: es.url,
    ...(es.apiKey ? { auth: { apiKey: es.apiKey } } : {}),
    ...(es.username && es.password ? { auth: { username: es.username, password: es.password } } : {}),
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const esClient = createEsClient(config);
  const store = new ElasticsearchResultsStore(esClient);
  await store.initialize();

  const results: BenchmarkResult[] = ALL_MODELS.map(rowToResult);
  let imported = 0;

  for (const result of results) {
    try {
      await store.save(result);
      imported++;
    } catch (err) {
      console.error(`Failed to import ${result.modelId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`Imported ${imported}/${results.length} benchmark results into Elasticsearch`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
