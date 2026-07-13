import { describe, it, expect } from 'vitest';
import { orderBenchmarkerSuites } from '../../src/services/local-batch-eval-runner.js';

describe('orderBenchmarkerSuites', () => {
  it('runs alert-triage before rag and esql', () => {
    const input = [
      'security-esql-generation-regression',
      'security-alerts-rag-regression',
      'security-alert-triage',
    ];
    expect(orderBenchmarkerSuites(input)).toEqual([
      'security-alert-triage',
      'security-alerts-rag-regression',
      'security-esql-generation-regression',
    ]);
  });

  it('preserves unknown suites after the security trio', () => {
    expect(orderBenchmarkerSuites(['security-ai-rules', 'security-alert-triage'])).toEqual([
      'security-alert-triage',
      'security-ai-rules',
    ]);
  });
});
