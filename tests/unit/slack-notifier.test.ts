import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackNotifier } from '../../src/services/slack-notifier.js';
import type { RecommendationReport } from '../../src/types/recommendation.js';

function makeReport(overrides?: Partial<RecommendationReport>): RecommendationReport {
  return {
    reportId: 'rpt-1',
    modelId: 'Qwen/Qwen2.5-72B-Instruct',
    modelName: 'Qwen2.5-72B-Instruct',
    verdict: 'support',
    confidence: 'high',
    hardwareProfile: 'A100-80GBx2',
    stage1Passed: true,
    stage2Passed: true,
    stage2Ran: true,
    stage3Ran: true,
    passingEvals: [
      { suite: 'tool_calls', score: 0.94, threshold: 0.85, passed: true },
    ],
    blockingIssues: [],
    vllmConfigUsed: { flags: [], source: 'model_card' },
    suggestions: [{ category: 'config', title: 'Lower context', description: 'reduce', expectedImpact: 'high', confidence: 'high' }],
    stage1Metrics: { itl: { p50: 45, p99: 120, mean: 50 }, ttft: { p50: 120, p99: 300, mean: 140 }, throughputTps: 85 },
    stage2Results: { suitesRun: ['tool_calls'], suiteResults: { tool_calls: { score: 0.94, passRate: 0.92, durationSec: 180 } } },
    reasoningSummary: 'Good performance',
    runId: 'run-123',
    version: 1,
    evaluatedAt: '2026-06-01T00:00:00Z',
    evaluatedBy: 'benchmarker-v0.1.0',
    source: 'manual',
    ...overrides,
  };
}

describe('SlackNotifier', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => 'ok' });
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('sends notification for support verdict', async () => {
    const notifier = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/test', logLevel: 'error' });
    const result = await notifier.notifyVerdict(makeReport());

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.com/test');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.blocks).toBeDefined();
    expect(body.blocks[0].text.text).toContain('SUPPORT');
  });

  it('sends notification for investigate verdict', async () => {
    const notifier = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/test', logLevel: 'error' });
    const result = await notifier.notifyVerdict(makeReport({ verdict: 'investigate' }));

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips notification for reject verdict when not in notifyOn', async () => {
    const notifier = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/test', logLevel: 'error' });
    const result = await notifier.notifyVerdict(makeReport({ verdict: 'reject' }));

    expect(result.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends notification for reject when configured', async () => {
    const notifier = new SlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      notifyOn: ['reject'],
      logLevel: 'error',
    });
    const result = await notifier.notifyVerdict(makeReport({ verdict: 'reject' }));

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns error on HTTP failure', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal error' });
    const notifier = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/test', logLevel: 'error' });
    const result = await notifier.notifyVerdict(makeReport());

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns error on fetch exception', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network error'));
    const notifier = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/test', logLevel: 'error' });
    const result = await notifier.notifyVerdict(makeReport());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('includes blocking issues in the message body', async () => {
    const notifier = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/test', logLevel: 'error' });
    const report = makeReport({
      verdict: 'investigate',
      blockingIssues: [
        { severity: 'warning', category: 'throughput', message: 'TTFT p99 is 310ms' },
      ],
    });
    await notifier.notifyVerdict(report);

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    const allText = JSON.stringify(body.blocks);
    expect(allText).toContain('TTFT p99 is 310ms');
  });
});
