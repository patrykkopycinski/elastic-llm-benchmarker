import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createQueueServer } from '../../src/api/queue-server.js';
import type { QueueService } from '../../src/services/queue-service.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import type { Client } from '@elastic/elasticsearch';

function createMockQueueService(): QueueService {
  return {
    enqueue: vi.fn().mockResolvedValue({
      id: 'eval-123',
      status: 'pending',
      requestedAt: '2026-06-15T00:00:00Z',
    }),
    getById: vi.fn().mockImplementation((id: string) => {
      if (id === 'eval-123') {
        return Promise.resolve({
          id: 'eval-123',
          modelId: 'meta-llama/Llama-3-8B',
          status: 'completed',
          source: 'user',
          requestedAt: '2026-06-15T00:00:00Z',
          startedAt: '2026-06-15T00:01:00Z',
          completedAt: '2026-06-15T00:10:00Z',
          errorMessage: null,
          requestedBy: 'test-user',
        });
      }
      return Promise.resolve(null);
    }),
    getQueue: vi.fn().mockResolvedValue([
      {
        id: 'eval-123',
        modelId: 'meta-llama/Llama-3-8B',
        status: 'pending',
        source: 'user',
        requestedAt: '2026-06-15T00:00:00Z',
        priority: 0,
        requestedBy: 'test-user',
      },
    ]),
    getCurrent: vi.fn().mockResolvedValue({
      id: 'eval-456',
      modelId: 'meta-llama/Llama-3-70B',
      status: 'running',
      source: 'discovery',
      requestedAt: '2026-06-15T00:00:00Z',
      startedAt: '2026-06-15T00:01:00Z',
    }),
    getPending: vi.fn().mockResolvedValue(3),
    cancel: vi.fn().mockImplementation((id: string) => {
      if (id === 'eval-123') return Promise.resolve(true);
      if (id === 'eval-999') return Promise.resolve(false);
      return Promise.resolve(null);
    }),
  } as unknown as QueueService;
}

function createMockResultsStore(): ElasticsearchResultsStore {
  return {
    queryModels: vi.fn().mockResolvedValue([
      {
        modelId: 'meta-llama/Llama-3-8B',
        architecture: 'llama',
        source: 'huggingface',
        lastTestedAt: '2026-06-15T00:00:00Z',
        latestResultId: 'result-1',
      },
    ]),
    getModelSummary: vi.fn().mockResolvedValue({
      totalRuns: 5,
      passRate: 0.8,
      avgThroughput: 1200,
      bestConfig: { tensorParallelSize: 4 },
    }),
  } as unknown as ElasticsearchResultsStore;
}

function createMockEsClient(): Client {
  return {
    cluster: {
      health: vi.fn().mockResolvedValue({ status: 'green' }),
    },
    search: vi.fn().mockResolvedValue({ hits: { hits: [] } }),
  } as unknown as Client;
}

describe('Queue Server', () => {
  let queueService: QueueService;
  let resultsStore: ElasticsearchResultsStore;
  let esClient: Client;

  beforeEach(() => {
    queueService = createMockQueueService();
    resultsStore = createMockResultsStore();
    esClient = createMockEsClient();
  });

  describe('unauthenticated routes', () => {
    it('GET /healthz should return healthy when ES is green', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'healthy', elasticsearch: 'green' });
    });

    it('GET /healthz should return 503 when ES is red', async () => {
      const badClient = {
        ...esClient,
        cluster: {
          health: vi.fn().mockResolvedValue({ status: 'red' }),
        },
      } as unknown as Client;
      const app = createQueueServer({ esClient: badClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
    });

    it('GET /api/queue should return entries', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/api/queue');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('v1 routes without auth', () => {
    it('POST /api/v1/evaluate should queue a model', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app)
        .post('/api/v1/evaluate')
        .send({ modelId: 'meta-llama/Llama-3-8B', priority: 1, requestedBy: 'test' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('eval-123');
    });

    it('POST /api/v1/evaluate should reject missing modelId', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).post('/api/v1/evaluate').send({});
      expect(res.status).toBe(400);
    });

    it('POST /api/v1/evaluate should reject invalid modelId', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).post('/api/v1/evaluate').send({ modelId: 'bad<>id' });
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/evaluate/:id should return evaluation status', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/api/v1/evaluate/eval-123');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('eval-123');
      expect(res.body.status).toBe('completed');
    });

    it('GET /api/v1/evaluate/:id should return 404 for unknown id', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/api/v1/evaluate/unknown');
      expect(res.status).toBe(404);
    });

    it('GET /api/v1/models should list models', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/api/v1/models');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.models[0].modelId).toBe('meta-llama/Llama-3-8B');
    });

    it('GET /api/v1/models?summaries=true should include summaries', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/api/v1/models?summaries=true');
      expect(res.status).toBe(200);
      expect(res.body.models[0].summary).toBeDefined();
    });

    it('GET /api/v1/queue should include counts', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).get('/api/v1/queue');
      expect(res.status).toBe(200);
      expect(res.body.pendingCount).toBe(3);
      expect(res.body.current).toBeDefined();
      expect(Array.isArray(res.body.entries)).toBe(true);
    });

    it('DELETE /api/v1/queue/:id should cancel pending', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).delete('/api/v1/queue/eval-123');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('DELETE /api/v1/queue/:id should return 404 for unknown', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).delete('/api/v1/queue/unknown');
      expect(res.status).toBe(404);
    });

    it('DELETE /api/v1/queue/:id should return 409 if not pending', async () => {
      const app = createQueueServer({ esClient, queueService, resultsStore, requireAuth: false });
      const res = await request(app).delete('/api/v1/queue/eval-999');
      expect(res.status).toBe(409);
    });
  });

  describe('auth middleware', () => {
    it('should reject requests without Bearer token when auth is required', async () => {
      const app = createQueueServer({
        esClient,
        queueService,
        resultsStore,
        requireAuth: true,
        apiKeys: [],
      });
      const res = await request(app).get('/api/v1/queue');
      expect(res.status).toBe(401);
    });

    it('should reject invalid Bearer token', async () => {
      const app = createQueueServer({
        esClient,
        queueService,
        resultsStore,
        requireAuth: true,
        apiKeys: [],
      });
      const res = await request(app).get('/api/v1/queue').set('Authorization', 'Bearer bad-token');
      expect(res.status).toBe(403);
    });

    it('should accept valid Bearer token from apiKeys', async () => {
      const { createHash } = await import('node:crypto');
      const token = 'valid-token-123';
      const hash = createHash('sha256').update(token).digest('hex');
      const app = createQueueServer({
        esClient,
        queueService,
        resultsStore,
        requireAuth: true,
        apiKeys: [hash],
      });
      const res = await request(app).get('/api/v1/queue').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  describe('rate limiting', () => {
    it('should return 429 after exceeding rate limit', async () => {
      const { createHash } = await import('node:crypto');
      const token = 'rate-limit-token';
      const hash = createHash('sha256').update(token).digest('hex');
      const app = createQueueServer({
        esClient,
        queueService,
        resultsStore,
        requireAuth: true,
        apiKeys: [hash],
      });

      // Make 101 requests quickly
      const requests = Array.from({ length: 101 }, () =>
        request(app).get('/api/v1/queue').set('Authorization', `Bearer ${token}`),
      );
      const responses = await Promise.all(requests);
      const okCount = responses.filter((r) => r.status === 200).length;
      const rateLimitedCount = responses.filter((r) => r.status === 429).length;

      expect(okCount).toBeLessThanOrEqual(100);
      expect(rateLimitedCount).toBeGreaterThanOrEqual(1);
    });
  });
});
