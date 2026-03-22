import type { Client } from '@elastic/elasticsearch';
import { INDEX_NAMES } from './es-index-mappings.js';

const INDEX = INDEX_NAMES.BENCHMARKER_QUEUE;

export interface QueueEntry {
  id: string;
  modelId: string;
  source: 'user' | 'discovery';
  priority: number;
  status: 'pending' | 'deploying' | 'benchmarking' | 'completed' | 'failed' | 'cancelled';
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  requestedBy: string | null;
  metadata?: {
    configOverrides?: {
      tensorParallelSize?: number;
      maxModelLen?: number;
    };
    skipReasoning?: boolean;
  };
}

type EsSource = {
  model_id: string;
  source: 'user' | 'discovery';
  priority: number;
  status: QueueEntry['status'];
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  requested_by: string | null;
  metadata?: {
    config_overrides?: {
      tensor_parallel_size?: number;
      max_model_len?: number;
    };
    skip_reasoning?: boolean;
  };
};

function toEntry(id: string, src: EsSource): QueueEntry {
  return {
    id,
    modelId: src.model_id,
    source: src.source,
    priority: src.priority,
    status: src.status,
    requestedAt: src.requested_at,
    startedAt: src.started_at ?? null,
    completedAt: src.completed_at ?? null,
    errorMessage: src.error_message ?? null,
    requestedBy: src.requested_by ?? null,
    metadata: src.metadata ? {
      configOverrides: src.metadata.config_overrides ? {
        tensorParallelSize: src.metadata.config_overrides.tensor_parallel_size,
        maxModelLen: src.metadata.config_overrides.max_model_len,
      } : undefined,
      skipReasoning: src.metadata.skip_reasoning,
    } : undefined,
  };
}

export class QueueService {
  constructor(private readonly esClient: Client) { }

  async enqueue(
    modelId: string,
    source: 'user' | 'discovery',
    priority?: number,
    requestedBy?: string,
    metadata?: QueueEntry['metadata'],
  ): Promise<QueueEntry> {
    const p = priority ?? (source === 'user' ? 100 : 10);
    const now = new Date().toISOString();
    const doc: EsSource = {
      model_id: modelId,
      source,
      priority: p,
      status: 'pending',
      requested_at: now,
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: requestedBy ?? null,
      metadata: metadata ? {
        config_overrides: metadata.configOverrides ? {
          tensor_parallel_size: metadata.configOverrides.tensorParallelSize,
          max_model_len: metadata.configOverrides.maxModelLen,
        } : undefined,
        skip_reasoning: metadata.skipReasoning,
      } : undefined,
    };
    const res = await this.esClient.index({
      index: INDEX,
      document: doc,
      refresh: true,
    });
    const id = res._id!;
    return toEntry(id, doc);
  }

  async dequeue(): Promise<QueueEntry | null> {
    const searchRes = await this.esClient.search<EsSource>({
      index: INDEX,
      query: { term: { status: 'pending' } },
      sort: [{ priority: { order: 'desc' } }, { requested_at: { order: 'asc' } }],
      size: 1,
    });
    const hit = searchRes.hits.hits[0];
    if (!hit) return null;

    const now = new Date().toISOString();
    const updateRes = await this.esClient.update({
      index: INDEX,
      id: hit._id!,
      script: {
        source: `
          if (ctx._source.status == 'pending') {
            ctx._source.status = 'deploying';
            ctx._source.started_at = params.now;
          } else {
            ctx.op = 'none';
          }
        `,
        params: { now },
      },
      refresh: true,
    });

    if (updateRes.result === 'noop') return null;

    const getRes = await this.esClient.get<EsSource>({
      index: INDEX,
      id: hit._id!,
    });
    return toEntry(getRes._id!, getRes._source!);
  }

  async getQueue(filters?: { status?: string; source?: string }): Promise<QueueEntry[]> {
    const must: object[] = [];
    if (filters?.status) must.push({ term: { status: filters.status } });
    if (filters?.source) must.push({ term: { source: filters.source } });
    const query = must.length > 0 ? { bool: { must } } : { match_all: {} };

    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query,
      sort: [{ priority: { order: 'desc' } }, { requested_at: { order: 'asc' } }],
      size: 100,
    });

    return res.hits.hits.map((h) => toEntry(h._id!, h._source!));
  }

  /**
   * Get a specific queue entry by ID (efficient for polling).
   * Much faster than getQueue() when only one entry is needed.
   */
  async getById(id: string): Promise<QueueEntry | null> {
    try {
      const res = await this.esClient.get<EsSource>({
        index: INDEX,
        id,
      });

      if (!res.found || !res._source) {
        return null;
      }

      return toEntry(res._id!, res._source);
    } catch (err: any) {
      if (err.statusCode === 404 || err.meta?.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getCurrent(): Promise<QueueEntry | null> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          should: [
            { term: { status: 'deploying' } },
            { term: { status: 'benchmarking' } },
          ],
          minimum_should_match: 1,
        },
      },
      size: 1,
    });
    const hit = res.hits.hits[0];
    if (!hit) return null;
    return toEntry(hit._id!, hit._source!);
  }

  async updateStatus(
    id: string,
    status: QueueEntry['status'],
    errorMessage?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);

    const updates: string[] = [
      `ctx._source.status = params.status;`,
      ...(terminal ? [`ctx._source.completed_at = params.now;`] : []),
      ...(errorMessage !== undefined ? [`ctx._source.error_message = params.error_message;`] : []),
    ];

    await this.esClient.update({
      index: INDEX,
      id,
      script: {
        source: updates.join(' '),
        params: {
          status,
          now,
          error_message: errorMessage ?? null,
        },
      },
      refresh: true,
    });
  }

  async cancel(id: string): Promise<boolean | null> {
    try {
      const updateRes = await this.esClient.update({
        index: INDEX,
        id,
        script: {
          source: `
            if (ctx._source.status == 'pending') {
              ctx._source.status = 'cancelled';
              ctx._source.completed_at = params.now;
            } else {
              ctx.op = 'none';
            }
          `,
          params: { now: new Date().toISOString() },
        },
        refresh: true,
      });
      return updateRes.result !== 'noop';
    } catch (err: unknown) {
      if (
        err != null &&
        typeof err === 'object' &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async hasPending(): Promise<boolean> {
    const res = await this.esClient.count({
      index: INDEX,
      query: { term: { status: 'pending' } },
    });
    return (res.count ?? 0) > 0;
  }

  async shouldAutoStop(entryId: string, maxDurationMs: number): Promise<boolean> {
    const [entryRes, pendingRes] = await Promise.all([
      this.esClient.get<EsSource>({ index: INDEX, id: entryId }).catch(() => null),
      this.esClient.count({
        index: INDEX,
        query: { term: { status: 'pending' } },
      }),
    ]);

    if (!entryRes?.found || !entryRes._source) return false;
    const src = entryRes._source;
    if (src.status !== 'deploying' && src.status !== 'benchmarking') return false;
    if ((pendingRes.count ?? 0) === 0) return false;

    const startedAt = src.started_at;
    if (!startedAt) return false;
    const elapsed = Date.now() - new Date(startedAt).getTime();
    return elapsed > maxDurationMs;
  }
}
