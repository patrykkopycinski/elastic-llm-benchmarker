import { describe, it, expect } from 'vitest';
import {
  mapBuildkiteResultToStage2,
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
