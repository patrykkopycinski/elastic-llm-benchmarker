import type { Client } from '@elastic/elasticsearch';
import type { Logger } from 'winston';
import type { MaintenanceConfig, CostCapsConfig } from '../types/config.js';
import type { QueueService } from './queue-service.js';
import type { SlackNotifier, HealthSignal } from './slack-notifier.js';
import { INDEX_NAMES } from './es-index-mappings.js';
import { classifyFailure } from '../utils/failure-classifier.js';
import { createLogger } from '../utils/logger.js';

// NB: the results-store dependency is deliberately narrowed to
// {@link MaintenanceResultsStore} so this scheduler is trivial to unit-test.

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The subset of the results store the maintenance tick reads. Kept narrow so
 * the scheduler is trivial to unit test with a stub.
 */
export interface MaintenanceResultsStore {
  countErrorsSince(sinceIso: string, errorCategory?: string): Promise<number>;
}

export interface MaintenanceSchedulerDependencies {
  esClient: Client;
  queueService: QueueService;
  resultsStore: MaintenanceResultsStore;
  config: MaintenanceConfig;
  costCaps: CostCapsConfig;
  /** GPU VM host, for the lease-staleness signal and the cost snapshot label. */
  vmHost: string;
  /** Hardware profile id, recorded on the cost snapshot. */
  hardwareProfileId?: string;
  slackNotifier?: SlackNotifier;
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Outcome of a single maintenance tick (returned for tests / logging). */
export interface MaintenanceRunResult {
  utilizationRatio: number;
  estimatedCostUsd: number;
  runsInWindow: number;
  requeuedFromDlq: number;
  alerts: string[];
}

/**
 * Periodic maintenance & health tick (24/7-autonomy P0/P1). On each run it:
 *  1. Emits a VM cost/utilization snapshot to ES (burn vs. throughput). The GPU
 *     VM is ephemeral and never stopped, so low utilization is the signal to
 *     raise the daily cap / widen discovery — never to stop the VM.
 *  2. Re-enqueues retriable quarantined (`failed`) entries older than the DLQ
 *     window, bounded and gated by the daily cost cap.
 *  3. Posts a Slack health digest and flags threshold breaches (stale daemon
 *     lease, cost cap engaged, DLQ growth, recent-error / golden-forward spikes,
 *     idle pipeline).
 *
 * Never throws: a failed tick is logged and the timer keeps running.
 */
export class MaintenanceScheduler {
  private readonly deps: MaintenanceSchedulerDependencies;
  private readonly logger: Logger;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MaintenanceSchedulerDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? createLogger('info');
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.deps.config.intervalHours * MS_PER_HOUR;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    // Do not keep the event loop alive on the maintenance timer alone.
    this.timer.unref();
    this.logger.info('MaintenanceScheduler started', {
      intervalHours: this.deps.config.intervalHours,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('MaintenanceScheduler stopped');
    }
  }

