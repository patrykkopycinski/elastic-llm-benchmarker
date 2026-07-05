import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiscoveryScheduler, deriveModelFamily } from '../../src/services/discovery-scheduler.js';
import type { ScoredModel } from '../../src/services/discovery-scheduler.js';
import { createLogger } from '../../src/utils/logger.js';

import type { ModelDiscoveryService } from '../../src/services/model-discovery.js';
import type { HardwareEstimator } from '../../src/services/hardware-estimator.js';
import type { HardwareProfileRegistry } from '../../src/services/hardware-profiles.js';
import type { QueueService } from '../../src/services/queue-service.js';
import type { DiscoverySchedulerConfig } from '../../src/types/config.js';
import type { ModelInfo } from '../../src/types/benchmark.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'org/model-a',
    name: 'Model A',
    architecture: 'llama',
    contextWindow: 4096,
    license: 'apache-2.0',
    parameterCount: 7_000_000_000,
    quantizations: ['fp16'],
    supportsToolCalling: false,
    ...overrides,
  };
}

function createMockConfig(): DiscoverySchedulerConfig {
  return {
    enabled: true,
    intervalMinutes: 1,
    search: undefined,
    sort: 'downloads',
    maxModelsPerRun: 2,
    minTrendingScore: 0,
    autoQueue: true,
    hardwareProfileId: '1xl4',
    skipRecentlyBenchmarkedDays: 30,
    fallbackSearchProbes: [],
  };
}

