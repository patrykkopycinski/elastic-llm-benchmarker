import type { QueueService, QueueEntry } from '../services/queue-service.js';
import type { PipelineRun } from './pipeline-state.js';
import type { Stage1Worker, Stage2Worker, Stage3Worker } from '../worker/index.js';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { AppConfig } from '../types/config.js';
import type { RecommendationReport } from '../types/recommendation.js';
import { buildRecommendationReport } from '../services/recommendation-report-builder.js';
import type { SlackNotifier } from '../services/slack-notifier.js';

export interface SchedulerOptions {
  pollIntervalMs: number;
  maxConcurrentRuns: number;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeRuns = 0;
  private shuttingDown = false;

  constructor(
    private queueService: QueueService,
    private stage1Worker: Stage1Worker,
    private options: SchedulerOptions = { pollIntervalMs: 30000, maxConcurrentRuns: 1 },
    private stage2Worker?: Stage2Worker,
    private resultsStore?: ElasticsearchResultsStore,
    private stage3Worker?: Stage3Worker,
    private config?: AppConfig,
    private slackNotifier?: SlackNotifier,
  ) {}

  async start(): Promise<void> {
    // Immediately check once, then set interval
    await this.poll();
    this.timer = setInterval(() => this.poll(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for active runs to complete
    while (this.activeRuns > 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.activeRuns >= this.options.maxConcurrentRuns) return;

    try {
      const pending = await this.queueService.findPending(1);
      if (pending.length === 0) return;

      const entry = pending[0];
      if (!entry) return;

      this.activeRuns++;

      // Run in background (don't await)
      this.processEntry(entry).finally(() => {
        this.activeRuns--;
      });
    } catch (err) {
      console.error('Scheduler poll error:', err);
    }
  }

  private async processEntry(entry: QueueEntry): Promise<void> {
    const run: PipelineRun = {
      runId: crypto.randomUUID(),
      modelId: entry.modelId,
      queueEntryId: entry.id,
      stage: 'idle',
      startedAt: new Date().toISOString(),
    };

    try {
      await this.queueService.updateStatus(entry.id, 'deploying');
      const result = await this.stage1Worker.execute(run);
      run.benchmarkResult = result;

      if (result.status !== 'success') {
        await this.queueService.updateStatus(entry.id, 'failed', result.error);
        return;
      }

      // Stage 1 succeeded — optionally chain Stage 2
      if (this.stage2Worker) {
        const stage2Result = await this.stage2Worker.execute(run, result);
        run.stage2Result = stage2Result;

        if (this.resultsStore) {
          await this.resultsStore.saveStage2Result(stage2Result);
        }

        if (stage2Result.status === 'error') {
          await this.queueService.updateStatus(entry.id, 'failed', stage2Result.reason);
          return;
        }
      }

      // Stage 3 reasoning — optional
      if (this.stage3Worker) {
        const stage3Result = await this.stage3Worker.execute(run);
        run.stage3Result = stage3Result;
        if (this.resultsStore) {
          await this.resultsStore.saveReasoningResult(stage3Result);
        }
        if (stage3Result.status === 'error') {
          await this.queueService.updateStatus(entry.id, 'failed', stage3Result.error);
          return;
        }
      }

      // Build and save recommendation report
      let report: RecommendationReport | undefined;
      if (this.resultsStore && this.config) {
        try {
          report = buildRecommendationReport(run, { config: this.config });
          await this.resultsStore.saveRecommendationReport(report);
        } catch {
          // Report generation failure should not block pipeline completion
        }
      }

      await this.queueService.updateStatus(entry.id, 'completed');

      // Send Slack notification for actionable verdicts
      if (report && this.slackNotifier) {
        try {
          await this.slackNotifier.notifyVerdict(report);
        } catch {
          // Notification failure should not block pipeline
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.queueService.updateStatus(entry.id, 'failed', message);
    }
  }
}
