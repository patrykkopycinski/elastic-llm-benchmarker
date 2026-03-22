// src/utils/performance-profiler.ts
import { performance, PerformanceObserver } from 'perf_hooks';
import { createLogger } from './logger.js';

const logger = createLogger('info');

/**
 * Performance profiling utilities for identifying bottlenecks.
 * Uses Node.js performance API for high-precision measurements.
 */
export class PerformanceProfiler {
  private observer: PerformanceObserver | null = null;
  private marks = new Map<string, number>();

  constructor(private enabled: boolean = process.env.ENABLE_PROFILING === 'true') {
    if (this.enabled) {
      this.setupObserver();
    }
  }

  private setupObserver() {
    this.observer = new PerformanceObserver((items) => {
      for (const entry of items.getEntries()) {
        if (entry.entryType === 'measure') {
          logger.info('Performance measurement', {
            name: entry.name,
            duration: entry.duration.toFixed(2) + 'ms',
            startTime: entry.startTime.toFixed(2),
          });
        }
      }
    });
    this.observer.observe({ entryTypes: ['measure'] });
  }

  /**
   * Mark start of an operation.
   */
  mark(name: string): void {
    if (!this.enabled) return;

    const markName = `${name}-start`;
    performance.mark(markName);
    this.marks.set(name, performance.now());
  }

  /**
   * Measure duration since mark and log result.
   */
  measure(name: string, metadata?: Record<string, any>): number {
    if (!this.enabled) return 0;

    const startTime = this.marks.get(name);
    if (!startTime) {
      logger.warn('Performance mark not found', { name });
      return 0;
    }

    const duration = performance.now() - startTime;
    performance.measure(name, `${name}-start`);

    this.marks.delete(name);

    if (metadata) {
      logger.debug('Performance', { operation: name, durationMs: duration.toFixed(2), ...metadata });
    }

    return duration;
  }

  /**
   * Profile an async function execution.
   */
  async profile<T>(
    name: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    if (!this.enabled) {
      return await fn();
    }

    this.mark(name);

    try {
      const result = await fn();
      const duration = this.measure(name, metadata);

      logger.info('Profiled operation completed', {
        operation: name,
        duration: duration.toFixed(2) + 'ms',
        success: true,
        ...metadata,
      });

      return result;
    } catch (error) {
      const duration = this.measure(name, metadata);

      logger.error('Profiled operation failed', {
        operation: name,
        duration: duration.toFixed(2) + 'ms',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...metadata,
      });

      throw error;
    }
  }

  /**
   * Get current memory usage.
   */
  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      heapUsedMB: (usage.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (usage.heapTotal / 1024 / 1024).toFixed(2),
      rssMB: (usage.rss / 1024 / 1024).toFixed(2),
      externalMB: (usage.external / 1024 / 1024).toFixed(2),
    };
  }

  /**
   * Clear all marks and measurements.
   */
  clear(): void {
    this.marks.clear();
    performance.clearMarks();
    performance.clearMeasures();
  }

  /**
   * Stop observing (cleanup).
   */
  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.clear();
  }
}

// Singleton instance
export const profiler = new PerformanceProfiler();
