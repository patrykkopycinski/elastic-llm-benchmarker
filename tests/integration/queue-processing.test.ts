// tests/integration/queue-processing.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@elastic/elasticsearch';
import { QueueService } from '../../src/services/queue-service.js';

describe('QueueService Integration', () => {
  let esClient: Client;
  let queueService: QueueService;

  beforeAll(async () => {
    esClient = new Client({
      node: process.env.ES_URL || 'http://localhost:9200',
      auth: {
        username: 'elastic',
        password: process.env.ELASTIC_PASSWORD || 'changeme',
      },
    });
    queueService = new QueueService(esClient);

    // Clean up any existing test data
    try {
      await esClient.indices.delete({ index: 'benchmarker-queue' });
    } catch {
      // Index might not exist, that's ok
    }

    // Create index
    await esClient.indices.create({
      index: 'benchmarker-queue',
      mappings: {
        properties: {
          model_id: { type: 'keyword' },
          source: { type: 'keyword' },
          priority: { type: 'integer' },
          status: { type: 'keyword' },
          requested_at: { type: 'date' },
          started_at: { type: 'date' },
          completed_at: { type: 'date' },
          error_message: { type: 'text' },
          requested_by: { type: 'keyword' },
        },
      },
    });
  });

  afterAll(async () => {
    try {
      await esClient.indices.delete({ index: 'benchmarker-queue' });
    } catch {
      // Ignore errors
    }
    await esClient.close();
  });

  it('should process priority queue in correct order', async () => {
    // Add three entries with different priorities
    await queueService.enqueue('model-1', 'discovery', 50, 'langgraph');
    await queueService.enqueue('model-2', 'user', 100, 'user');
    await queueService.enqueue('model-3', 'discovery', 50, 'langgraph');

    // Dequeue should return highest priority first
    const next = await queueService.dequeue();
    expect(next?.modelId).toBe('model-2'); // Highest priority (100)
  });

  it('should persist queue across service restarts', async () => {
    // Add an entry
    const entry = await queueService.enqueue('persistent-model', 'user', 75, 'user');

    // Simulate restart by creating a new service instance
    const newService = new QueueService(esClient);

    // Get the entry using getQueue with filters
    const queue = await newService.getQueue({ status: 'pending' });
    const found = queue.find(e => e.modelId === 'persistent-model');

    expect(found).toBeDefined();
    expect(found?.priority).toBe(75);
  });

  it('should update entry status correctly', async () => {
    // Add an entry
    const entry = await queueService.enqueue('status-test', 'user', 80);

    // Dequeue it (changes status to 'deploying')
    const dequeued = await queueService.dequeue();
    expect(dequeued?.status).toBe('deploying');

    // Update status to completed
    await queueService.updateStatus(entry.id, 'completed');

    // Verify status update
    const queue = await queueService.getQueue({ status: 'completed' });
    const found = queue.find(e => e.modelId === 'status-test');
    expect(found?.status).toBe('completed');
    expect(found?.completedAt).toBeDefined();
  });
});
