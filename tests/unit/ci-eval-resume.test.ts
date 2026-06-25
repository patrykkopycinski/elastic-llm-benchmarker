import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCompletedEvalSuites,
  recoverOrFailActiveEntries,
} from '../../src/services/ci-eval-resume.js';
import type { QueueService } from '../../src/services/queue-service.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { BuildkiteEvalTrigger } from '../../src/services/buildkite-eval-trigger.js';
import type { CIEvalResult } from '../../src/types/ci-eval.js';
import { createLogger } from '../../src/utils/logger.js';

describe('getCompletedEvalSuites', () => {
  it('returns terminal suite ids only', () => {
    const results: CIEvalResult[] = [
      {
        runId: 'r1',
        modelId: 'org/model',
        buildkiteBuildUrl: 'https://example.com/1',
        buildkiteBuildNumber: 1,
        pipelineSlug: 'pipe',
        status: 'passed',
        evalSuites: ['security-alert-triage'],
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T01:00:00Z',
        retryCount: 0,
        connectorJson: '{}',
      },
      {
        runId: 'r2',
        modelId: 'org/model',
        buildkiteBuildUrl: 'https://example.com/2',
        buildkiteBuildNumber: 2,
        pipelineSlug: 'pipe',
        status: 'running',
        evalSuites: ['security-esql-generation-regression'],
        startedAt: '2026-01-01T02:00:00Z',
        completedAt: '2026-01-01T02:00:00Z',
        retryCount: 0,
        connectorJson: '{}',
      },
    ];

    expect(
      getCompletedEvalSuites(results, [
        'security-alert-triage',
        'security-esql-generation-regression',
      ]),
    ).toEqual(['security-alert-triage']);
  });
});

describe('recoverOrFailActiveEntries', () => {
  const logger = createLogger('error');
  const evalSuites = ['security-alert-triage'];

  let queueService: QueueService;
  let resultsStore: ElasticsearchResultsStore;
  let buildkiteTrigger: BuildkiteEvalTrigger;

  beforeEach(() => {
    queueService = {
      getActiveEntries: vi.fn(),
      updateStatus: vi.fn(),
    } as unknown as QueueService;
    resultsStore = {
      getCIEvalResults: vi.fn(),
    } as unknown as ElasticsearchResultsStore;
    buildkiteTrigger = {
      getBuildState: vi.fn(),
    } as unknown as BuildkiteEvalTrigger;
  });

  it('recovers benchmarking entry with running Buildkite build', async () => {
    vi.mocked(queueService.getActiveEntries).mockResolvedValue([
      {
        id: 'q1',
        modelId: 'Qwen/Qwen2.5-7B-Instruct',
        source: 'user',
        priority: 100,
        status: 'benchmarking',
        requestedAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:01:00Z',
        completedAt: null,
        errorMessage: null,
        requestedBy: null,
      },
    ]);
    vi.mocked(resultsStore.getCIEvalResults).mockResolvedValue([
      {
        runId: 'r1',
        modelId: 'Qwen/Qwen2.5-7B-Instruct',
        buildkiteBuildUrl: 'https://example.com/42',
        buildkiteBuildNumber: 42,
        pipelineSlug: 'kibana-evals-on-demand-llm-evals',
        status: 'running',
        evalSuites: ['security-alert-triage'],
        startedAt: '2026-01-01T00:02:00Z',
        completedAt: '2026-01-01T00:02:00Z',
        retryCount: 0,
        connectorJson: '{}',
      },
    ]);
    vi.mocked(buildkiteTrigger.getBuildState).mockResolvedValue('running');

    const result = await recoverOrFailActiveEntries(
      queueService,
      resultsStore,
      buildkiteTrigger,
      evalSuites,
      logger,
    );

    expect(result).toEqual({ recovered: 1, failed: 0 });
    expect(queueService.updateStatus).not.toHaveBeenCalled();
  });

  it('fails benchmarking entry when Buildkite build is terminal', async () => {
    vi.mocked(queueService.getActiveEntries).mockResolvedValue([
      {
        id: 'q1',
        modelId: 'Qwen/Qwen2.5-7B-Instruct',
        source: 'user',
        priority: 100,
        status: 'benchmarking',
        requestedAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:01:00Z',
        completedAt: null,
        errorMessage: null,
        requestedBy: null,
      },
    ]);
    vi.mocked(resultsStore.getCIEvalResults).mockResolvedValue([
      {
        runId: 'r1',
        modelId: 'Qwen/Qwen2.5-7B-Instruct',
        buildkiteBuildUrl: 'https://example.com/42',
        buildkiteBuildNumber: 42,
        pipelineSlug: 'kibana-evals-on-demand-llm-evals',
        status: 'running',
        evalSuites: ['security-alert-triage'],
        startedAt: '2026-01-01T00:02:00Z',
        completedAt: '2026-01-01T00:02:00Z',
        retryCount: 0,
        connectorJson: '{}',
      },
    ]);
    vi.mocked(buildkiteTrigger.getBuildState).mockResolvedValue('passed');

    const result = await recoverOrFailActiveEntries(
      queueService,
      resultsStore,
      buildkiteTrigger,
      evalSuites,
      logger,
    );

    expect(result).toEqual({ recovered: 0, failed: 1 });
    expect(queueService.updateStatus).toHaveBeenCalledWith(
      'q1',
      'failed',
      expect.stringContaining('Orphaned active entry'),
    );
  });
});
