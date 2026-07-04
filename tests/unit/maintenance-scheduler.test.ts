import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { MaintenanceScheduler } from '../../src/services/maintenance-scheduler.js';
import type { QueueService, QueueEntry } from '../../src/services/queue-service.js';
import type { MaintenanceConfig, CostCapsConfig } from '../../src/types/config.js';
import { createLogger } from '../../src/utils/logger.js';

const NOW = Date.parse('2026-07-04T12:00:00Z');

function maintConfig(overrides: Partial<MaintenanceConfig> = {}): MaintenanceConfig {
  return {
    enabled: true,
    intervalHours: 24,
    vmHourlyCostUsd: 8,
    lowUtilizationThreshold: 0.2,
    staleLeaseAlertMs: 300_000,
    dlqRetryAfterDays: 7,
    dlqMaxRequeuePerSweep: 5,
    postSlackDigest: true,
    ...overrides,
  };
}

function costCaps(overrides: Partial<CostCapsConfig> = {}): CostCapsConfig {
  return { enabled: false, maxModelsPerDay: 20, ...overrides };
}

function failedEntry(id: string, errorMessage: string): QueueEntry {
  return {
    id,
    modelId: `org/${id}`,
    source: 'discovery',
    priority: 10,
    status: 'failed',
    requestedAt: '2026-06-01T00:00:00Z',
    startedAt: '2026-06-01T00:01:00Z',
    completedAt: '2026-06-01T01:00:00Z',
    errorMessage,
    requestedBy: null,
    leaseToken: null,
    heartbeatAt: null,
  };
}

