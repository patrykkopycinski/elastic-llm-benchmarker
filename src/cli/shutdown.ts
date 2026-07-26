/**
 * Controlled shutdown utilities for the CLI.
 *
 * The principle: no handler or service code calls `process.exit()`.
 * Instead, handlers throw `CliError` and the top-level catch handles cleanup + exit.
 */

import type { Scheduler } from '../scheduler/scheduler.js';
import type { SSHClientPool } from '../services/ssh-client.js';
import type { Client } from '@elastic/elasticsearch';
import type { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import type { Lockfile } from '../utils/lockfile.js';
import type { GpuVmLeaseService } from '../services/gpu-vm-lease.js';
import type { Logger } from 'winston';

/**
 * Error thrown by CLI handlers to signal a controlled exit with a specific code.
 * The top-level CLI catch inspects the exit code and terminates the process.
 */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Interface for resources that need cleanup on shutdown.
 */
export interface ShutdownResources {
  scheduler?: Scheduler;
  sshPool?: SSHClientPool;
  esClient?: Client;
  resultsStore?: ElasticsearchResultsStore;
  gpuVmLease?: GpuVmLeaseService;
  lockfile?: Lockfile;
  leaseHeartbeat?: ReturnType<typeof setInterval>;
  discoveryScheduler?: { stop(): void };
  maintenanceScheduler?: { stop(): void };
}

/**
 * Perform graceful shutdown of all acquired resources.
 *
 * This function is idempotent — if a resource was never acquired or already
 * released, it is silently skipped. Each resource is cleaned up in order:
 * cheap/fast resources first, expensive/slow resources last.
 */
export async function gracefulShutdown(
  resources: ShutdownResources,
  signal: string,
  logger: Logger,
): Promise<void> {
  logger.info(`Received ${signal}. Shutting down...`);

  // Stop intervals first — they can trigger new work
  if (resources.leaseHeartbeat) {
    clearInterval(resources.leaseHeartbeat);
  }

  // Stop discovery/maintenance schedulers
  resources.discoveryScheduler?.stop();
  resources.maintenanceScheduler?.stop();

  // Stop the main scheduler (drains in-flight work)
  if (resources.scheduler) {
    try {
      await resources.scheduler.stop();
    } catch (err) {
      logger.error('Error stopping scheduler', { error: String(err) });
    }
  }

  // Close SSH pool (releases idle connections with timers)
  if (resources.sshPool) {
    try {
      resources.sshPool.close();
    } catch (err) {
      logger.error('Error closing SSH pool', { error: String(err) });
    }
  }

  // Release GPU VM lease (blocks next model if not released)
  if (resources.gpuVmLease) {
    try {
      await resources.gpuVmLease.release();
    } catch (err) {
      logger.error('Error releasing GPU lease', { error: String(err) });
    }
  }

  // Release lockfile (blocks next start if not released)
  if (resources.lockfile) {
    try {
      resources.lockfile.release();
    } catch (err) {
      logger.error('Error releasing lockfile', { error: String(err) });
    }
  }

  // Close results store
  if (resources.resultsStore) {
    try {
      await resources.resultsStore.close();
    } catch (err) {
      logger.error('Error closing results store', { error: String(err) });
    }
  }

  // Close ES client (connection pool drain)
  if (resources.esClient) {
    try {
      await resources.esClient.close();
    } catch (err) {
      logger.error('Error closing ES client', { error: String(err) });
    }
  }

  logger.info('Shutdown complete.');
}
