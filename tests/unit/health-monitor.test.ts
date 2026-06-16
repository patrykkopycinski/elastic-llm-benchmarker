import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HealthMonitor } from '../../src/services/health-monitor.js';
import type { SystemHealthChecker, SystemHealthCheckResult } from '../../src/services/system-health-check.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function createMockChecker(result?: Partial<SystemHealthCheckResult>): SystemHealthChecker {
  const defaultResult: SystemHealthCheckResult = {
    ok: true,
    checks: {
      discovery_scheduler: { ok: true, message: 'running' },
      queue_depth: { ok: true, message: 'Queue depth is 5' },
    },
  };
  return {
    run: vi.fn().mockResolvedValue({ ...defaultResult, ...result }),
  } as unknown as SystemHealthChecker;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('HealthMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tick() captures a healthy snapshot', async () => {
    const checker = createMockChecker();
    const monitor = new HealthMonitor(checker);

    const snapshot = await monitor.tick();

    expect(snapshot.ok).toBe(true);
    expect(snapshot.checks).toHaveProperty('discovery_scheduler');
    expect(snapshot.checks).toHaveProperty('queue_depth');
    expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.memoryMB).toBeGreaterThan(0);
    expect(snapshot.timestamp).toBeTruthy();
  });

  it('tick() detects unhealthy checks and increments failure counter', async () => {
    const checker = createMockChecker({
      ok: false,
      checks: {
        queue_depth: { ok: false, message: 'Queue depth is 80 (threshold: 50)' },
      },
    });
    const monitor = new HealthMonitor(checker);

    await monitor.tick();
    expect(monitor.getFailureCounts()).toEqual({ queue_depth: 1 });

    await monitor.tick();
    expect(monitor.getFailureCounts()).toEqual({ queue_depth: 2 });
  });

  it('resets failure counter on recovery', async () => {
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        checks: { queue_depth: { ok: false, message: 'high' } },
      })
      .mockResolvedValueOnce({
        ok: true,
        checks: { queue_depth: { ok: true, message: 'ok' } },
      });
    const checker = { run: runMock } as unknown as SystemHealthChecker;
    const monitor = new HealthMonitor(checker);

    await monitor.tick();
    expect(monitor.getFailureCounts()).toEqual({ queue_depth: 1 });

    await monitor.tick();
    expect(monitor.getFailureCounts()).toEqual({ queue_depth: 0 });
  });

  it('fires alert handler with correct level', async () => {
    const checker = createMockChecker({
      ok: false,
      checks: { queue_depth: { ok: false, message: 'high' } },
    });
    const monitor = new HealthMonitor(checker, {
      thresholds: { consecutiveFailures: 2, queueDepth: 50, errorRate: 0.1 },
    });

    const alerts: Array<{ level: string; check: string }> = [];
    monitor.onAlert((a) => {
      alerts.push({ level: a.level, check: a.check });
    });

    await monitor.tick(); // failure 1 → warning
    await monitor.tick(); // failure 2 → critical

    expect(alerts).toEqual([
      { level: 'warning', check: 'queue_depth' },
      { level: 'critical', check: 'queue_depth' },
    ]);
  });

  it('getHistory returns snapshots newest-first', async () => {
    const checker = createMockChecker();
    const monitor = new HealthMonitor(checker);

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    const history = monitor.getHistory();
    expect(history).toHaveLength(3);
    // Newest first
    expect(new Date(history[0].timestamp).getTime()).toBeGreaterThanOrEqual(
      new Date(history[1].timestamp).getTime(),
    );
  });

  it('limits history to maxHistory', async () => {
    const checker = createMockChecker();
    const monitor = new HealthMonitor(checker, { maxHistory: 3 });

    for (let i = 0; i < 5; i++) {
      await monitor.tick();
    }

    expect(monitor.getHistory(10)).toHaveLength(3);
  });

  it('getSummary computes uptime percent', async () => {
    const runMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, checks: {} })
      .mockResolvedValueOnce({ ok: true, checks: {} })
      .mockResolvedValueOnce({ ok: false, checks: {} })
      .mockResolvedValueOnce({ ok: true, checks: {} });
    const checker = { run: runMock } as unknown as SystemHealthChecker;
    const monitor = new HealthMonitor(checker);

    for (let i = 0; i < 4; i++) await monitor.tick();

    const summary = monitor.getSummary();
    expect(summary.totalChecks).toBe(4);
    expect(summary.healthyChecks).toBe(3);
    expect(summary.uptimePercent).toBe('75.00');
    expect(summary.currentStatus).toBe('healthy');
  });

  it('handles checker.run() throwing', async () => {
    const checker = {
      run: vi.fn().mockRejectedValue(new Error('ES unreachable')),
    } as unknown as SystemHealthChecker;
    const monitor = new HealthMonitor(checker);

    const snapshot = await monitor.tick();
    expect(snapshot.ok).toBe(false);
    expect(snapshot.checks.system.message).toContain('ES unreachable');
  });

  it('start() and stop() control the interval', async () => {
    const checker = createMockChecker();
    const monitor = new HealthMonitor(checker);

    expect(monitor.isRunning).toBe(false);
    monitor.start(10_000);
    expect(monitor.isRunning).toBe(true);

    // The initial tick is async — flush the microtask queue
    await vi.waitFor(() => expect(monitor.getHistory()).toHaveLength(1));

    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  it('start() is idempotent', () => {
    const checker = createMockChecker();
    const monitor = new HealthMonitor(checker);
    monitor.start(60_000);
    monitor.start(60_000); // no-op
    expect(monitor.isRunning).toBe(true);
    monitor.stop();
  });

  it('getLatest returns null when no ticks have run', () => {
    const checker = createMockChecker();
    const monitor = new HealthMonitor(checker);
    expect(monitor.getLatest()).toBeNull();
  });

  it('alert handler errors do not crash the monitor', async () => {
    const checker = createMockChecker({
      ok: false,
      checks: { bad: { ok: false, message: 'fail' } },
    });
    const monitor = new HealthMonitor(checker);
    monitor.onAlert(() => {
      throw new Error('handler boom');
    });

    // Should not throw
    const snapshot = await monitor.tick();
    expect(snapshot.ok).toBe(false);
  });
});
