// src/services/health-monitor.ts
import { createLogger } from '../utils/logger.js';
import type { SystemHealthChecker, SystemHealthCheckResult } from './system-health-check.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface AlertThresholds {
  /** Max pending queue entries before alerting (default: 50) */
  queueDepth: number;
  /** Max error rate (0–1) before alerting (default: 0.1) */
  errorRate: number;
  /** Max consecutive failures before escalating (default: 3) */
  consecutiveFailures: number;
}

export interface HealthSnapshot {
  timestamp: string;
  ok: boolean;
  checks: Record<string, { ok: boolean; message?: string }>;
  uptimeSeconds: number;
  memoryMB: number;
}

export type AlertLevel = 'warning' | 'critical';

export interface Alert {
  level: AlertLevel;
  check: string;
  message: string;
  timestamp: string;
  consecutiveFailures: number;
}

export type AlertHandler = (alert: Alert) => void | Promise<void>;

// ─── Health Monitor ──────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: AlertThresholds = {
  queueDepth: 50,
  errorRate: 0.1,
  consecutiveFailures: 3,
};

export class HealthMonitor {
  private readonly logger = createLogger();
  private readonly thresholds: AlertThresholds;
  private readonly checker: SystemHealthChecker;
  private readonly alertHandlers: AlertHandler[] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private failureCounts = new Map<string, number>();
  private history: HealthSnapshot[] = [];
  private readonly maxHistory: number;
  private readonly startTime = Date.now();

  constructor(
    checker: SystemHealthChecker,
    options: {
      thresholds?: Partial<AlertThresholds>;
      maxHistory?: number;
    } = {},
  ) {
    this.checker = checker;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.maxHistory = options.maxHistory ?? 100;
  }

  /** Register an alert handler (log, webhook, etc.) */
  onAlert(handler: AlertHandler): void {
    this.alertHandlers.push(handler);
  }

  /** Start periodic health checks at the given interval (ms). */
  start(intervalMs: number): void {
    if (this.timer) return; // already running
    this.logger.info(`Health monitor started (interval: ${intervalMs}ms)`);
    // Run immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Health monitor stopped');
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Run a single health check cycle. */
  async tick(): Promise<HealthSnapshot> {
    let result: SystemHealthCheckResult;
    try {
      result = await this.checker.run();
    } catch (err) {
      result = {
        ok: false,
        checks: {
          system: {
            ok: false,
            message: `Health check threw: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
      };
    }

    const snapshot: HealthSnapshot = {
      timestamp: new Date().toISOString(),
      ok: result.ok,
      checks: result.checks,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };

    // Track history (ring buffer)
    this.history.push(snapshot);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Process each check for alerting
    for (const [name, check] of Object.entries(result.checks)) {
      if (check.ok) {
        // Reset failure counter on recovery
        const prev = this.failureCounts.get(name) ?? 0;
        if (prev > 0) {
          this.logger.info(`Health check recovered: ${name}`);
        }
        this.failureCounts.set(name, 0);
      } else {
        const count = (this.failureCounts.get(name) ?? 0) + 1;
        this.failureCounts.set(name, count);

        const level: AlertLevel = count >= this.thresholds.consecutiveFailures ? 'critical' : 'warning';
        const alert: Alert = {
          level,
          check: name,
          message: check.message ?? `Check "${name}" failed`,
          timestamp: snapshot.timestamp,
          consecutiveFailures: count,
        };

        this.logger[level === 'critical' ? 'error' : 'warn'](
          `[${level.toUpperCase()}] ${name}: ${alert.message} (failures: ${count})`,
        );

        for (const handler of this.alertHandlers) {
          try {
            await handler(alert);
          } catch (e) {
            this.logger.warn(`Alert handler threw: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    return snapshot;
  }

  /** Return the last N snapshots (newest first). */
  getHistory(limit = 20): HealthSnapshot[] {
    return this.history.slice(-limit).reverse();
  }

  /** Latest snapshot, or null if none yet. */
  getLatest(): HealthSnapshot | null {
    return this.history.at(-1) ?? null;
  }

  /** Current failure counts per check. */
  getFailureCounts(): Record<string, number> {
    return Object.fromEntries(this.failureCounts);
  }

  /** Summary stats from history. */
  getSummary(): {
    totalChecks: number;
    healthyChecks: number;
    uptimePercent: string;
    currentStatus: 'healthy' | 'degraded' | 'unknown';
  } {
    const total = this.history.length;
    if (total === 0) {
      return { totalChecks: 0, healthyChecks: 0, uptimePercent: '0.00', currentStatus: 'unknown' };
    }
    const healthy = this.history.filter((s) => s.ok).length;
    const latest = this.history.at(-1);
    return {
      totalChecks: total,
      healthyChecks: healthy,
      uptimePercent: ((healthy / total) * 100).toFixed(2),
      currentStatus: latest?.ok ? 'healthy' : 'degraded',
    };
  }
}
