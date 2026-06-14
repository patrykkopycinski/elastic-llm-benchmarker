import type { AppConfig } from '../types/config.js';
import type { DiscoveryScheduler } from './discovery-scheduler.js';
import type { GoldenForwarder } from './golden-forwarder.js';
import type { QueueService } from './queue-service.js';

export interface SystemHealthCheckResult {
  ok: boolean;
  checks: Record<string, { ok: boolean; message?: string }>;
}

export interface SystemHealthCheckerOptions {
  config?: AppConfig;
  discoveryScheduler?: DiscoveryScheduler;
  goldenForwarder?: GoldenForwarder;
  queueService?: QueueService;
}

export class SystemHealthChecker {
  private readonly config: AppConfig;
  private readonly discoveryScheduler?: DiscoveryScheduler;
  private readonly goldenForwarder?: GoldenForwarder;
  private readonly queueService?: QueueService;

  constructor(options: SystemHealthCheckerOptions) {
    this.config = options.config ?? ({} as AppConfig);
    this.discoveryScheduler = options.discoveryScheduler;
    this.goldenForwarder = options.goldenForwarder;
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

    // Golden Forwarder
    try {
      if (this.goldenForwarder) {
        const pending = this.goldenForwarder.getPendingCount();
        const recentErrors = this.goldenForwarder.getRecentReplicationErrors(60 * 60 * 1000);
        const forwarderOk = pending < 100 && recentErrors.length === 0;
        let message = `Pending: ${pending}`;
        if (recentErrors.length > 0) {
          message += `, ${recentErrors.length} replication error(s) in last hour`;
        }
        checks['golden_forwarder'] = { ok: forwarderOk, message };
        if (!forwarderOk) ok = false;
      } else {
        checks['golden_forwarder'] = {
          ok: true,
          message: 'Golden forwarder not configured',
        };
      }
    } catch (e) {
      checks['golden_forwarder'] = {
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

    // Golden ES connectivity
    try {
      if (this.config.goldenCluster?.enabled && this.config.goldenCluster.url) {
        const { Client } = await import('@elastic/elasticsearch');
        const client = new Client({
          node: this.config.goldenCluster.url,
          ...(this.config.goldenCluster.apiKey
            ? { auth: { apiKey: this.config.goldenCluster.apiKey } }
            : {}),
        });
        const info = await client.info();
        await client.close();
        checks['golden_es'] = {
          ok: true,
          message: `Golden cluster reachable (${info.cluster_name as string})`,
        };
      } else {
        checks['golden_es'] = {
          ok: true,
          message: 'Golden cluster not configured',
        };
      }
    } catch (e) {
      checks['golden_es'] = {
        ok: false,
        message: `Golden cluster unreachable: ${e instanceof Error ? e.message : String(e)}`,
      };
      ok = false;
    }

    return { ok, checks };
  }
}
