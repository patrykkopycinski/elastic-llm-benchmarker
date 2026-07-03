import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { GpuVmLeaseService } from '../../src/services/gpu-vm-lease.js';

const VM_HOST = 'gpu-vm.example';
const NOW = 1_000_000_000_000; // fixed clock base

function esError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(`es error ${statusCode}`) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

interface LeaseDoc {
  vm_host: string;
  owner_hostname: string;
  owner_pid: number;
  acquired_at: string;
  heartbeat_at: string;
}

/** Minimal ES mock backing a single lease doc with seq_no/primary_term semantics. */
function createMockClient(initial?: { doc: LeaseDoc; seqNo: number; primaryTerm: number }): {
  client: Client;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  index: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  state: { doc: LeaseDoc | null; seqNo: number; primaryTerm: number };
} {
  const state = {
    doc: initial?.doc ?? null,
    seqNo: initial?.seqNo ?? 0,
    primaryTerm: initial?.primaryTerm ?? 1,
  } as { doc: LeaseDoc | null; seqNo: number; primaryTerm: number };

  const get = vi.fn().mockImplementation(() => {
    if (!state.doc) return Promise.reject(esError(404));
    return Promise.resolve({
      _source: state.doc,
      _seq_no: state.seqNo,
      _primary_term: state.primaryTerm,
    });
  });

  const create = vi.fn().mockImplementation((args: { document: LeaseDoc }) => {
    if (state.doc) return Promise.reject(esError(409));
    state.doc = args.document;
    state.seqNo += 1;
    return Promise.resolve({ result: 'created' });
  });

  const index = vi
    .fn()
    .mockImplementation(
      (args: { document: LeaseDoc; if_seq_no?: number; if_primary_term?: number }) => {
        if (
          args.if_seq_no !== undefined &&
          (args.if_seq_no !== state.seqNo || args.if_primary_term !== state.primaryTerm)
        ) {
          return Promise.reject(esError(409));
        }
        state.doc = args.document;
        state.seqNo += 1;
        return Promise.resolve({ result: 'updated' });
      },
    );

  const update = vi.fn().mockImplementation((args: { doc: Partial<LeaseDoc> }) => {
    if (!state.doc) return Promise.reject(esError(404));
    state.doc = { ...state.doc, ...args.doc };
    state.seqNo += 1;
    return Promise.resolve({ result: 'updated' });
  });

  const del = vi.fn().mockImplementation(() => {
    if (!state.doc) return Promise.reject(esError(404));
    state.doc = null;
    return Promise.resolve({ result: 'deleted' });
  });

  const client = {
    get,
    create,
    index,
    update,
    delete: del,
  } as unknown as Client;

  return { client, get, create, index, update, del, state };
}

function makeService(
  client: Client,
  overrides: Partial<{ pid: number; hostnameFn: () => string; now: () => number }> = {},
): GpuVmLeaseService {
  return new GpuVmLeaseService({
    esClient: client,
    vmHost: VM_HOST,
    staleAfterMs: 120_000,
    logLevel: 'error',
    now: overrides.now ?? (() => NOW),
    hostnameFn: overrides.hostnameFn ?? (() => 'host-a'),
    pid: overrides.pid ?? 111,
  });
}

function leaseDoc(partial: Partial<LeaseDoc>): LeaseDoc {
  return {
    vm_host: VM_HOST,
    owner_hostname: 'host-b',
    owner_pid: 222,
    acquired_at: new Date(NOW - 60_000).toISOString(),
    heartbeat_at: new Date(NOW - 10_000).toISOString(),
    ...partial,
  };
}

