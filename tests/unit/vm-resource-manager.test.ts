// tests/unit/vm-resource-manager.test.ts
import { describe, it, expect } from 'vitest';
import { VMResourceManagerService, VMLease } from '../../src/services/vm-resource-manager.js';

describe('VMResourceManagerService', () => {
  const vmConfig = {
    id: 'vm-1',
    host: '10.0.1.10',
    port: 22,
    username: 'test',
    gpus: '2xA100-40GB',
  };

  it('should acquire and release VM lease', async () => {
    const manager = new VMResourceManagerService([vmConfig]);

    const lease = await manager.acquireVM('model-123');
    expect(lease).toBeDefined();
    expect(manager.isVMAvailable()).toBe(false);

    await lease!.release();
    expect(manager.isVMAvailable()).toBe(true);
  });

  it('should return null when all VMs busy', async () => {
    const manager = new VMResourceManagerService([vmConfig]);

    const lease1 = await manager.acquireVM('model-1');
    const lease2 = await manager.acquireVM('model-2');

    expect(lease1).toBeDefined();
    expect(lease2).toBeNull();
  });

  it('should release VM even if already released', async () => {
    const manager = new VMResourceManagerService([vmConfig]);
    const lease = await manager.acquireVM('model-1');

    await lease!.release();
    await lease!.release(); // Should not throw

    expect(manager.isVMAvailable()).toBe(true);
  });
});
