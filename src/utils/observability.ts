// src/utils/observability.ts
import { createLogger } from './logger.js';
import { metricsCollector } from '../services/metrics-collector.js';
import { profiler } from './performance-profiler.js';

const logger = createLogger('info');

/**
 * Structured event types for observability.
 */
export type ObservabilityEvent =
  | { type: 'benchmark.started'; modelId: string; queueId: string }
  | { type: 'benchmark.completed'; modelId: string; durationMs: number; passed: boolean }
  | { type: 'discovery.started'; candidateCount: number }
  | { type: 'discovery.completed'; queuedCount: number; durationMs: number }
  | { type: 'vm.acquired'; vmId: string; requestor: string }
  | { type: 'vm.released'; vmId: string; durationMs: number }
  | { type: 'queue.enqueued'; modelId: string; priority: number }
  | { type: 'queue.dequeued'; modelId: string }
  | { type: 'error.occurred'; service: string; operation: string; error: string };

/**
 * Observability hub for structured events, tracing, and monitoring.
 * Provides unified interface for logging, metrics, and tracing.
 */
export class ObservabilityHub {
  private events: ObservabilityEvent[] = [];
  private maxEvents = 1000; // Keep last 1000 events

  /**
   * Emit a structured event.
   * Events are logged, stored, and can be queried for debugging.
   */
  emit(event: ObservabilityEvent, metadata?: Record<string, any>): void {
    const enrichedEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
      ...metadata,
    };

    // Log the event
    logger.info('Observability event', enrichedEvent);

    // Store in circular buffer
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  /**
   * Get recent events (for debugging).
   */
  getRecentEvents(limit: number = 100): ObservabilityEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Get events by type.
   */
  getEventsByType(type: ObservabilityEvent['type']): ObservabilityEvent[] {
    return this.events.filter(e => e.type === type);
  }

  /**
   * Create a traced operation that emits start/end events and tracks metrics.
   */
  async trace<T>(
    service: string,
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const correlationId = crypto.randomUUID();
    const startTime = Date.now();

    logger.info(`[${service}] ${operation} started`, {
      correlationId,
      ...metadata,
    });

    const metricsId = metricsCollector.startOperation(service, operation);

    try {
      const result = await profiler.profile(`${service}.${operation}`, fn, metadata);

      const duration = Date.now() - startTime;
      logger.info(`[${service}] ${operation} completed`, {
        correlationId,
        durationMs: duration,
        success: true,
        ...metadata,
      });

      metricsCollector.endOperation(metricsId, true);

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(`[${service}] ${operation} failed`, {
        correlationId,
        durationMs: duration,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...metadata,
      });

      metricsCollector.endOperation(metricsId, false, error as Error);

      this.emit(
        { type: 'error.occurred', service, operation, error: String(error) },
        { correlationId }
      );

      throw error;
    }
  }

  /**
   * Get observability snapshot (for health dashboard).
   */
  getSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      events: {
        total: this.events.length,
        byType: this.getEventCounts(),
      },
      metrics: metricsCollector.getAllMetrics(),
      memory: profiler.getMemoryUsage(),
      uptime: process.uptime(),
    };
  }

  private getEventCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.events) {
      counts[event.type] = (counts[event.type] || 0) + 1;
    }
    return counts;
  }

  /**
   * Clear all stored events (reset).
   */
  clear(): void {
    this.events = [];
  }
}

// Singleton instance
export const observability = new ObservabilityHub();
