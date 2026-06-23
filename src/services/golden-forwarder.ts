import type { Client } from '@elastic/elasticsearch';
import { createLogger } from '../utils/logger.js';
import type { RecommendationReport } from '../types/recommendation.js';
import type { BenchmarkResult } from '../types/benchmark.js';

export interface ReplicationError {
  message: string;
  timestamp: Date;
  documentId?: string;
  retryCount?: number;
}

export interface GoldenForwarderOptions {
  client: Client;
  enabled: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  dlqIndexName?: string;
  logLevel?: string;
}

interface QueuedDocument {
  id: string;
  index: string;
  body: Record<string, unknown>;
  retryCount: number;
  enqueuedAt: number;
}

/**
 * GoldenForwarder replicates eval traces and benchmark cards to a shared
 * golden Elasticsearch cluster. Write-only — never reads from golden.
 *
 * Batches up to 100 docs, flushes every 5 minutes.
 * On 429: drop last doc from batch and retry.
 * On 5xx: exponential backoff then DLQ after maxRetries.
 */
export class GoldenForwarder {
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly client: Client | null;
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly dlqIndexName: string;

  private queue: QueuedDocument[] = [];
  private readonly errors: ReplicationError[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private dlqCount = 0;
  private forwardedCount = 0;

  constructor(options?: GoldenForwarderOptions) {
    this.enabled = options?.enabled ?? false;
    this.client = options?.client ?? null;
    this.batchSize = options?.batchSize ?? 100;
    this.flushIntervalMs = options?.flushIntervalMs ?? 300_000;
    this.maxRetries = options?.maxRetries ?? 5;
    this.initialBackoffMs = options?.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options?.maxBackoffMs ?? 60_000;
    this.dlqIndexName = options?.dlqIndexName ?? 'benchmarker-dlq';
    this.logger = createLogger(options?.logLevel ?? 'info');
  }

  start(): void {
    if (!this.enabled) {
      this.logger.info('GoldenForwarder disabled — not starting');
      return;
    }
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.logger.error('Flush error', { error: err instanceof Error ? err.message : String(err) });
      });
    }, this.flushIntervalMs);

    this.logger.info('GoldenForwarder started', {
      batchSize: this.batchSize,
      flushIntervalMs: this.flushIntervalMs,
    });
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.logger.info('GoldenForwarder stopped', {
      remaining: this.queue.length,
      forwarded: this.forwardedCount,
      dlq: this.dlqCount,
    });
  }

  enqueue(index: string, id: string, body: Record<string, unknown>): void {
    if (!this.enabled) return;

    this.queue.push({
      id,
      index,
      body,
      retryCount: 0,
      enqueuedAt: Date.now(),
    });

    if (this.queue.length >= this.batchSize) {
      this.flush().catch((err) => {
        this.logger.error('Auto-flush error', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  forwardReport(report: RecommendationReport): void {
    this.enqueue('benchmark-recommendations', report.reportId, report as unknown as Record<string, unknown>);
  }

  forwardBenchmarkResult(result: BenchmarkResult): void {
    this.enqueue('benchmark-results', result.modelId + '_' + result.timestamp, result as unknown as Record<string, unknown>);
  }

  async flush(): Promise<{ forwarded: number; failed: number; dlq: number }> {
    if (this.flushing || this.queue.length === 0 || !this.client) {
      return { forwarded: 0, failed: 0, dlq: 0 };
    }

    this.flushing = true;
    const batch = this.queue.splice(0, this.batchSize);
    let forwarded = 0;
    let failed = 0;
    let dlq = 0;

    try {
      const result = await this.sendBatch(batch);
      forwarded = result.forwarded;
      failed = result.failed;
      dlq = result.dlq;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Batch send failed completely', { error: message, batchSize: batch.length });
      this.recordReplicationError(message);

      for (const doc of batch) {
        doc.retryCount++;
        if (doc.retryCount >= this.maxRetries) {
          await this.sendToDLQ(doc);
          dlq++;
        } else {
          this.queue.unshift(doc);
          failed++;
        }
      }
    } finally {
      this.flushing = false;
    }

    this.forwardedCount += forwarded;
    this.dlqCount += dlq;
    return { forwarded, failed, dlq };
  }

  private async sendBatch(docs: QueuedDocument[]): Promise<{ forwarded: number; failed: number; dlq: number }> {
    if (!this.client || docs.length === 0) {
      return { forwarded: 0, failed: 0, dlq: 0 };
    }

    const operations = docs.flatMap((doc) => [
      { index: { _index: doc.index, _id: doc.id } },
      doc.body,
    ]);

    let forwarded = 0;
    let failed = 0;
    let dlq = 0;

    try {
      const response = await this.client.bulk({ operations, refresh: false });

      if (response.errors) {
        const items = response.items ?? [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          const action = item.index ?? item.create;
          const doc = docs[i]!;
          if (action?.error) {
            const statusCode = action.status ?? 0;

            if (statusCode === 429) {
              doc.retryCount++;
              if (doc.retryCount >= this.maxRetries) {
                await this.sendToDLQ(doc);
                dlq++;
              } else {
                this.queue.push(doc);
                failed++;
              }
              this.recordReplicationError(`429 Too Many Requests for ${doc.id}`);
            } else if (statusCode >= 500) {
              const backoff = this.calculateBackoff(doc.retryCount);
              doc.retryCount++;

              if (doc.retryCount >= this.maxRetries) {
                await this.sendToDLQ(doc);
                dlq++;
              } else {
                setTimeout(() => this.queue.push(doc), backoff);
                failed++;
              }
              this.recordReplicationError(`${statusCode} Server Error for ${doc.id}: ${JSON.stringify(action.error)}`);
            } else {
              await this.sendToDLQ(doc);
              dlq++;
              this.recordReplicationError(`${statusCode} for ${doc.id}: ${JSON.stringify(action.error)}`);
            }
          } else {
            forwarded++;
          }
        }
      } else {
        forwarded = docs.length;
      }
    } catch (err) {
      throw err;
    }

    if (forwarded > 0) {
      this.logger.info('Forwarded to golden cluster', { forwarded, failed, dlq });
    }

    return { forwarded, failed, dlq };
  }

  private async sendToDLQ(doc: QueuedDocument): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.index({
        index: this.dlqIndexName,
        document: {
          original_index: doc.index,
          original_id: doc.id,
          body: doc.body,
          retry_count: doc.retryCount,
          enqueued_at: new Date(doc.enqueuedAt).toISOString(),
          dlq_at: new Date().toISOString(),
          error: this.errors[this.errors.length - 1]?.message ?? 'unknown',
        },
      });
      this.logger.warn('Document sent to DLQ', { id: doc.id, index: doc.index, retries: doc.retryCount });
    } catch (err) {
      this.logger.error('Failed to send to DLQ', {
        id: doc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private calculateBackoff(retryCount: number): number {
    const backoff = this.initialBackoffMs * Math.pow(2, retryCount);
    const jitter = Math.random() * 0.3 * backoff;
    return Math.min(backoff + jitter, this.maxBackoffMs);
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  getForwardedCount(): number {
    return this.forwardedCount;
  }

  getDlqCount(): number {
    return this.dlqCount;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  recordReplicationError(message: string): void {
    this.errors.push({ message, timestamp: new Date() });
    if (this.errors.length > 1000) {
      this.errors.splice(0, this.errors.length - 500);
    }
  }

  getRecentReplicationErrors(lookbackMs: number): ReplicationError[] {
    const cutoff = Date.now() - lookbackMs;
    return this.errors.filter((e) => e.timestamp.getTime() >= cutoff);
  }

  getAllErrors(): ReplicationError[] {
    return [...this.errors];
  }

  clearErrors(): void {
    this.errors.length = 0;
  }

  getStats(): { pending: number; forwarded: number; dlq: number; errors: number; enabled: boolean } {
    return {
      pending: this.queue.length,
      forwarded: this.forwardedCount,
      dlq: this.dlqCount,
      errors: this.errors.length,
      enabled: this.enabled,
    };
  }
}