describe('GpuVmLeaseService.acquire', () => {
  it('acquires a free VM by creating the lease doc', async () => {
    const mock = createMockClient();
    const svc = makeService(mock.client);

    const result = await svc.acquire();

    expect(result.success).toBe(true);
    expect(svc.holdsLease()).toBe(true);
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.state.doc?.owner_hostname).toBe('host-a');
    expect(mock.state.doc?.owner_pid).toBe(111);
  });

  it('refuses when another daemon holds a fresh lease', async () => {
    const mock = createMockClient({
      doc: leaseDoc({ heartbeat_at: new Date(NOW - 5_000).toISOString() }),
      seqNo: 3,
      primaryTerm: 1,
    });
    const svc = makeService(mock.client);

    const result = await svc.acquire();

    expect(result.success).toBe(false);
    expect(result.heldBy?.ownerHostname).toBe('host-b');
    expect(result.heldBy?.ownerPid).toBe(222);
    expect(svc.holdsLease()).toBe(false);
    expect(mock.index).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('takes over a stale lease from a dead daemon', async () => {
    const mock = createMockClient({
      doc: leaseDoc({ heartbeat_at: new Date(NOW - 300_000).toISOString() }),
      seqNo: 7,
      primaryTerm: 2,
    });
    const svc = makeService(mock.client);

    const result = await svc.acquire();

    expect(result.success).toBe(true);
    expect(svc.holdsLease()).toBe(true);
    // optimistic concurrency: guarded by the seq_no/primary_term we read
    expect(mock.index).toHaveBeenCalledWith(
      expect.objectContaining({ if_seq_no: 7, if_primary_term: 2 }),
    );
    expect(mock.state.doc?.owner_hostname).toBe('host-a');
  });

  it('is idempotent when this process already owns the lease', async () => {
    const mock = createMockClient({
      doc: leaseDoc({
        owner_hostname: 'host-a',
        owner_pid: 111,
        acquired_at: new Date(NOW - 90_000).toISOString(),
        heartbeat_at: new Date(NOW - 1_000).toISOString(),
      }),
      seqNo: 4,
      primaryTerm: 1,
    });
    const svc = makeService(mock.client);

    const result = await svc.acquire();

    expect(result.success).toBe(true);
    // acquired_at preserved (not reset) when refreshing our own lease
    expect(mock.state.doc?.acquired_at).toBe(new Date(NOW - 90_000).toISOString());
  });

  it('refuses when a concurrent creator wins the create race (409 then fresh other owner)', async () => {
    const mock = createMockClient();
    // After our create fails 409, a fresh lease from another daemon appears.
    mock.create.mockRejectedValueOnce(esError(409));
    mock.get
      .mockRejectedValueOnce(esError(404)) // initial read: empty
      .mockResolvedValueOnce({
        _source: leaseDoc({ heartbeat_at: new Date(NOW - 2_000).toISOString() }),
        _seq_no: 1,
        _primary_term: 1,
      });
    const svc = makeService(mock.client);

    const result = await svc.acquire();

    expect(result.success).toBe(false);
    expect(result.heldBy?.ownerHostname).toBe('host-b');
    expect(svc.holdsLease()).toBe(false);
  });

  it('returns an error result (never throws) on unexpected ES failures', async () => {
    const mock = createMockClient();
    mock.get.mockRejectedValueOnce(esError(500));
    const svc = makeService(mock.client);

    const result = await svc.acquire();

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(svc.holdsLease()).toBe(false);
  });
});

describe('GpuVmLeaseService.heartbeat', () => {
  it('updates heartbeat_at only when the lease is owned', async () => {
    const mock = createMockClient();
    const svc = makeService(mock.client);
    await svc.acquire();
    mock.update.mockClear();

    await svc.heartbeat();

    expect(mock.update).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the lease is not owned', async () => {
    const mock = createMockClient({
      doc: leaseDoc({ heartbeat_at: new Date(NOW - 1_000).toISOString() }),
      seqNo: 1,
      primaryTerm: 1,
    });
    const svc = makeService(mock.client);
    await svc.acquire(); // refused — held by fresh other

    await svc.heartbeat();

    expect(mock.update).not.toHaveBeenCalled();
  });

  it('swallows heartbeat failures', async () => {
    const mock = createMockClient();
    const svc = makeService(mock.client);
    await svc.acquire();
    mock.update.mockRejectedValueOnce(esError(503));

    await expect(svc.heartbeat()).resolves.toBeUndefined();
  });
});

describe('GpuVmLeaseService.release', () => {
  it('deletes the lease doc when owned', async () => {
    const mock = createMockClient();
    const svc = makeService(mock.client);
    await svc.acquire();

    await svc.release();

    expect(mock.del).toHaveBeenCalledTimes(1);
    expect(mock.state.doc).toBeNull();
    expect(svc.holdsLease()).toBe(false);
  });

  it('is a no-op when the lease is not owned', async () => {
    const mock = createMockClient({
      doc: leaseDoc({ heartbeat_at: new Date(NOW - 1_000).toISOString() }),
      seqNo: 1,
      primaryTerm: 1,
    });
    const svc = makeService(mock.client);
    await svc.acquire(); // refused

    await svc.release();

    expect(mock.del).not.toHaveBeenCalled();
  });

  it('swallows a 404 on release (lease already gone)', async () => {
    const mock = createMockClient();
    const svc = makeService(mock.client);
    await svc.acquire();
    mock.del.mockRejectedValueOnce(esError(404));

    await expect(svc.release()).resolves.toBeUndefined();
    expect(svc.holdsLease()).toBe(false);
  });
});