describe('MaintenanceScheduler', () => {
  let queueService: {
    countByStatus: ReturnType<typeof vi.fn>;
    countTerminalSince: ReturnType<typeof vi.fn>;
    sumBenchmarkMsSince: ReturnType<typeof vi.fn>;
    findFailedEntries: ReturnType<typeof vi.fn>;
    requeueFailedEntries: ReturnType<typeof vi.fn>;
  };
  let resultsStore: { countErrorsSince: ReturnType<typeof vi.fn> };
  let esIndex: ReturnType<typeof vi.fn>;
  let esSearch: ReturnType<typeof vi.fn>;
  let esClient: Client;
  let slackNotifier: { notifyHealthDigest: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    queueService = {
      countByStatus: vi.fn().mockResolvedValue({
        pending: 2, deploying: 0, benchmarking: 1, completed: 5, failed: 3, cancelled: 0,
      }),
      countTerminalSince: vi.fn().mockResolvedValue(4),
      sumBenchmarkMsSince: vi.fn().mockResolvedValue({ runs: 4, benchmarkMs: 12 * 60 * 60 * 1000 }),
      findFailedEntries: vi.fn().mockResolvedValue([]),
      requeueFailedEntries: vi.fn().mockResolvedValue(0),
    };
    resultsStore = { countErrorsSince: vi.fn().mockResolvedValue(0) };
    esIndex = vi.fn().mockResolvedValue({});
    esSearch = vi.fn().mockResolvedValue({
      hits: { hits: [{ _source: { heartbeat_at: new Date(NOW - 30_000).toISOString() } }] },
    });
    esClient = { index: esIndex, search: esSearch } as unknown as Client;
    slackNotifier = { notifyHealthDigest: vi.fn().mockResolvedValue({ success: true }) };
  });

  function build(configOverrides: Partial<MaintenanceConfig> = {}, caps = costCaps()) {
    return new MaintenanceScheduler({
      esClient,
      queueService: queueService as unknown as QueueService,
      resultsStore,
      config: maintConfig(configOverrides),
      costCaps: caps,
      vmHost: 'gpu-vm.example',
      hardwareProfileId: '2xa100-80gb',
      slackNotifier: slackNotifier as never,
      logger: createLogger('silent'),
      now: () => NOW,
    });
  }

  it('emits a VM cost snapshot with utilization and burn', async () => {
    const scheduler = build();
    const res = await scheduler.runOnce();

    // 12 benchmark-hours / 24 wall-hours = 0.5 utilization.
    expect(res.utilizationRatio).toBeCloseTo(0.5, 3);
    expect(res.estimatedCostUsd).toBe(8 * 24);
    expect(esIndex).toHaveBeenCalledTimes(1);
    const doc = esIndex.mock.calls[0][0].document;
    expect(doc.utilization_ratio).toBeCloseTo(0.5, 3);
    expect(doc.low_utilization).toBe(false);
    expect(doc.vm_host).toBe('gpu-vm.example');
  });

  it('flags low utilization as an alert', async () => {
    queueService.sumBenchmarkMsSince.mockResolvedValue({ runs: 1, benchmarkMs: 60 * 60 * 1000 });
    const scheduler = build();
    const res = await scheduler.runOnce();

    // 1h / 24h ≈ 0.04 < 0.2 threshold.
    expect(res.alerts).toContain('VM utilization');
    const digest = slackNotifier.notifyHealthDigest.mock.calls[0][0];
    expect(digest.signals.find((s: { label: string }) => s.label === 'VM utilization').alert).toBe(true);
  });

  it('alerts when the daemon lease heartbeat is stale', async () => {
    esSearch.mockResolvedValue({
      hits: { hits: [{ _source: { heartbeat_at: new Date(NOW - 600_000).toISOString() } }] },
    });
    const scheduler = build();
    const res = await scheduler.runOnce();
    expect(res.alerts).toContain('Daemon lease');
  });

  it('re-enqueues retriable quarantined failures older than the DLQ window', async () => {
    queueService.findFailedEntries.mockResolvedValue([
      failedEntry('a', 'ECONNRESET: fetch failed'),   // transient-infra → retriable
      failedEntry('b', 'unsupported model architecture'), // model-arch → not retriable
      failedEntry('c', 'CUDA out of memory'),          // resource-fit → retriable
    ]);
    queueService.requeueFailedEntries.mockResolvedValue(2);

    const scheduler = build();
    const res = await scheduler.runOnce();

    expect(res.requeuedFromDlq).toBe(2);
    expect(queueService.requeueFailedEntries).toHaveBeenCalledWith(['a', 'c']);
  });

  it('skips the DLQ sweep when the cost cap is engaged', async () => {
    // enabled cap, terminal today >= max → engaged.
    queueService.countTerminalSince.mockResolvedValue(20);
    queueService.findFailedEntries.mockResolvedValue([failedEntry('a', 'fetch failed')]);

    const scheduler = build({}, costCaps({ enabled: true, maxModelsPerDay: 20 }));
    const res = await scheduler.runOnce();

    expect(res.requeuedFromDlq).toBe(0);
    expect(queueService.requeueFailedEntries).not.toHaveBeenCalled();
    const digest = slackNotifier.notifyHealthDigest.mock.calls[0][0];
    expect(digest.signals.find((s: { label: string }) => s.label === 'Cost cap').alert).toBe(true);
  });

  it('does not post to Slack when postSlackDigest is false', async () => {
    const scheduler = build({ postSlackDigest: false });
    await scheduler.runOnce();
    expect(slackNotifier.notifyHealthDigest).not.toHaveBeenCalled();
  });

  it('never throws on a failing tick', async () => {
    queueService.countByStatus.mockRejectedValue(new Error('es down'));
    const scheduler = build();
    const res = await scheduler.runOnce();
    expect(res.requeuedFromDlq).toBe(0);
    expect(res.utilizationRatio).toBe(0);
  });

  it('fires an immediate boot-time tick on start()', async () => {
    const scheduler = build();
    scheduler.start();
    // start() dispatches runOnce() detached; let the microtask/IO settle.
    await vi.waitFor(() => expect(esIndex).toHaveBeenCalledTimes(1));
    scheduler.stop();
  });
});
