// src/services/metrics-collector.ts
import { performance } from 'perf_hooks';

export interface ServiceMetrics {
  operationCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
  lastError?: string;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
}

/**
 * Centralized metrics collection for monitoring service health and performance.
 * Thread-safe, low-overhead metrics tracking.
 */
export class MetricsCollector {
  private metrics = new Map<string, ServiceMetrics>();
  private startTimes = new Map<string, number>();

  /**
   * Start timing an operation.
   * Returns operation ID to use with endOperation().
   */
  startOperation(serviceName: string, operationName: string): string {
    const opId = `${serviceName}.${operationName}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    this.startTimes.set(opId, performance.now());
    return opId;
  }

  /**
   * End timing an operation and record metrics.
   */
  endOperation(opId: string, success: boolean, error?: Error): void {
    const startTime = this.startTimes.get(opId);
    if (!startTime) return;

    const duration = performance.now() - startTime;
    this.startTimes.delete(opId);

    const [serviceName, operationName] = opId.split('.');
    const key = `${serviceName}.${operationName}`;

    const current = this.metrics.get(key) || {
      operationCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      minDurationMs: Infinity,
      maxDurationMs: 0,
      errorCount: 0,
    };

    current.operationCount++;
    current.totalDurationMs += duration;
    current.avgDurationMs = current.totalDurationMs / current.operationCount;
    current.minDurationMs = Math.min(current.minDurationMs, duration);
    current.maxDurationMs = Math.max(current.maxDurationMs, duration);

    if (!success) {
      current.errorCount++;
      current.lastError = error?.message || 'Unknown error';
    }

    this.metrics.set(key, current);
  }

  /**
   * Get metrics for a specific service operation.
   */
  getMetrics(serviceName: string, operationName?: string): ServiceMetrics | Record<string, ServiceMetrics> {
    if (operationName) {
      const key = `${serviceName}.${operationName}`;
      return this.metrics.get(key) || this.emptyMetrics();
    }

    // Return all metrics for service
    const result: Record<string, ServiceMetrics> = {};
    for (const [key, metrics] of this.metrics.entries()) {
      if (key.startsWith(`${serviceName}.`)) {
        result[key] = metrics;
      }
    }
    return result;
  }

  /**
   * Get all metrics for all services.
   */
  getAllMetrics(): Record<string, ServiceMetrics> {
    return Object.fromEntries(this.metrics.entries());
  }

  /**
   * Reset all metrics (useful for testing).
   */
  reset(): void {
    this.metrics.clear();
    this.startTimes.clear();
  }

  private emptyMetrics(): ServiceMetrics {
    return {
      operationCount: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      minDurationMs: 0,
      maxDurationMs: 0,
      errorCount: 0,
    };
  }
}

// Singleton instance
export const metricsCollector = new MetricsCollector();
