// src/services/vm-resource-manager.ts
import type { SSHConfig } from '../types/config.js';

export interface VMConfig extends SSHConfig {
  id: string;
  gpus: string;
}

interface VMLeaseInfo {
  modelId: string;
  startedAt: Date;
}

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

  constructor(vms: VMConfig[]) {
    this.availableVMs = [...vms];
    this.busyVMs = new Map();
  }

  async acquireVM(requestor: string): Promise<VMLease | null> {
    if (this.availableVMs.length === 0) return null;

    const vm = this.availableVMs.pop()!;
    this.busyVMs.set(vm.id, {
      modelId: requestor,
      startedAt: new Date(),
    });

    return new VMLease(vm, async () => {
      this.busyVMs.delete(vm.id);
      this.availableVMs.push(vm);
    });
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
