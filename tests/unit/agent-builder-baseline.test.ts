import { describe, it, expect } from 'vitest';
import {
  enrichModelInfoFromHfConfig,
  extractContextWindowFromHfConfig,
  estimateParameterCountFromHfConfig,
  inferToolCallingSupport,
  normalizeParameterCount,
} from '../../src/services/agent-builder-baseline.js';
import { resolveMaxITLMs, resolveMaxItlP50Ms } from '../../src/types/config.js';
import type { BenchmarkThresholds, Stage2Thresholds } from '../../src/types/config.js';
import type { ModelInfo } from '../../src/types/benchmark.js';

describe('agent-builder-baseline enrich', () => {
  it('extracts 128K+ context from rope_scaling in config.json', () => {
    const window = extractContextWindowFromHfConfig({
      max_position_embeddings: 32768,
      rope_scaling: { factor: 4, original_max_position_embeddings: 32768 },
    });
    expect(window).toBe(131072);
  });

  it('estimates parameter count from model id when config lacks num_parameters', () => {
    const count = estimateParameterCountFromHfConfig('Qwen/Qwen2.5-7B-Instruct', {});
    expect(count).toBe(7_000_000_000);
  });

  it('infers tool calling for instruct Qwen models', () => {
    const model: ModelInfo = {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      name: 'Qwen2.5-7B-Instruct',
      architecture: 'qwen2',
      contextWindow: 32768,
      license: 'apache-2.0',
      parameterCount: null,
      quantizations: ['fp16'],
      supportsToolCalling: false,
    };
    expect(inferToolCallingSupport(model)).toBe(true);
  });

  it('normalizes billions from HF card parser into raw parameter count', () => {
    expect(normalizeParameterCount(7)).toBe(7_000_000_000);
    expect(normalizeParameterCount(7_000_000_000)).toBe(7_000_000_000);
    expect(normalizeParameterCount(null)).toBeNull();
  });

  it('enriches incomplete card metadata from config.json', () => {
    const model: ModelInfo = {
      id: 'Qwen/Qwen2.5-7B-Instruct',
      name: 'Qwen2.5-7B-Instruct',
      architecture: 'qwen2',
      contextWindow: 32768,
      license: 'apache-2.0',
      parameterCount: null,
      quantizations: ['fp16'],
      supportsToolCalling: false,
    };

    const enriched = enrichModelInfoFromHfConfig(model, {
      model_type: 'qwen2',
      max_position_embeddings: 32768,
      rope_scaling: { factor: 4, original_max_position_embeddings: 32768 },
    });

    expect(enriched.contextWindow).toBeGreaterThanOrEqual(128_000);
    expect(enriched.parameterCount).toBe(7_000_000_000);
    expect(enriched.supportsToolCalling).toBe(true);
  });
});

// Regression: Stage 1 built ModelInfo.parameterCount straight from the HF card
// (billions, e.g. 34.67), skipping normalizeParameterCount. The tiered-ITL resolver
// then computed `paramBillions = parameterCount / 1e9` ≈ 3.5e-8, collapsing every
// model to the smallest tier (20ms). A 34.67B model measured at 25.83ms ITL was
// wrongly rejected when its correct tier (≤40B) allows 40ms. Guards the composed
// card→normalize→/1e9→tier data flow, not just the resolver in isolation.
describe('tiered ITL resolution over the Stage 1 param-count data flow', () => {
  const thresholds = {
    maxITLMs: 20,
    maxITLMsTiers: [
      { maxParamsBillions: 14, maxITLMs: 20 },
      { maxParamsBillions: 40, maxITLMs: 40 },
      { maxParamsBillions: 80, maxITLMs: 60 },
      { maxParamsBillions: Infinity, maxITLMs: 100 },
    ],
  } as unknown as BenchmarkThresholds;

  // Mirrors stage1-worker: card billions → normalize (raw) → back to billions.
  const paramBillionsFromCard = (cardBillions: number): number =>
    (normalizeParameterCount(cardBillions) ?? 0) / 1_000_000_000;

  it('resolves a 34.67B model to the 40ms tier (not the 20ms floor)', () => {
    const paramBillions = paramBillionsFromCard(34.668544);
    const maxITL = resolveMaxITLMs(thresholds, paramBillions);
    expect(maxITL).toBe(40);
    // The observed ITL@c1 for Qwen2.5-32B was 25.83ms — must pass at its tier.
    expect(25.83).toBeLessThan(maxITL);
  });

  it('keeps small (≤14B) models on the strict 20ms tier', () => {
    expect(resolveMaxITLMs(thresholds, paramBillionsFromCard(7))).toBe(20);
  });

  it('falls back to the flat threshold when param count is unknown', () => {
    expect(resolveMaxITLMs(thresholds, null)).toBe(20);
  });

  it('would (pre-fix) mis-resolve to 20ms if billions are not normalized', () => {
    // Demonstrates the bug: dividing card-billions by 1e9 without normalize.
    const buggyBillions = 34.668544 / 1_000_000_000;
    expect(resolveMaxITLMs(thresholds, buggyBillions)).toBe(20);
  });
});

// Stage 2 (CI-eval eligibility) ITL p50 cap is a separate flat-20ms gate that
// previously excluded every 14B+ model. It now mirrors the Stage 1 tiers, so a
// model that passes Stage 1 at its tier is also eligible for Stage 2.
describe('resolveMaxItlP50Ms (Stage 2 CI-eval eligibility tiers)', () => {
  const stage2Thresholds = {
    maxItlP50Ms: 20,
    maxItlP50MsTiers: [
      { maxParamsBillions: 14, maxITLMs: 20 },
      { maxParamsBillions: 40, maxITLMs: 40 },
      { maxParamsBillions: 80, maxITLMs: 60 },
      { maxParamsBillions: Infinity, maxITLMs: 100 },
    ],
    minThroughputTps: 10,
    maxTtftMs: 5000,
    minContextWindow: 128_000,
  } as unknown as Stage2Thresholds;

  it('lets a ~32B model qualify at the 40ms tier (was rejected at flat 20ms)', () => {
    const maxItl = resolveMaxItlP50Ms(stage2Thresholds, 34.668544);
    expect(maxItl).toBe(40);
    // Avg ITL p50 across concurrency for Qwen2.5-32B was 25.73ms — eligible now.
    expect(25.73).toBeLessThan(maxItl);
  });

  it('keeps small (≤14B) models on the strict 20ms eligibility gate', () => {
    expect(resolveMaxItlP50Ms(stage2Thresholds, 7)).toBe(20);
  });

  it('falls back to the flat cap when param count is unknown', () => {
    expect(resolveMaxItlP50Ms(stage2Thresholds, null)).toBe(20);
  });

  it('applies the top tier for very large (>80B) models', () => {
    expect(resolveMaxItlP50Ms(stage2Thresholds, 120)).toBe(100);
  });

  it('falls back to the flat cap when tiers are missing (hand-built config)', () => {
    // Guards the "tiers is not iterable" regression: mocks/configs that omit
    // maxItlP50MsTiers must not throw — they resolve to the flat cap.
    const noTiers = { maxItlP50Ms: 20 } as unknown as Stage2Thresholds;
    expect(resolveMaxItlP50Ms(noTiers, 34.67)).toBe(20);
  });
});
