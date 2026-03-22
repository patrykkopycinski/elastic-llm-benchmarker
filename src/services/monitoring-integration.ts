// src/services/monitoring-integration.ts
import { metricsCollector } from './metrics-collector.js';
import type { Request, Response } from 'express';

/**
 * Monitoring integration for external observability platforms.
 * Supports Prometheus, Grafana, and custom endpoints.
 */
export class MonitoringIntegration {
  /**
   * Export metrics in Prometheus text format.
   * Compatible with Prometheus scraping and Grafana datasources.
   */
  exportPrometheusMetrics(): string {
    const allMetrics = metricsCollector.getAllMetrics();
    const lines: string[] = [];

    for (const [key, metrics] of Object.entries(allMetrics)) {
      const [service, operation] = key.split('.');
      const metricName = `llm_benchmarker_${service}_${operation}`.toLowerCase();

      // Operation count
      lines.push(`# HELP ${metricName}_total Total number of operations`);
      lines.push(`# TYPE ${metricName}_total counter`);
      lines.push(`${metricName}_total{service="${service}",operation="${operation}"} ${metrics.operationCount}`);

      // Duration metrics
      lines.push(`# HELP ${metricName}_duration_ms Operation duration in milliseconds`);
      lines.push(`# TYPE ${metricName}_duration_ms summary`);
      lines.push(`${metricName}_duration_ms{service="${service}",operation="${operation}",quantile="avg"} ${metrics.avgDurationMs.toFixed(2)}`);
      lines.push(`${metricName}_duration_ms{service="${service}",operation="${operation}",quantile="min"} ${metrics.minDurationMs.toFixed(2)}`);
      lines.push(`${metricName}_duration_ms{service="${service}",operation="${operation}",quantile="max"} ${metrics.maxDurationMs.toFixed(2)}`);

      // Error count
      lines.push(`# HELP ${metricName}_errors_total Total number of errors`);
      lines.push(`# TYPE ${metricName}_errors_total counter`);
      lines.push(`${metricName}_errors_total{service="${service}",operation="${operation}"} ${metrics.errorCount}`);

      lines.push(''); // Blank line between metrics
    }

    return lines.join('\n');
  }

  /**
   * Export metrics as JSON (for custom integrations).
   */
  exportJsonMetrics() {
    const allMetrics = metricsCollector.getAllMetrics();

    return {
      timestamp: new Date().toISOString(),
      service: 'elastic-llm-benchmarker',
      version: '1.0.0',
      metrics: allMetrics,
      summary: {
        totalOperations: Object.values(allMetrics).reduce((sum, m) => sum + m.operationCount, 0),
        totalErrors: Object.values(allMetrics).reduce((sum, m) => sum + m.errorCount, 0),
        serviceCount: new Set(Object.keys(allMetrics).map(k => k.split('.')[0])).size,
      },
    };
  }

  /**
   * Express middleware for /metrics endpoint (Prometheus scraping).
   */
  prometheusHandler() {
    return (_req: Request, res: Response) => {
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(this.exportPrometheusMetrics());
    };
  }

  /**
   * Express middleware for /metrics/json endpoint (JSON format).
   */
  jsonHandler() {
    return (_req: Request, res: Response) => {
      res.json(this.exportJsonMetrics());
    };
  }

  /**
   * Health check endpoint for monitoring systems.
   */
  healthCheckHandler() {
    return (_req: Request, res: Response) => {
      const allMetrics = metricsCollector.getAllMetrics();
      const totalErrors = Object.values(allMetrics).reduce((sum, m) => sum + m.errorCount, 0);
      const totalOps = Object.values(allMetrics).reduce((sum, m) => sum + m.operationCount, 0);
      const errorRate = totalOps > 0 ? totalErrors / totalOps : 0;

      const healthy = errorRate < 0.1; // Less than 10% error rate

      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        metrics: {
          totalOperations: totalOps,
          totalErrors: totalErrors,
          errorRate: (errorRate * 100).toFixed(2) + '%',
        },
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      });
    };
  }
}

// Singleton instance
export const monitoring = new MonitoringIntegration();
