import { describe, it, expect } from 'vitest';
import { GoldenForwarder, type ReplicationError } from '../../src/services/golden-forwarder.js';

describe('GoldenForwarder', () => {
  it('initializes with zero pending count and no errors', () => {
    const forwarder = new GoldenForwarder();
    expect(forwarder.getPendingCount()).toBe(0);
    expect(forwarder.getAllErrors()).toEqual([]);
  });

  it('increments and decrements pending count', () => {
    const forwarder = new GoldenForwarder();
    forwarder.incrementPending();
    expect(forwarder.getPendingCount()).toBe(1);
    forwarder.incrementPending();
    expect(forwarder.getPendingCount()).toBe(2);
    forwarder.decrementPending();
    expect(forwarder.getPendingCount()).toBe(1);
  });

  it('does not decrement below zero', () => {
    const forwarder = new GoldenForwarder();
    forwarder.decrementPending();
    expect(forwarder.getPendingCount()).toBe(0);
    forwarder.incrementPending();
    forwarder.decrementPending();
    forwarder.decrementPending();
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
    // Simulate time passing by replacing timestamp manually
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
});
