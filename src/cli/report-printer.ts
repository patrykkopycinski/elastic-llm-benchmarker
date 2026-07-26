export function printReport(r: { modelId: string; verdict: string; confidence: string; hardwareProfile: string; stage1Passed: boolean; stage2Ran: boolean; stage2Passed: boolean | null; stage3Ran: boolean; stage1Metrics: { itl: { p50: number }; ttft: { p50: number }; throughputTps: number } | null; passingEvals: Array<{ suite: string; score: number; threshold: number; passed: boolean }>; blockingIssues: Array<{ severity: string; message: string }>; suggestions: Array<{ title: string; description: string }>; evaluatedAt: string; runId: string }): void {
  const verdictColor = r.verdict === 'support' ? '\x1b[32m' : r.verdict === 'reject' ? '\x1b[31m' : '\x1b[33m';
  console.error(`\n=== Recommendation Report: ${r.modelId} ===\n`);
  console.error(`  Verdict:    ${verdictColor}${r.verdict.toUpperCase()}\x1b[0m`);
  console.error(`  Confidence: ${r.confidence}`);
  console.error(`  Hardware:   ${r.hardwareProfile}`);
  console.error(`  Evaluated:  ${r.evaluatedAt}`);
  console.error(`  Run ID:     ${r.runId}`);
  console.error('');
  console.error(`  Stage 1: ${r.stage1Passed ? 'PASSED' : 'FAILED'}`);
  if (r.stage1Metrics) {
    console.error(`    ITL p50:     ${r.stage1Metrics.itl.p50.toFixed(1)}ms`);
    console.error(`    TTFT:        ${r.stage1Metrics.ttft.p50.toFixed(1)}ms`);
    console.error(`    Throughput:  ${r.stage1Metrics.throughputTps.toFixed(1)} tps`);
  }
  console.error(`  Stage 2: ${r.stage2Ran ? (r.stage2Passed ? 'PASSED' : 'FAILED') : 'NOT RUN'}`);
  if (r.passingEvals.length > 0) {
    for (const e of r.passingEvals) {
      const status = e.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.error(`    [${status}] ${e.suite}: ${(e.score * 100).toFixed(0)}% (threshold: ${(e.threshold * 100).toFixed(0)}%)`);
    }
  }
  console.error(`  Stage 3: ${r.stage3Ran ? 'COMPLETED' : 'NOT RUN'}`);
  if (r.blockingIssues.length > 0) {
    console.error('\n  Blocking Issues:');
    for (const i of r.blockingIssues) {
      console.error(`    [${i.severity}] ${i.message}`);
    }
  }
  if (r.suggestions.length > 0) {
    console.error('\n  Suggestions:');
    for (const s of r.suggestions) {
      console.error(`    - ${s.title}: ${s.description}`);
    }
  }
  console.error('');
}

export function printReportSummary(r: { modelId: string; verdict: string; confidence: string; evaluatedAt: string; stage1Passed: boolean; stage2Ran: boolean }): void {
  const verdictColor = r.verdict === 'support' ? '\x1b[32m' : r.verdict === 'reject' ? '\x1b[31m' : '\x1b[33m';
  const stages = `S1:${r.stage1Passed ? 'Y' : 'N'} S2:${r.stage2Ran ? 'Y' : '-'}`;
  console.error(`  ${verdictColor}${r.verdict.toUpperCase().padEnd(12)}\x1b[0m ${r.modelId.padEnd(40)} [${r.confidence}] ${stages}  ${r.evaluatedAt}`);
}