  /** Run one maintenance tick. Never throws. */
  async runOnce(): Promise<MaintenanceRunResult> {
    const empty: MaintenanceRunResult = {
      utilizationRatio: 0,
      estimatedCostUsd: 0,
      runsInWindow: 0,
      requeuedFromDlq: 0,
      alerts: [],
    };
    try {
      const nowMs = this.now();
      const windowHours = this.deps.config.intervalHours;
      const windowMs = windowHours * MS_PER_HOUR;
      const sinceIso = new Date(nowMs - windowMs).toISOString();

      const [counts, terminalInWindow, benchmark, errorsInWindow, goldenErrors, leaseAgeMs] =
        await Promise.all([
          this.deps.queueService.countByStatus(),
          this.deps.queueService.countTerminalSince(sinceIso),
          this.deps.queueService.sumBenchmarkMsSince(sinceIso),
          this.deps.resultsStore.countErrorsSince(sinceIso),
          this.deps.resultsStore.countErrorsSince(sinceIso, 'golden-forward'),
          this.readLeaseAgeMs(nowMs),
        ]);

      const benchmarkHours = benchmark.benchmarkMs / MS_PER_HOUR;
      const utilizationRatio = Math.min(1, Math.max(0, benchmarkHours / windowHours));
      const estimatedCostUsd = this.deps.config.vmHourlyCostUsd * windowHours;
      const lowUtilization = utilizationRatio < this.deps.config.lowUtilizationThreshold;

      // Daily cost-cap engaged? (terminal models since UTC midnight >= cap)
      const costCapEngaged = await this.isCostCapEngaged(nowMs);

      await this.emitCostSnapshot({
        nowMs,
        windowHours,
        benchmarkHours,
        utilizationRatio,
        estimatedCostUsd,
        runs: benchmark.runs,
        lowUtilization,
      });

      const requeuedFromDlq = costCapEngaged ? 0 : await this.sweepDlq(nowMs);

      const staleLease =
        leaseAgeMs !== null && leaseAgeMs > this.deps.config.staleLeaseAlertMs;
      const idlePipeline = counts.pending === 0 && terminalInWindow === 0;

      const signals: HealthSignal[] = [
        {
          label: 'Daemon lease',
          value: leaseAgeMs === null ? 'no lease doc' : `${Math.round(leaseAgeMs / 1000)}s old`,
          alert: staleLease || leaseAgeMs === null,
        },
        {
          label: 'Queue',
          value: `${counts.pending} pending · ${counts.deploying + counts.benchmarking} in-flight · ${counts.failed} quarantined`,
          alert: false,
        },
        {
          label: 'Throughput',
          value: `${terminalInWindow} models terminal in ${windowHours}h`,
          alert: idlePipeline,
        },
        {
          label: 'VM utilization',
          value: `${(utilizationRatio * 100).toFixed(0)}% (~$${estimatedCostUsd.toFixed(2)} burn)`,
          alert: lowUtilization,
        },
        {
          label: 'Cost cap',
          value: costCapEngaged ? 'engaged (dequeue paused)' : 'headroom',
          alert: costCapEngaged,
        },
        {
          label: 'Errors logged',
          value: `${errorsInWindow} total · ${goldenErrors} golden-forward`,
          alert: goldenErrors > 0,
        },
        {
          label: 'DLQ re-tried',
          value: `${requeuedFromDlq} quarantined re-enqueued`,
          alert: false,
        },
      ];

      const alerts = signals.filter((s) => s.alert).map((s) => s.label);
      if (alerts.length > 0) {
        this.logger.warn('MaintenanceScheduler: health alerts', { alerts });
      }

      if (this.deps.config.postSlackDigest && this.deps.slackNotifier) {
        await this.deps.slackNotifier.notifyHealthDigest({
          window: `last ${windowHours}h`,
          signals,
        });
      }

      return {
        utilizationRatio,
        estimatedCostUsd,
        runsInWindow: benchmark.runs,
        requeuedFromDlq,
        alerts,
      };
    } catch (err) {
      this.logger.error('MaintenanceScheduler tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }
  }

  /** Re-enqueue retriable quarantined failures older than the DLQ window. */
  private async sweepDlq(nowMs: number): Promise<number> {
    const days = this.deps.config.dlqRetryAfterDays;
    const cap = this.deps.config.dlqMaxRequeuePerSweep;
    if (days <= 0 || cap <= 0) return 0;
    const beforeIso = new Date(nowMs - days * 24 * MS_PER_HOUR).toISOString();
    const failed = await this.deps.queueService.findFailedEntries(beforeIso, 100);
    const retriable = failed
      .filter((e) => classifyFailure(e.errorMessage).retriable)
      .slice(0, cap)
      .map((e) => e.id);
    if (retriable.length === 0) return 0;
    const requeued = await this.deps.queueService.requeueFailedEntries(retriable);
    if (requeued > 0) {
      this.logger.info('MaintenanceScheduler: re-enqueued quarantined retriable failures', {
        requeued,
      });
    }
    return requeued;
  }

  /** Write the VM cost/utilization snapshot. Best-effort. */
  private async emitCostSnapshot(s: {
    nowMs: number;
    windowHours: number;
    benchmarkHours: number;
    utilizationRatio: number;
    estimatedCostUsd: number;
    runs: number;
    lowUtilization: boolean;
  }): Promise<void> {
    try {
      await this.deps.esClient.index({
        index: INDEX_NAMES.BENCHMARKER_VM_COST,
        document: {
          '@timestamp': new Date(s.nowMs).toISOString(),
          vm_host: this.deps.vmHost,
          hardware_profile_id: this.deps.hardwareProfileId ?? null,
          window_hours: s.windowHours,
          wall_hours: s.windowHours,
          benchmark_hours: Math.round(s.benchmarkHours * 100) / 100,
          utilization_ratio: Math.round(s.utilizationRatio * 1000) / 1000,
          hourly_cost_usd: this.deps.config.vmHourlyCostUsd,
          estimated_cost_usd: Math.round(s.estimatedCostUsd * 100) / 100,
          runs_in_window: s.runs,
          low_utilization: s.lowUtilization,
        },
      });
    } catch (err) {
      this.logger.warn('MaintenanceScheduler: failed to emit VM cost snapshot', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Terminal models since UTC midnight >= cap (cost cap engaged). */
  private async isCostCapEngaged(nowMs: number): Promise<boolean> {
    if (!this.deps.costCaps.enabled) return false;
    const midnight = new Date(nowMs);
    midnight.setUTCHours(0, 0, 0, 0);
    try {
      const count = await this.deps.queueService.countTerminalSince(midnight.toISOString());
      return count >= this.deps.costCaps.maxModelsPerDay;
    } catch {
      return false;
    }
  }

  /** Age (ms) of the freshest daemon-lease heartbeat for our VM host, or null. */
  private async readLeaseAgeMs(nowMs: number): Promise<number | null> {
    try {
      const res = await this.deps.esClient.search<{ heartbeat_at?: string }>({
        index: INDEX_NAMES.BENCHMARKER_DAEMON_LEASE,
        query: { term: { vm_host: this.deps.vmHost } },
        sort: [{ heartbeat_at: { order: 'desc' } }],
        size: 1,
      });
      const hb = res.hits.hits[0]?._source?.heartbeat_at;
      if (!hb) return null;
      const ms = Date.parse(hb);
      return Number.isNaN(ms) ? null : Math.max(0, nowMs - ms);
    } catch {
      return null;
    }
  }
}
