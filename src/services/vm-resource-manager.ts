// src/services/vm-resource-manager.ts
import type { SSHConfig } from '../types/config.js';
import { Mutex } from 'async-mutex';
import { createLogger } from '../utils/logger.js';

export interface VMConfig extends SSHConfig {
  id: string;
  gpus: string;
}

interface VMLeaseInfo {
  modelId: string;
  startedAt: Date;
  expiresAt: Date;
}

/**
 * Default lease duration: 1 hour
 * Prevents VMs from being stuck in busy state if lease never released
 */
const DEFAULT_LEASE_DURATION_MS = 3600000;

export class VMLease {
  private released = false;

  constructor(
    public vm: VMConfig,
    private releaseFn: () => Promise<void>
  ) {}

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.releaseFn();
  }
}

export class VMResourceManagerService {
  private availableVMs: VMConfig[];
  private busyVMs: Map<string, VMLeaseInfo>;
  private vmConfigsById: Map<string, VMConfig>;
  private mutex = new Mutex();
  private logger;

  constructor(vms: VMConfig[], logLevel: string = 'info') {
    this.availableVMs = [...vms];
    this.busyVMs = new Map();
    this.vmConfigsById = new Map(vms.map(vm => [vm.id, vm]));
    this.logger = createLogger(logLevel);
  }

  /**
   * Acquire a VM lease with automatic expiration.
   * Thread-safe using mutex to prevent race conditions.
   */
  async acquireVM(
    requestor: string,
    durationMs: number = DEFAULT_LEASE_DURATION_MS
  ): Promise<VMLease | null> {
    return await this.mutex.runExclusive(async () => {
      // Clean up expired leases before acquiring
      await this.cleanupExpiredLeases();

      if (this.availableVMs.length === 0) return null;

      const vm = this.availableVMs.pop()!;
      const now = new Date();

      this.busyVMs.set(vm.id, {
        modelId: requestor,
        startedAt: now,
        expiresAt: new Date(now.getTime() + durationMs),
      });

      this.logger.info('VM lease acquired', { vmId: vm.id, requestor, expiresAt: new Date(now.getTime() + durationMs).toISOString() });

      return new VMLease(vm, async () => {
        await this.releaseVM(vm.id);
      });
    });
  }

  /**
   * Release a VM lease (thread-safe).
   */
  private async releaseVM(vmId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.busyVMs.delete(vmId);
      const vm = this.vmConfigsById.get(vmId);
      if (vm) {
        this.availableVMs.push(vm);
        this.logger.info('VM lease released', { vmId });
      }
    });
  }

  /**
   * Clean up expired leases automatically.
   * Called before each acquire to ensure stale leases don't block resources.
   */
  private async cleanupExpiredLeases(): Promise<void> {
    const now = new Date();
    const expired: string[] = [];

    for (const [vmId, info] of this.busyVMs.entries()) {
      if (info.expiresAt < now) {
        expired.push(vmId);
      }
    }

    if (expired.length > 0) {
      this.logger.warn('Auto-releasing expired leases', { count: expired.length, vmIds: expired });

      for (const vmId of expired) {
        this.busyVMs.delete(vmId);
        const vm = this.vmConfigsById.get(vmId);
        if (vm) {
          this.availableVMs.push(vm);
        }
      }
    }
  }

  isVMAvailable(): boolean {
    return this.availableVMs.length > 0;
  }

  getVMStatus() {
    return {
      available: this.availableVMs.map(vm => ({ id: vm.id, gpus: vm.gpus })),
      busy: Array.from(this.busyVMs.entries()).map(([id, info]) => ({
        id,
        modelId: info.modelId,
        startedAt: info.startedAt.toISOString(),
      })),
    };
  }
}
