import { describe, it, expect, vi } from 'vitest';
import { GoldenForwarder, type ReplicationError } from '../../src/services/golden-forwarder.js';

describe('GoldenForwarder', () => {
  it('initializes with zero pending count and no errors', () => {
    const forwarder = new GoldenForwarder();
    expect(forwarder.getPendingCount()).toBe(0);
    expect(forwarder.getAllErrors()).toEqual([]);
    expect(forwarder.isEnabled()).toBe(false);
  });

  it('tracks pending count when items are enqueued', () => {
    const forwarder = new GoldenForwarder({ enabled: true, client: {} as never });
    forwarder.enqueue('test-index', 'doc1', { foo: 'bar' });
    expect(forwarder.getPendingCount()).toBe(1);
    forwarder.enqueue('test-index', 'doc2', { baz: 'qux' });
    expect(forwarder.getPendingCount()).toBe(2);
  });

  it('does not enqueue when disabled', () => {
    const forwarder = new GoldenForwarder({ enabled: false, client: {} as never });
    forwarder.enqueue('test-index', 'doc1', { foo: 'bar' });
    expect(forwarder.getPendingCount()).toBe(0);
  });

  it('records replication errors with timestamps', () => {
    const forwarder = new GoldenForwarder();
    const before = Date.now();
    forwarder.recordReplicationError('timeout');
    const after = Date.now();
    const errors = forwarder.getAllErrors() as ReplicationError[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('timeout');
    expect(errors[0]!.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(errors[0]!.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('filters recent replication errors by lookback', () => {
    const forwarder = new GoldenForwarder();
    forwarder.recordReplicationError('old error');
    const oldErrorTime = Date.now();
    const errors = forwarder.getAllErrors() as ReplicationError[];
    errors[0]!.timestamp = new Date(oldErrorTime - 2000);

    forwarder.recordReplicationError('new error');

    const recent = forwarder.getRecentReplicationErrors(1000);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.message).toBe('new error');
  });

  it('returns all errors', () => {
    const forwarder = new GoldenForwarder();
    forwarder.recordReplicationError('a');
    forwarder.recordReplicationError('b');
    const all = forwarder.getAllErrors();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.message)).toEqual(['a', 'b']);
  });

  it('clears all errors', () => {
    const forwarder = new GoldenForwarder();
    forwarder.recordReplicationError('x');
    expect(forwarder.getAllErrors()).toHaveLength(1);
    forwarder.clearErrors();
    expect(forwarder.getAllErrors()).toHaveLength(0);
  });

  it('caps error list at 1000 entries', () => {
    const forwarder = new GoldenForwarder();
    for (let i = 0; i < 1100; i++) {
      forwarder.recordReplicationError(`error-${i}`);
    }
    expect(forwarder.getAllErrors().length).toBeLessThanOrEqual(1000);
  });

  it('flush returns zeroes when disabled or empty', async () => {
    const forwarder = new GoldenForwarder();
    const result = await forwarder.flush();
    expect(result).toEqual({ forwarded: 0, failed: 0, dlq: 0 });
  });

  it('getStats returns full state snapshot', () => {
    const forwarder = new GoldenForwarder({ enabled: true, client: {} as never });
    forwarder.enqueue('idx', 'id1', { a: 1 });
    forwarder.recordReplicationError('err');
    const stats = forwarder.getStats();
    expect(stats).toEqual({
      pending: 1,
      forwarded: 0,
      dlq: 0,
      errors: 1,
      enabled: true,
    });
  });

  it('flush processes batch via ES bulk', async () => {
    const mockBulk = vi.fn().mockResolvedValue({ errors: false, items: [{ index: { status: 200 } }] });
    const mockClient = { bulk: mockBulk } as never;

    const forwarder = new GoldenForwarder({
      enabled: true,
      client: mockClient,
      batchSize: 10,
    });

    forwarder.enqueue('test-idx', 'doc1', { field: 'value' });
    const result = await forwarder.flush();

    expect(result.forwarded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dlq).toBe(0);
    expect(forwarder.getForwardedCount()).toBe(1);
    expect(forwarder.getPendingCount()).toBe(0);
    expect(mockBulk).toHaveBeenCalledOnce();
  });

  it('sends failed documents to DLQ after max retries', async () => {
    const mockIndex = vi.fn().mockResolvedValue({});
    const mockBulk = vi.fn().mockRejectedValue(new Error('connection refused'));
    const mockClient = { bulk: mockBulk, index: mockIndex } as never;

    const forwarder = new GoldenForwarder({
      enabled: true,
      client: mockClient,
      batchSize: 10,
      maxRetries: 2,
    });

    forwarder.enqueue('test-idx', 'doc1', { field: 'value' });

    await forwarder.flush();
    expect(forwarder.getPendingCount()).toBe(1);

    await forwarder.flush();
    expect(forwarder.getPendingCount()).toBe(0);
    expect(forwarder.getDlqCount()).toBe(1);
    expect(mockIndex).toHaveBeenCalledOnce();
  });

  it('start and stop manage the flush timer', () => {
    vi.useFakeTimers();
    const forwarder = new GoldenForwarder({ enabled: true, client: {} as never, flushIntervalMs: 1000 });
    forwarder.start();
    forwarder.stop();
    vi.useRealTimers();
  });

  it('start is a no-op when disabled', () => {
    const forwarder = new GoldenForwarder({ enabled: false, client: {} as never });
    forwarder.start();
    forwarder.stop();
  });
});
