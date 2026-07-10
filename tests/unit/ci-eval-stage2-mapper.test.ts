import { describe, it, expect } from 'vitest';
import {
  buildResumeStage2Result,
  mapBuildkiteResultToStage2,
  mergeStage2Results,
  parseEvalArtifactJson,
} from '../../src/services/ci-eval-stage2-mapper.js';

describe('mapBuildkiteResultToStage2', () => {
  it('maps passed Buildkite build to success Stage2Result', () => {
    const result = mapBuildkiteResultToStage2(
      'run-1',
      'Qwen/Qwen2.5-1.5B-Instruct',
      ['security-alert-triage'],
      { buildUrl: 'https://buildkite.com/build/92', buildNumber: 92, status: 'passed' },
      { total: 4, passed: 4, passRate: 1 },
    );

    expect(result.status).toBe('success');
    expect(result.scores?.['security-alert-triage']).toBe(1);
    expect(result.suiteResults).toHaveLength(1);
  });

  it('maps failed build with per-case artifact summary', () => {
    const result = mapBuildkiteResultToStage2(
      'run-1',
      'model',
      ['security-alert-triage'],
      { buildUrl: 'https://buildkite.com/build/92', buildNumber: 92, status: 'failed' },
      {
        total: 4,
        passed: 2,
        failed: 2,
        passRate: 0.5,
        cases: [
          { name: 'Priority triage', status: 'failed', error: 'token limit' },
          { name: 'Summary mode', status: 'passed' },
        ],
      },
    );

    expect(result.status).toBe('failed');
    expect(result.suiteResults).toHaveLength(2);
    expect(result.scores?.['security-alert-triage']).toBe(0.5);
  });
});

describe('mergeStage2Results', () => {
  it('merges per-suite Stage2 results into one matrix result', () => {
    const triage = mapBuildkiteResultToStage2(
      'run-1',
      'Qwen/Qwen2.5-7B-Instruct',
      ['security-alert-triage'],
      { buildUrl: 'https://buildkite.com/build/1', buildNumber: 1, status: 'passed' },
      { total: 3, passed: 3, passRate: 1 },
    );
    const rag = mapBuildkiteResultToStage2(
      'run-1',
      'Qwen/Qwen2.5-7B-Instruct',
      ['security-alerts-rag-regression'],
      { buildUrl: 'https://buildkite.com/build/2', buildNumber: 2, status: 'failed' },
      { total: 10, passed: 8, passRate: 0.8 },
    );

    const merged = mergeStage2Results([triage, rag]);

    expect(merged.status).toBe('failed');
    expect(merged.scores?.['security-alert-triage']).toBe(1);
    expect(merged.scores?.['security-alerts-rag-regression']).toBe(0.8);
    expect(merged.suiteResults?.length).toBe(2);
  });
});

describe('buildResumeStage2Result', () => {
  it('sets score: 1 on every resumed suite, not null (regression: Qwen3-Next-80B-A3B false-negative)', () => {
    const result = buildResumeStage2Result(
      'run-1',
      'cyankiwi/Qwen3-Next-80B-A3B-Instruct-AWQ-4bit',
      ['security-alert-triage', 'security-alerts-rag-regression', 'security-esql-generation-regression'],
      '2026-07-06T06:00:00Z',
    );

    expect(result.status).toBe('success');
    expect(result.suiteResults).toHaveLength(3);
    for (const sr of result.suiteResults ?? []) {
      expect(sr.score).toBe(1);
      expect(sr.status).toBe('pass');
    }
    expect(result.scores).toEqual({
      'security-alert-triage': 1,
      'security-alerts-rag-regression': 1,
      'security-esql-generation-regression': 1,
    });
  });
});

describe('parseEvalArtifactJson', () => {
  it('parses tests array from eval JSON artifact', () => {
    const summary = parseEvalArtifactJson(
      JSON.stringify({
        tests: [
          { name: 'case-a', status: 'passed' },
          { name: 'case-b', status: 'failed', error: 'boom' },
        ],
      }),
    );

    expect(summary?.total).toBe(2);
    expect(summary?.passed).toBe(1);
    expect(summary?.failed).toBe(1);
    expect(summary?.passRate).toBe(0.5);
  });
});
