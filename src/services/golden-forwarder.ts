/**
 * GoldenForwarder buffers replication requests to the golden Elasticsearch cluster.
 *
 * Tracks pending items and replication errors for health-check visibility.
 */

export interface ReplicationError {
  message: string;
  timestamp: Date;
}

export class GoldenForwarder {
  private pendingCount = 0;
  private readonly errors: ReplicationError[] = [];

  getPendingCount(): number {
    return this.pendingCount;
  }

  incrementPending(): void {
    this.pendingCount++;
  }

  decrementPending(): void {
    this.pendingCount = Math.max(0, this.pendingCount - 1);
  }

  recordReplicationError(message: string): void {
    this.errors.push({ message, timestamp: new Date() });
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
}
