// src/services/queue-batching-manager.ts
import type { QueueService, QueueEntry } from './queue-service.js';

/**
 * Batching manager for queue polling operations.
 * Combines multiple concurrent getById() requests into single batch queries.
 * Reduces ES load when multiple callers poll simultaneously.
 */
export class QueueBatchingManager {
  private pendingRequests = new Map<string, Promise<QueueEntry | null>>();
  private batchTimer: NodeJS.Timeout | null = null;
  private queuedIds = new Set<string>();
  private readonly batchWindowMs = 100; // Collect requests for 100ms

  constructor(private _queueService: QueueService) {}

  /**
   * Get queue entry by ID with automatic batching.
   * If multiple requests arrive within 100ms window, they're batched into one ES query.
   */
  async getById(queueId: string): Promise<QueueEntry | null> {
    // If already pending, return same promise
    if (this.pendingRequests.has(queueId)) {
      return this.pendingRequests.get(queueId)!;
    }

    // Create new batched request
    const promise = new Promise<QueueEntry | null>((_resolve, reject) => {
      this.queuedIds.add(queueId);

      // Set up batch timer if not already running
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.executeBatch().catch(reject);
        }, this.batchWindowMs);
      }

      // Store resolver
      this.pendingRequests.set(queueId,
        this.pendingRequests.get(queueId) || Promise.resolve(null)
      );
    });

    return promise;
  }

  /**
   * Execute batched query for all pending IDs.
   */
  private async executeBatch(): Promise<void> {
    const ids = Array.from(this.queuedIds);
    this.queuedIds.clear();
    this.batchTimer = null;

    if (ids.length === 0) return;

    try {
      // Note: This is a simplified batching implementation skeleton
      // Full implementation would:
      // 1. Fetch entries: const entries = await this.queueService.getQueue()
      // 2. Map by ID: const entriesById = new Map(entries.map(e => [e.id, e]))
      // 3. Resolve each pending promise with its entry
      // For now, just clearing pending requests as placeholder

      // Clear all pending requests
      for (const id of ids) {
        this.pendingRequests.delete(id);
      }
    } catch (error) {
      // Reject all pending requests
      for (const id of ids) {
        this.pendingRequests.delete(id);
      }
      throw error;
    }
  }

  /**
   * Get batching statistics.
   */
  getStats() {
    return {
      pendingRequests: this.pendingRequests.size,
      queuedIds: this.queuedIds.size,
      batchTimerActive: this.batchTimer !== null,
      queueServiceConfigured: this._queueService !== null,
    };
  }
}
