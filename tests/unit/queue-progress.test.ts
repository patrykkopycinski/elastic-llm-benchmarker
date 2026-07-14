import { describe, it, expect } from 'vitest';
import { progressNow } from '../../src/utils/queue-progress.js';

describe('progressNow', () => {
  it('builds pipeline progress with timestamp', () => {
    const p = progressNow('stage2_evals', 'Running suites', {
      evalSuites: ['security-ai-rules'],
      evalTotal: 1,
    });
    expect(p.stage).toBe('stage2_evals');
    expect(p.detail).toBe('Running suites');
    expect(p.evalSuites).toEqual(['security-ai-rules']);
    expect(p.updatedAt).toMatch(/^\d{4}-/);
  });
});