function createMockDeps(overrides: Partial<{
  discoveryService: ModelDiscoveryService;
  hardwareEstimator: HardwareEstimator;
  profileRegistry: HardwareProfileRegistry;
  queueService: QueueService;
  config: DiscoverySchedulerConfig;
  logger: ReturnType<typeof createLogger>;
}> = {}) {
  const config = overrides.config ?? createMockConfig();

  const discoveryService = overrides.discoveryService ?? {
    discover: vi.fn().mockResolvedValue({ models: [], totalScanned: 0, totalRejected: 0, timestamp: new Date().toISOString() }),
    fetchModelConfig: vi.fn().mockResolvedValue({ model_type: 'llama', hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
    fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
    isEvaluated: vi.fn().mockReturnValue(false),
    markEvaluated: vi.fn().mockResolvedValue(undefined),
  } as unknown as ModelDiscoveryService;

  const hardwareEstimator = overrides.hardwareEstimator ?? {
    estimateGpuMemory: vi.fn(),
    dryRunCheck: vi.fn().mockReturnValue({ fits: true, estimatedGb: 18, availableGb: 21.6, reason: 'fits' }),
    selectBestProfiles: vi.fn(),
  } as unknown as HardwareEstimator;

  const profileRegistry = overrides.profileRegistry ?? {
    getProfile: vi.fn().mockReturnValue({ id: '1xl4', hardware: { gpuType: 'nvidia-l4', gpuCount: 1, ramGb: 64, cpuCores: 8, diskGb: 200, machineType: 'g2-standard-8' } }),
    listProfiles: vi.fn().mockReturnValue([]),
    registerProfile: vi.fn(),
  } as unknown as HardwareProfileRegistry;

  const queueService = overrides.queueService ?? {
    enqueue: vi.fn().mockResolvedValue(undefined),
    dequeue: vi.fn().mockResolvedValue(undefined),
    getQueueSize: vi.fn().mockReturnValue(0),
    findRecentTerminalModelIds: vi.fn().mockResolvedValue(new Set<string>()),
  } as unknown as QueueService;

  const logger = overrides.logger ?? createLogger('silent');

  return { discoveryService, hardwareEstimator, profileRegistry, queueService, config, logger };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DiscoveryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('trending score calculation', () => {
    it('computes correct trending scores from downloads and createdAt', async () => {
      const now = new Date('2024-06-01T00:00:00Z');
      vi.setSystemTime(now);

      const models = [
        createMockModelInfo({ id: 'org/old-popular' }),
        createMockModelInfo({ id: 'org/new-hot' }),
      ];

      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 2, totalRejected: 0, timestamp: now.toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockImplementation((id: string) => {
          if (id === 'org/old-popular') {
            return Promise.resolve({ downloads: 100, createdAt: '2023-01-01T00:00:00Z' });
          }
          return Promise.resolve({ downloads: 50, createdAt: '2024-05-30T00:00:00Z' });
        }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const deps = createMockDeps({ discoveryService });
      const scheduler = new DiscoveryScheduler(deps);

      const scored = await scheduler.discoverAndScore();

      expect(scored).toHaveLength(2);
      // new-hot should score higher because of recency (100) + decent downloads
      const newHot = scored.find((m) => m.id === 'org/new-hot')!;
      const oldPopular = scored.find((m) => m.id === 'org/old-popular')!;

      expect(newHot.trendingScore).toBeGreaterThan(oldPopular.trendingScore);
      expect(newHot.totalScore).toBeGreaterThan(oldPopular.totalScore);
    });

    it('passes the configured sort key through to the discovery sweep', async () => {
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models: [], totalScanned: 0, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn(),
        fetchModelInfo: vi.fn(),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const config = createMockConfig();
      config.sort = 'lastModified';
      const deps = createMockDeps({ discoveryService, config });
      const scheduler = new DiscoveryScheduler(deps);

      await scheduler.discoverAndScore();

      expect(discoveryService.discover).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'lastModified' }),
      );
    });
  });

  describe('freshness fallback', () => {
    it('retries with lastModified when the primary sort yields 0 hardware-fit candidates', async () => {
      const now = new Date('2024-06-01T00:00:00Z');
      vi.setSystemTime(now);

      const discover = vi
        .fn()
        .mockImplementation((opts: { sort?: string }) =>
          Promise.resolve(
            opts.sort === 'lastModified'
              ? { models: [createMockModelInfo({ id: 'org/fresh' })], totalScanned: 1, totalRejected: 0, timestamp: now.toISOString() }
              : { models: [createMockModelInfo({ id: 'org/stale' })], totalScanned: 1, totalRejected: 0, timestamp: now.toISOString() },
          ),
        );

      const discoveryService = {
        discover,
        fetchModelConfig: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, _fits: id === 'org/fresh' }),
        ),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: now.toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const hardwareEstimator = {
        estimateGpuMemory: vi.fn(),
        dryRunCheck: vi
          .fn()
          .mockImplementation((config: Record<string, unknown>) => ({
            fits: config._fits === true,
            estimatedGb: 18,
            availableGb: 21.6,
            reason: config._fits === true ? 'fits' : 'too big',
          })),
        selectBestProfiles: vi.fn(),
      } as unknown as HardwareEstimator;

      const config = createMockConfig(); // sort: 'downloads'
      const deps = createMockDeps({ discoveryService, hardwareEstimator, config });
      const scheduler = new DiscoveryScheduler(deps);

      const scored = await scheduler.discoverAndScore();

      // Primary (downloads) sweep + fallback (lastModified) sweep.
      expect(discover).toHaveBeenCalledTimes(2);
      expect(discover).toHaveBeenNthCalledWith(1, expect.objectContaining({ sort: 'downloads' }));
      expect(discover).toHaveBeenNthCalledWith(2, expect.objectContaining({ sort: 'lastModified' }));
      // The fresh, hardware-fitting model is surfaced by the fallback.
      const fresh = scored.find((m) => m.id === 'org/fresh');
      expect(fresh?.hardwareFit).toBe(true);
    });

    it('does not retry when the configured sort is already freshness-based', async () => {
      const now = new Date('2024-06-01T00:00:00Z');
      vi.setSystemTime(now);

      const discover = vi.fn().mockResolvedValue({
        models: [createMockModelInfo({ id: 'org/stale' })],
        totalScanned: 1,
        totalRejected: 0,
        timestamp: now.toISOString(),
      });

      const discoveryService = {
        discover,
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, _fits: false }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: now.toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const hardwareEstimator = {
        estimateGpuMemory: vi.fn(),
        dryRunCheck: vi.fn().mockReturnValue({ fits: false, estimatedGb: 90, availableGb: 21.6, reason: 'too big' }),
        selectBestProfiles: vi.fn(),
      } as unknown as HardwareEstimator;

      const config = createMockConfig();
      config.sort = 'lastModified';
      const deps = createMockDeps({ discoveryService, hardwareEstimator, config });
      const scheduler = new DiscoveryScheduler(deps);

      await scheduler.discoverAndScore();

      // No second sweep — the freshness feed is already the primary source.
      expect(discover).toHaveBeenCalledTimes(1);
    });

    it('runs size-targeted search probes when primary + freshness sweeps yield 0 hardware-fit', async () => {
      const now = new Date('2024-06-01T00:00:00Z');
      vi.setSystemTime(now);

      // Empty-search sweeps (downloads + lastModified) only surface a non-fitting
      // model; the `instruct` probe surfaces the fitting one.
      const discover = vi
        .fn()
        .mockImplementation((opts: { sort?: string; search?: string }) =>
          Promise.resolve(
            opts.search === 'instruct'
              ? { models: [createMockModelInfo({ id: 'org/qwen-32b-instruct' })], totalScanned: 1, totalRejected: 0, timestamp: now.toISOString() }
              : { models: [createMockModelInfo({ id: 'org/tiny' })], totalScanned: 1, totalRejected: 0, timestamp: now.toISOString() },
          ),
        );

      const discoveryService = {
        discover,
        fetchModelConfig: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32, _fits: id === 'org/qwen-32b-instruct' }),
        ),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: now.toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const hardwareEstimator = {
        estimateGpuMemory: vi.fn(),
        dryRunCheck: vi
          .fn()
          .mockImplementation((config: Record<string, unknown>) => ({
            fits: config._fits === true,
            estimatedGb: 18,
            availableGb: 21.6,
            reason: config._fits === true ? 'fits' : 'too big',
          })),
        selectBestProfiles: vi.fn(),
      } as unknown as HardwareEstimator;

      const config = createMockConfig(); // sort: 'downloads'
      config.fallbackSearchProbes = ['instruct', 'mistral small'];
      const deps = createMockDeps({ discoveryService, hardwareEstimator, config });
      const scheduler = new DiscoveryScheduler(deps);

      const scored = await scheduler.discoverAndScore();

      // downloads sweep + lastModified sweep + first probe ('instruct').
      expect(discover).toHaveBeenCalledTimes(3);
      expect(discover).toHaveBeenNthCalledWith(3, expect.objectContaining({ sort: 'downloads', search: 'instruct' }));
      // Probe stops early once a fitting candidate is found — 'mistral small' not tried.
      expect(discover).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'mistral small' }));
      const fit = scored.find((m) => m.id === 'org/qwen-32b-instruct');
      expect(fit?.hardwareFit).toBe(true);
    });

    it('filters models below minTrendingScore', async () => {
      const now = new Date('2024-06-01T00:00:00Z');
      vi.setSystemTime(now);

      const models = [createMockModelInfo({ id: 'org/low-trend' })];

      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: now.toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 0, createdAt: '2023-01-01T00:00:00Z' }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const config = createMockConfig();
      config.minTrendingScore = 50;
      const deps = createMockDeps({ discoveryService, config });
      const scheduler = new DiscoveryScheduler(deps);

      const scored = await scheduler.discoverAndScore();
      expect(scored).toHaveLength(0);
    });
  });

  describe('hardware fit filtering', () => {
    it('marks hardwareFit=true when model fits profile', async () => {
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const hardwareEstimator = {
        dryRunCheck: vi.fn().mockReturnValue({ fits: true, estimatedGb: 18, availableGb: 21.6, reason: 'fits' }),
      } as unknown as HardwareEstimator;

      const deps = createMockDeps({ discoveryService, hardwareEstimator });
      const scheduler = new DiscoveryScheduler(deps);
      const scored = await scheduler.discoverAndScore();

      expect(scored[0].hardwareFit).toBe(true);
      expect(scored[0].totalScore).toBeGreaterThanOrEqual(scored[0].trendingScore);
    });

    it('marks hardwareFit=false when model does not fit', async () => {
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 8192, num_hidden_layers: 80, num_attention_heads: 64 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const hardwareEstimator = {
        dryRunCheck: vi.fn().mockReturnValue({ fits: false, estimatedGb: 100, availableGb: 21.6, reason: 'exceeds' }),
      } as unknown as HardwareEstimator;

      const deps = createMockDeps({ discoveryService, hardwareEstimator });
      const scheduler = new DiscoveryScheduler(deps);
      const scored = await scheduler.discoverAndScore();

      expect(scored[0].hardwareFit).toBe(false);
      expect(scored[0].totalScore).toBe(scored[0].trendingScore * 0.6);
    });
  });

  describe('autoQueue', () => {
    it('enqueues models when autoQueue is true', async () => {
      const models = [createMockModelInfo(), createMockModelInfo({ id: 'org/model-b' })];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 2, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const queueService = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      } as unknown as QueueService;

      const deps = createMockDeps({ discoveryService, queueService });
      const scheduler = new DiscoveryScheduler(deps);

      const result = await scheduler.runOnce();
      expect(result.queued).toBe(2);
      expect(result.skipped).toBe(0);
      expect(queueService.enqueue).toHaveBeenCalledTimes(2);
    });

    it('skips all models when autoQueue is false', async () => {
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const queueService = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      } as unknown as QueueService;

      const config = createMockConfig();
      config.autoQueue = false;
      const deps = createMockDeps({ discoveryService, queueService, config });
      const scheduler = new DiscoveryScheduler(deps);

      const result = await scheduler.runOnce();
      expect(result.queued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });

    it('skips models that do not fit the target hardware', async () => {
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const discoveryService = {
        isEvaluated: vi.fn().mockReturnValue(false),
      } as unknown as ModelDiscoveryService;
      const queueService = { enqueue } as unknown as QueueService;
      const deps = createMockDeps({ discoveryService, queueService });
      const scheduler = new DiscoveryScheduler(deps);

      const makeScored = (id: string, hardwareFit: boolean): ScoredModel => ({
        ...createMockModelInfo({ id }),
        trendingScore: 10,
        hardwareFit,
        totalScore: hardwareFit ? 50 : 10,
        createdAt: '2026-01-01T00:00:00Z',
        family: id,
        superseded: false,
      });

      const stats = await scheduler.autoQueue([
        makeScored('org/fits', true),
        makeScored('org/too-big', false),
      ]);

      expect(stats.queued).toBe(1);
      expect(stats.skipped).toBe(1);
      expect(enqueue.mock.calls.map((c) => c[0])).toEqual(['org/fits']);
    });

    it('skips already-evaluated models', async () => {
      const models = [createMockModelInfo(), createMockModelInfo({ id: 'org/model-b' })];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 2, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockImplementation((id: string) => id === 'org/model-a'),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const queueService = {
        enqueue: vi.fn().mockResolvedValue(undefined),
      } as unknown as QueueService;

      const deps = createMockDeps({ discoveryService, queueService });
      const scheduler = new DiscoveryScheduler(deps);

      const result = await scheduler.runOnce();
      expect(result.queued).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('skips models benchmarked or quarantined within the freshness window', async () => {
      const models = [createMockModelInfo(), createMockModelInfo({ id: 'org/model-b' })];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 2, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const enqueue = vi.fn().mockResolvedValue(undefined);
      const queueService = {
        enqueue,
        // model-a was terminal (completed or quarantined) within the window.
        findRecentTerminalModelIds: vi.fn().mockResolvedValue(new Set(['org/model-a'])),
      } as unknown as QueueService;

      const deps = createMockDeps({ discoveryService, queueService });
      const scheduler = new DiscoveryScheduler(deps);

      const result = await scheduler.runOnce();

      expect(result.queued).toBe(1);
      expect(result.skipped).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][0]).toBe('org/model-b');
    });

    it('fails open (queues normally) when the dedup query throws', async () => {
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const queueService = {
        enqueue: vi.fn().mockResolvedValue(undefined),
        findRecentTerminalModelIds: vi.fn().mockRejectedValue(new Error('es down')),
      } as unknown as QueueService;

      const deps = createMockDeps({ discoveryService, queueService });
      const scheduler = new DiscoveryScheduler(deps);

      const result = await scheduler.runOnce();

      expect(result.queued).toBe(1);
      expect(queueService.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('429 retry logic', () => {
    it('retries once on 429 then gives up', async () => {
      const error = new Error('HTTP 429: Too Many Requests');
      const discoveryService = {
        discover: vi.fn().mockRejectedValue(error),
        fetchModelConfig: vi.fn().mockResolvedValue({}),
        fetchModelInfo: vi.fn().mockResolvedValue({}),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const config = createMockConfig();
      config.intervalMinutes = 1;
      const deps = createMockDeps({ discoveryService, config });

      // Override delay so tests don't wait 60s
      const scheduler = new DiscoveryScheduler(deps);
      (scheduler as unknown as { delay: () => Promise<void> }).delay = vi.fn().mockResolvedValue(undefined);

      const scored = await scheduler.discoverAndScore();
      expect(discoveryService.discover).toHaveBeenCalledTimes(2);
      expect(scored).toEqual([]);
    });

    it('succeeds on retry after 429', async () => {
      const error = new Error('HTTP 429: Too Many Requests');
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const deps = createMockDeps({ discoveryService });
      const scheduler = new DiscoveryScheduler(deps);
      (scheduler as unknown as { delay: () => Promise<void> }).delay = vi.fn().mockResolvedValue(undefined);

      const scored = await scheduler.discoverAndScore();
      expect(discoveryService.discover).toHaveBeenCalledTimes(2);
      expect(scored).toHaveLength(1);
    });
  });

  describe('unknown hardware profile fallback', () => {
    it('passes all models with fits=true when profile is missing', async () => {
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const profileRegistry = {
        getProfile: vi.fn().mockReturnValue(undefined),
        listProfiles: vi.fn().mockReturnValue([]),
        registerProfile: vi.fn(),
      } as unknown as HardwareProfileRegistry;

      const deps = createMockDeps({ discoveryService, profileRegistry });
      const scheduler = new DiscoveryScheduler(deps);
      const scored = await scheduler.discoverAndScore();

      expect(scored[0].hardwareFit).toBe(true);
    });
  });

  describe('start/stop timer', () => {
    it('starts interval and runs immediately', async () => {
      const models = [createMockModelInfo()];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 1, totalRejected: 0, timestamp: new Date().toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockResolvedValue({ downloads: 1000, createdAt: new Date().toISOString() }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const deps = createMockDeps({ discoveryService });
      const scheduler = new DiscoveryScheduler(deps);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(discoveryService.discover).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(discoveryService.discover).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('guards against double start', async () => {
      const deps = createMockDeps();
      const scheduler = new DiscoveryScheduler(deps);
      scheduler.start();
      scheduler.start(); // double start
      await vi.advanceTimersByTimeAsync(0);
      // Should not throw and should only schedule one interval
      scheduler.stop();
    });

    it('guards against double stop', () => {
      const deps = createMockDeps();
      const scheduler = new DiscoveryScheduler(deps);
      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // double stop
      // Should not throw
    });
  });

  describe('never throws', () => {
    it('absorbs errors in discoverAndScore and returns empty array', async () => {
      const discoveryService = {
        discover: vi.fn().mockImplementation(() => {
          throw new Error('Kaboom');
        }),
        fetchModelConfig: vi.fn().mockResolvedValue({}),
        fetchModelInfo: vi.fn().mockResolvedValue({}),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const deps = createMockDeps({ discoveryService });
      const scheduler = new DiscoveryScheduler(deps);
      // Non-429 errors should be caught and return empty models
      const scored = await scheduler.discoverAndScore();
      expect(scored).toEqual([]);
    });

    it('absorbs errors in runOnce and returns zero stats', async () => {
      const discoveryService = {
        discover: vi.fn().mockRejectedValue(new Error('Kaboom')),
        fetchModelConfig: vi.fn().mockResolvedValue({}),
        fetchModelInfo: vi.fn().mockResolvedValue({}),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const deps = createMockDeps({ discoveryService });
      const scheduler = new DiscoveryScheduler(deps);
      (scheduler as unknown as { delay: () => Promise<void> }).delay = vi.fn().mockResolvedValue(undefined);

      const result = await scheduler.runOnce();
      expect(result).toEqual({ discovered: 0, queued: 0, skipped: 0, errors: 0, hardwareFitCount: 0 });
    });
  });

  describe('deriveModelFamily', () => {
    it('collapses different generations of the same family to one key', () => {
      expect(deriveModelFamily('Qwen/Qwen2.5-Coder-32B-Instruct')).toBe('qwen/qwen-coder');
      expect(deriveModelFamily('Qwen/Qwen3-Coder-30B-A3B-Instruct')).toBe('qwen/qwen-coder');
      expect(deriveModelFamily('Qwen/Qwen2.5-Coder-32B-Instruct')).toBe(
        deriveModelFamily('Qwen/Qwen3-Coder-30B-A3B-Instruct'),
      );
    });

    it('strips size, series, and variant tokens', () => {
      expect(deriveModelFamily('meta-llama/Llama-3.1-8B-Instruct')).toBe('meta-llama/llama');
      expect(deriveModelFamily('meta-llama/Llama-3.3-70B-Instruct')).toBe('meta-llama/llama');
      expect(deriveModelFamily('mistralai/Mixtral-8x7B-Instruct-v0.1')).toBe('mistralai/mixtral');
    });

    it('keeps distinct families distinct', () => {
      expect(deriveModelFamily('Qwen/Qwen3-Coder-30B-A3B-Instruct')).not.toBe(
        deriveModelFamily('Qwen/Qwen3-32B-Instruct'),
      );
    });
  });

  describe('same-family supersession', () => {
    it('marks the older generation superseded and skips it in autoQueue', async () => {
      const now = new Date('2026-07-04T00:00:00Z');
      vi.setSystemTime(now);

      const models = [
        createMockModelInfo({ id: 'Qwen/Qwen2.5-Coder-32B-Instruct' }),
        createMockModelInfo({ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' }),
      ];
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 2, totalRejected: 0, timestamp: now.toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        fetchModelInfo: vi.fn().mockImplementation((id: string) => {
          if (id === 'Qwen/Qwen2.5-Coder-32B-Instruct') {
            return Promise.resolve({ downloads: 100000, createdAt: '2024-11-01T00:00:00Z' });
          }
          return Promise.resolve({ downloads: 5000, createdAt: '2025-07-01T00:00:00Z' });
        }),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;
      const queueService = { enqueue } as unknown as QueueService;

      const deps = createMockDeps({ discoveryService, queueService });
      const scheduler = new DiscoveryScheduler(deps);

      const scored = await scheduler.discoverAndScore();
      const stale = scored.find((m) => m.id === 'Qwen/Qwen2.5-Coder-32B-Instruct')!;
      const latest = scored.find((m) => m.id === 'Qwen/Qwen3-Coder-30B-A3B-Instruct')!;
      expect(stale.superseded).toBe(true);
      expect(latest.superseded).toBe(false);

      const stats = await scheduler.autoQueue(scored);
      expect(stats.queued).toBe(1);
      expect(stats.skipped).toBe(1);
      const enqueuedIds = enqueue.mock.calls.map((c) => c[0]);
      expect(enqueuedIds).toContain('Qwen/Qwen3-Coder-30B-A3B-Instruct');
      expect(enqueuedIds).not.toContain('Qwen/Qwen2.5-Coder-32B-Instruct');
    });

    it('does NOT supersede same-generation size variants released together', async () => {
      const now = new Date('2026-07-04T00:00:00Z');
      vi.setSystemTime(now);

      const models = [
        createMockModelInfo({ id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' }),
        createMockModelInfo({ id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' }),
      ];
      const discoveryService = {
        discover: vi.fn().mockResolvedValue({ models, totalScanned: 2, totalRejected: 0, timestamp: now.toISOString() }),
        fetchModelConfig: vi.fn().mockResolvedValue({ hidden_size: 4096, num_hidden_layers: 32, num_attention_heads: 32 }),
        // Both released within a few days → within the 30-day supersession gap.
        fetchModelInfo: vi.fn().mockImplementation((id: string) =>
          Promise.resolve({
            downloads: 5000,
            createdAt: id.includes('480B') ? '2025-07-03T00:00:00Z' : '2025-07-01T00:00:00Z',
          }),
        ),
        isEvaluated: vi.fn().mockReturnValue(false),
        markEvaluated: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelDiscoveryService;

      const deps = createMockDeps({ discoveryService });
      const scheduler = new DiscoveryScheduler(deps);

      const scored = await scheduler.discoverAndScore();
      expect(scored.every((m) => !m.superseded)).toBe(true);
    });
  });
});
