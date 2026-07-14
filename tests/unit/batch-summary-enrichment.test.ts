import { describe, it, expect } from 'vitest';
import {
  mergeBatchDurationsIntoReport,
} from '../../src/services/batch-summary-enrichment.js';
import type { RecommendationReport } from '../../src/types/recommendation.js';

function makeReport(overrides?: Partial<RecommendationReport>): RecommendationReport {
  return {
    reportId: 'r-1',
    modelId: 'Qwen/Qwen3.6-27B',
    modelName: 'Qwen3.6-27B',
    verdict: 'support',
    confidence: 'high',
    hardwareProfile: '2xa100-80gb',
    stage1Passed: true,
    stage2Passed: true,
    stage2Ran: true,
    stage3Ran: true,
    passingEvals: [],
    blockingIssues: [],
    vllmConfigUsed: { flags: [], source: 'model_card' },
    suggestions: [],
    stage1Metrics: null,
    stage2Results: {
      suitesRun: ['security-alert-triage'],
      suiteResults: {
        'security-alert-triage': { score: 1, passRate: 1, durationSec: 0 },
      },
    },
    reasoningSummary: null,
    runId: 'run-1',
    version: 1,
    evaluatedAt: '2026-07-14T00:00:00Z',
    evaluatedBy: 'test',
    source: 'manual',
    ...overrides,
  };
}

describe('mergeBatchDurationsIntoReport', () => {
  it('fills suite durationSec from batch summary duration_ms', () => {
    const report = makeReport();
    const merged = mergeBatchDurationsIntoReport(
      report,
      {
        results: [
          {
            suite: 'security-alert-triage',
            model: 'Qwen/Qwen3.6-27B',
            status: 'pass',
            duration_ms: 630_000,
          },
        ],
      },
      'Qwen/Qwen3.6-27B',
    );

    expect(merged.stage2Results?.suiteResults['security-alert-triage']?.durationSec).toBe(630);
  });
});
