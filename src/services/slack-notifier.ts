import type { RecommendationReport } from '../types/recommendation.js';
import { createLogger } from '../utils/logger.js';

export interface SlackNotifierOptions {
  webhookUrl: string;
  notifyOn?: Array<'support' | 'investigate' | 'reject'>;
  logLevel?: string;
}

export class SlackNotifier {
  private readonly webhookUrl: string;
  private readonly notifyOn: Set<string>;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(options: SlackNotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.notifyOn = new Set(options.notifyOn ?? ['support', 'investigate']);
    this.logger = createLogger(options.logLevel ?? 'info');
  }

  async notifyVerdict(report: RecommendationReport): Promise<{ success: boolean; error?: string }> {
    if (!this.notifyOn.has(report.verdict)) {
      return { success: true };
    }

    const emoji = report.verdict === 'support' ? ':white_check_mark:' :
      report.verdict === 'investigate' ? ':mag:' : ':x:';

    const confidenceEmoji = report.confidence === 'high' ? ':large_green_circle:' :
      report.confidence === 'medium' ? ':large_yellow_circle:' : ':red_circle:';

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} Model Recommendation: ${report.verdict.toUpperCase()}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Model:*\n${report.modelId}` },
          { type: 'mrkdwn', text: `*Hardware:*\n${report.hardwareProfile}` },
          { type: 'mrkdwn', text: `*Confidence:*\n${confidenceEmoji} ${report.confidence}` },
          { type: 'mrkdwn', text: `*Run ID:*\n\`${report.runId.slice(0, 8)}\`` },
        ],
      },
    ];

    if (report.stage1Metrics) {
      const m = report.stage1Metrics;
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*ITL p50:*\n${m.itl.p50.toFixed(1)}ms` },
          { type: 'mrkdwn', text: `*Throughput:*\n${m.throughputTps.toFixed(1)} tps` },
          { type: 'mrkdwn', text: `*TTFT:*\n${m.ttft.p50.toFixed(1)}ms` },
          { type: 'mrkdwn', text: `*Stage 1:*\n${report.stage1Passed ? 'PASSED' : 'FAILED'}` },
        ],
      });
    }

    if (report.passingEvals.length > 0) {
      const evalLines = report.passingEvals.map(
        (e) => `${e.passed ? ':white_check_mark:' : ':x:'} ${e.suite}: ${(e.score * 100).toFixed(0)}% (threshold: ${(e.threshold * 100).toFixed(0)}%)`
      ).join('\n');
      blocks.push({
        type: 'section',
        fields: [{ type: 'mrkdwn', text: `*Eval Results:*\n${evalLines}` }],
      });
    }

    if (report.blockingIssues.length > 0) {
      const issueLines = report.blockingIssues
        .slice(0, 5)
        .map((i) => `• [${i.severity}] ${i.message}`)
        .join('\n');
      blocks.push({
        type: 'section',
        fields: [{ type: 'mrkdwn', text: `*Blocking Issues:*\n${issueLines}` }],
      });
    }

    if (report.suggestions.length > 0) {
      const sugLines = report.suggestions
        .slice(0, 3)
        .map((s) => `• ${s.title}`)
        .join('\n');
      blocks.push({
        type: 'section',
        fields: [{ type: 'mrkdwn', text: `*Suggestions:*\n${sugLines}` }],
      });
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.error('Slack notification failed', { status: response.status, body: text });
        return { success: false, error: `HTTP ${response.status}: ${text}` };
      }

      this.logger.info('Slack notification sent', { modelId: report.modelId, verdict: report.verdict });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Slack notification error', { error: message });
      return { success: false, error: message };
    }
  }
}
