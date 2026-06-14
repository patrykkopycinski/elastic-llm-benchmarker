import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEnqueue, type EnqueueOptions } from '../../src/cli/enqueue-handler.js';
import { QueueService } from '../../src/services/queue-service.js';
import { HardwareEstimator } from '../../src/services/hardware-estimator.js';
import { HardwareProfileRegistry } from '../../src/services/hardware-profiles.js';
import { ModelDiscoveryService } from '../../src/services/model-discovery.js';
import type { AppConfig } from '../../src/types/config.js';

vi.mock('../../src/services/queue-service.js');
vi.mock('../../src/services/hardware-estimator.js');
vi.mock('../../src/services/hardware-profiles.js');
vi.mock('../../src/services/model-discovery.js');

const mockConfig: AppConfig = {
  huggingfaceToken: 'hf_test_token',
  esCluster: {
    node: 'http://localhost:9200',
    auth: { username: 'elastic', password: 'elastic' },
  },
  logLevel: 'info',
} as unknown as AppConfig;

describe('runEnqueue', () => {
  let mockEsClient: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEsClient = {};

    vi.mocked(QueueService).mockImplementation(() => ({
      enqueue: vi.fn().mockResolvedValue({ id: 'entry-123' }),
    } as unknown as QueueService));

    vi.mocked(ModelDiscoveryService).mockImplementation(() => ({
      fetchModelConfig: vi.fn().mockResolvedValue({
        quantization_config: { bits: 8 },
        max_position_embeddings: 4096,
      }),
    } as unknown as ModelDiscoveryService));

    vi.mocked(HardwareProfileRegistry).mockImplementation(() => ({
      getProfile: vi.fn().mockReturnValue({
        id: '1xl4',
        name: '1x L4',
        hardware: {
          gpuType: 'NVIDIA_L4',
          gpuCount: 1,
          vramPerGpuGb: 24,
          ramGb: 32,
          cpuCores: 8,
          storageGb: 250,
        },
      }),
    } as unknown as HardwareProfileRegistry));

    vi.mocked(HardwareEstimator).mockImplementation(() => ({
      dryRunCheck: vi.fn().mockReturnValue({
        fits: true,
        estimatedGb: 12.5,
        availableGb: 24,
        confidence: 'high' as const,
        reason: 'Fits within available VRAM',
      }),
    } as unknown as HardwareEstimator));
  });

  it('should enqueue a model successfully after passing hardware fit', async () => {
    const result = await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
      hardwareProfileId: '1xl4',
      priority: 5,
    } as EnqueueOptions);

    expect(result.success).toBe(true);
    expect(result.entryId).toBe('entry-123');
    expect(result.dryRun?.fits).toBe(true);
  });

  it('should fail if config.json cannot be fetched and force=false', async () => {
    vi.mocked(ModelDiscoveryService).mockImplementation(() => ({
      fetchModelConfig: vi.fn().mockResolvedValue(null),
    } as unknown as ModelDiscoveryService));

    const result = await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
    } as EnqueueOptions);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/config.json/);
  });

  it('should enqueue with force=true even if config.json is missing', async () => {
    vi.mocked(ModelDiscoveryService).mockImplementation(() => ({
      fetchModelConfig: vi.fn().mockResolvedValue(null),
    } as unknown as ModelDiscoveryService));

    const result = await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
      force: true,
    } as EnqueueOptions);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/forced/);
  });

  it('should fail if hardware fit check fails and force=false', async () => {
    vi.mocked(HardwareEstimator).mockImplementation(() => ({
      dryRunCheck: vi.fn().mockReturnValue({
        fits: false,
        estimatedGb: 48,
        availableGb: 24,
        confidence: 'low' as const,
        reason: 'Estimated VRAM exceeds available VRAM',
      }),
    } as unknown as HardwareEstimator));

    const result = await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
    } as EnqueueOptions);

    expect(result.success).toBe(false);
    expect(result.dryRun?.fits).toBe(false);
  });

  it('should enqueue with force=true even if hardware fit fails', async () => {
    vi.mocked(HardwareEstimator).mockImplementation(() => ({
      dryRunCheck: vi.fn().mockReturnValue({
        fits: false,
        estimatedGb: 48,
        availableGb: 24,
        confidence: 'low' as const,
        reason: 'Estimated VRAM exceeds available VRAM',
      }),
    } as unknown as HardwareEstimator));

    const result = await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
      force: true,
    } as EnqueueOptions);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/forced/);
  });

  it('should fail if hardware profile is not found', async () => {
    vi.mocked(HardwareProfileRegistry).mockImplementation(() => ({
      getProfile: vi.fn().mockReturnValue(null),
    } as unknown as HardwareProfileRegistry));

    const result = await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
      hardwareProfileId: 'unknown',
    } as EnqueueOptions);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/);
  });

  it('should store reason in metadata when provided', async () => {
    const enqueueMock = vi.fn().mockResolvedValue({ id: 'entry-456' });
    vi.mocked(QueueService).mockImplementation(() => ({
      enqueue: enqueueMock,
    } as unknown as QueueService));

    await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
      reason: 'Hot fix validation',
    } as EnqueueOptions);

    expect(enqueueMock).toHaveBeenCalledWith(
      'org/name',
      'user',
      5,
      undefined,
      expect.objectContaining({ reason: 'Hot fix validation' }),
    );
  });

  it('should use custom priority when provided', async () => {
    const enqueueMock = vi.fn().mockResolvedValue({ id: 'entry-789' });
    vi.mocked(QueueService).mockImplementation(() => ({
      enqueue: enqueueMock,
    } as unknown as QueueService));

    await runEnqueue({
      modelId: 'org/name',
      config: mockConfig,
      esClient: mockEsClient as AppConfig,
      priority: 1,
    } as EnqueueOptions);

    expect(enqueueMock).toHaveBeenCalledWith(
      'org/name',
      'user',
      1,
      undefined,
      expect.anything(),
    );
  });
});
