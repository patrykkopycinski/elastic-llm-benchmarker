import type { DiscoveryScheduler } from './discovery-scheduler.js';
import type { QueueService } from './queue-service.js';

export interface SystemHealthCheckResult {
  ok: boolean;
  checks: Record<string, { ok: boolean; message?: string }>;
}

export interface SystemHealthCheckerOptions {
  discoveryScheduler?: DiscoveryScheduler;
  queueService?: QueueService;
}

export class SystemHealthChecker {
  private readonly discoveryScheduler?: DiscoveryScheduler;
  private readonly queueService?: QueueService;

  constructor(options: SystemHealthCheckerOptions) {
    this.discoveryScheduler = options.discoveryScheduler;
    this.queueService = options.queueService;
  }

  async run(): Promise<SystemHealthCheckResult> {
    const checks: Record<string, { ok: boolean; message?: string }> = {};
    let ok = true;

    // Discovery Scheduler
    try {
      if (this.discoveryScheduler) {
        const running = this.discoveryScheduler.isRunning;
        checks['discovery_scheduler'] = {
          ok: running,
          message: running
            ? 'Discovery scheduler is running'
            : 'Discovery scheduler is not running',
        };
        if (!running) ok = false;
      } else {
        checks['discovery_scheduler'] = {
          ok: true,
          message: 'Discovery scheduler not configured',
        };
      }
    } catch (e) {
      checks['discovery_scheduler'] = {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
      ok = false;
    }

    // Queue Depth
    try {
      if (this.queueService) {
        const count = await this.queueService.getPending();
        const queueOk = count <= 50;
        checks['queue_depth'] = {
          ok: queueOk,
          message: `Queue depth is ${count}${queueOk ? '' : ' (threshold: 50)'}`,
        };
        if (!queueOk) ok = false;
      } else {
        checks['queue_depth'] = {
          ok: true,
          message: 'Queue service not configured',
        };
      }
    } catch (e) {
      checks['queue_depth'] = {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
      ok = false;
    }

    return { ok, checks };
  }
}
