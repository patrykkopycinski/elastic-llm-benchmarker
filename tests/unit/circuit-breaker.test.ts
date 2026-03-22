import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CircuitBreaker,
} from '../../src/services/circuit-breaker.js';
import type {
  CircuitBreakerOptions,
  CircuitState,
  CircuitBreakerSnapshot,
} from '../../src/services/circuit-breaker.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function createBreaker(overrides: CircuitBreakerOptions = {}): CircuitBreaker {
  return new CircuitBreaker(
    {
      failureThreshold: 3,
      resetTimeoutMs: 1000, // 1 second for fast tests
      successThreshold: 1,
      failureWindowMs: 5000,
      ...overrides,
    },
    'error', // Suppress logs in tests
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = createBreaker();
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      const defaultBreaker = new CircuitBreaker({}, 'error');
      expect(defaultBreaker).toBeInstanceOf(CircuitBreaker);
    });

    it('should create with custom options', () => {
      const customBreaker = new CircuitBreaker(
        {
          failureThreshold: 5,
          resetTimeoutMs: 60_000,
          successThreshold: 2,
          failureWindowMs: 120_000,
        },
        'error',
      );
      expect(customBreaker).toBeInstanceOf(CircuitBreaker);
    });
  });

  describe('canAttempt', () => {
    it('should allow attempts when no failures have been recorded', () => {
      const result = breaker.canAttempt('model-a');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');
      expect(result.reason).toBeNull();
      expect(result.retryAfterMs).toBeNull();
    });

    it('should allow attempts when failures are below threshold', () => {
      breaker.recordFailure('model-a', 'timeout', 'timeout');
      breaker.recordFailure('model-a', 'timeout again', 'timeout');

      const result = breaker.canAttempt('model-a');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('CLOSED');
    });

    it('should block attempts when circuit is OPEN', () => {
      // Reach failure threshold
      breaker.recordFailure('model-a', 'failure 1', 'oom');
      breaker.recordFailure('model-a', 'failure 2', 'oom');
      breaker.recordFailure('model-a', 'failure 3', 'oom');

      const result = breaker.canAttempt('model-a');
      expect(result.allowed).toBe(false);
      expect(result.state).toBe('OPEN');
      expect(result.reason).toContain('Circuit OPEN');
      expect(result.reason).toContain('model-a');
      expect(result.retryAfterMs).toBeTypeOf('number');
      expect(result.retryAfterMs!).toBeGreaterThan(0);
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      // Open the circuit
      breaker.recordFailure('model-a', 'failure 1', 'oom');
      breaker.recordFailure('model-a', 'failure 2', 'oom');
      breaker.recordFailure('model-a', 'failure 3', 'oom');

      // Wait for reset timeout (1 second)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = breaker.canAttempt('model-a');
      expect(result.allowed).toBe(true);
      expect(result.state).toBe('HALF_OPEN');
    });

    it('should not affect other models when one is blocked', () => {
      // Open circuit for model-a
      breaker.recordFailure('model-a', 'failure 1', 'oom');
      breaker.recordFailure('model-a', 'failure 2', 'oom');
      breaker.recordFailure('model-a', 'failure 3', 'oom');

      // model-b should still be allowed
      const resultB = breaker.canAttempt('model-b');
      expect(resultB.allowed).toBe(true);
      expect(resultB.state).toBe('CLOSED');

      // model-a should be blocked
      const resultA = breaker.canAttempt('model-a');
      expect(resultA.allowed).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count', () => {
      breaker.recordFailure('model-a', 'error 1', 'timeout');

      const record = breaker.getRecord('model-a');
      expect(record).not.toBeNull();
      expect(record!.failureCount).toBe(1);
      expect(record!.state).toBe('CLOSED');
    });

    it('should open circuit at failure threshold', () => {
      breaker.recordFailure('model-a', 'error 1', 'oom');
      breaker.recordFailure('model-a', 'error 2', 'oom');
      breaker.recordFailure('model-a', 'error 3', 'oom');

      const record = breaker.getRecord('model-a');
      expect(record!.state).toBe('OPEN');
      expect(record!.failureCount).toBe(3);
      expect(record!.openedAt).toBeTypeOf('number');
    });

    it('should track failure reasons (up to max)', () => {
      for (let i = 1; i <= 7; i++) {
        breaker.recordFailure('model-a', `error ${i}`, 'timeout');
      }

      const record = breaker.getRecord('model-a');
      // MAX_FAILURE_REASONS is 5
      expect(record!.lastFailureReasons.length).toBeLessThanOrEqual(5);
      expect(record!.lastFailureReasons).toContain('error 7');
    });

    it('should track unique failure categories', () => {
      breaker.recordFailure('model-a', 'oom error', 'oom');
      breaker.recordFailure('model-a', 'timeout error', 'timeout');
      breaker.recordFailure('model-a', 'another oom', 'oom');

      const record = breaker.getRecord('model-a');
      expect(record!.failureCategories).toEqual(['oom', 'timeout']);
    });

    it('should reopen circuit from HALF_OPEN on failure', async () => {
      // Open circuit
      breaker.recordFailure('model-a', 'error 1', 'oom');
      breaker.recordFailure('model-a', 'error 2', 'oom');
      breaker.recordFailure('model-a', 'error 3', 'oom');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Transition to HALF_OPEN
      breaker.canAttempt('model-a');

      // Record another failure in HALF_OPEN
      breaker.recordFailure('model-a', 'error 4', 'oom');

      const record = breaker.getRecord('model-a');
      expect(record!.state).toBe('OPEN');
    });
  });

  describe('recordSuccess', () => {
    it('should reset failure count in CLOSED state', () => {
      breaker.recordFailure('model-a', 'error 1', 'timeout');
      breaker.recordFailure('model-a', 'error 2', 'timeout');

      breaker.recordSuccess('model-a');

      const record = breaker.getRecord('model-a');
      expect(record!.failureCount).toBe(0);
      expect(record!.state).toBe('CLOSED');
    });

    it('should close circuit from HALF_OPEN on success', async () => {
      // Open circuit
      breaker.recordFailure('model-a', 'error 1', 'oom');
      breaker.recordFailure('model-a', 'error 2', 'oom');
      breaker.recordFailure('model-a', 'error 3', 'oom');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Transition to HALF_OPEN
      breaker.canAttempt('model-a');

      // Record success
      breaker.recordSuccess('model-a');

      const record = breaker.getRecord('model-a');
      expect(record!.state).toBe('CLOSED');
      expect(record!.failureCount).toBe(0);
    });

    it('should handle success for model with no failure record', () => {
      // Should not throw
      breaker.recordSuccess('model-x');

      const record = breaker.getRecord('model-x');
      expect(record).toBeNull();
    });

    it('should require successThreshold successes in HALF_OPEN to close', async () => {
      const strictBreaker = createBreaker({ successThreshold: 2 });

      // Open circuit
      strictBreaker.recordFailure('model-a', 'error 1', 'oom');
      strictBreaker.recordFailure('model-a', 'error 2', 'oom');
      strictBreaker.recordFailure('model-a', 'error 3', 'oom');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Transition to HALF_OPEN
      strictBreaker.canAttempt('model-a');

      // First success - not enough
      strictBreaker.recordSuccess('model-a');
      let record = strictBreaker.getRecord('model-a');
      expect(record!.state).toBe('HALF_OPEN');

      // Second success - enough
      strictBreaker.recordSuccess('model-a');
      record = strictBreaker.getRecord('model-a');
      expect(record!.state).toBe('CLOSED');
    });
  });

  describe('getRecord', () => {
    it('should return null for unknown model', () => {
      expect(breaker.getRecord('unknown')).toBeNull();
    });

    it('should return readonly record', () => {
      breaker.recordFailure('model-a', 'error', 'timeout');

      const record = breaker.getRecord('model-a');
      expect(record).not.toBeNull();
      expect(record!.modelId).toBe('model-a');
    });
  });

  describe('getAllRecords', () => {
    it('should return empty array when no records', () => {
      expect(breaker.getAllRecords()).toEqual([]);
    });

    it('should return all records', () => {
      breaker.recordFailure('model-a', 'error', 'timeout');
      breaker.recordFailure('model-b', 'error', 'oom');

      const records = breaker.getAllRecords();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.modelId).sort()).toEqual(['model-a', 'model-b']);
    });
  });

  describe('getBlockedModels', () => {
    it('should return empty array when no blocked models', () => {
      expect(breaker.getBlockedModels()).toEqual([]);
    });

    it('should return models with OPEN circuits', () => {
      // Open circuit for model-a
      breaker.recordFailure('model-a', 'error 1', 'oom');
      breaker.recordFailure('model-a', 'error 2', 'oom');
      breaker.recordFailure('model-a', 'error 3', 'oom');

      // model-b has failures but not enough to open
      breaker.recordFailure('model-b', 'error 1', 'timeout');

      const blocked = breaker.getBlockedModels();
      expect(blocked).toEqual(['model-a']);
    });
  });

  describe('reset', () => {
    it('should remove record for specific model', () => {
      breaker.recordFailure('model-a', 'error', 'timeout');
      breaker.recordFailure('model-b', 'error', 'oom');

      breaker.reset('model-a');

      expect(breaker.getRecord('model-a')).toBeNull();
      expect(breaker.getRecord('model-b')).not.toBeNull();
    });

    it('should not throw for unknown model', () => {
      expect(() => breaker.reset('unknown')).not.toThrow();
    });
  });

  describe('resetAll', () => {
    it('should clear all records', () => {
      breaker.recordFailure('model-a', 'error', 'timeout');
      breaker.recordFailure('model-b', 'error', 'oom');

      breaker.resetAll();

      expect(breaker.getAllRecords()).toEqual([]);
    });
  });

  describe('snapshot and restore', () => {
    it('should create a serializable snapshot', () => {
      breaker.recordFailure('model-a', 'error 1', 'oom');
      breaker.recordFailure('model-a', 'error 2', 'oom');

      const snapshot = breaker.snapshot();
      expect(snapshot.records).toHaveLength(1);
      expect(snapshot.records[0]!.modelId).toBe('model-a');
      expect(snapshot.records[0]!.failureCount).toBe(2);
      expect(snapshot.timestamp).toBeTruthy();
    });

    it('should restore from snapshot', () => {
      breaker.recordFailure('model-a', 'error 1', 'oom');
      breaker.recordFailure('model-a', 'error 2', 'oom');
      breaker.recordFailure('model-a', 'error 3', 'oom');

      const snapshot = breaker.snapshot();

      // Create new breaker and restore
      const newBreaker = createBreaker();
      newBreaker.restore(snapshot);

      const record = newBreaker.getRecord('model-a');
      expect(record).not.toBeNull();
      expect(record!.failureCount).toBe(3);
      expect(record!.state).toBe('OPEN');
    });

    it('should produce JSON-serializable snapshot', () => {
      breaker.recordFailure('model-a', 'error', 'oom');

      const snapshot = breaker.snapshot();
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json) as CircuitBreakerSnapshot;

      expect(parsed.records).toHaveLength(1);
      expect(parsed.records[0]!.modelId).toBe('model-a');
    });
  });

  describe('failure window expiry', () => {
    it('should reset failure count when window expires', async () => {
      const fastBreaker = createBreaker({
        failureWindowMs: 100, // 100ms window
        failureThreshold: 3,
      });

      // Record 2 failures
      fastBreaker.recordFailure('model-a', 'error 1', 'timeout');
      fastBreaker.recordFailure('model-a', 'error 2', 'timeout');

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // canAttempt should clean up expired failures
      const result = fastBreaker.canAttempt('model-a');
      expect(result.allowed).toBe(true);

      // After cleanup, the record should have 0 failures
      const record = fastBreaker.getRecord('model-a');
      expect(record!.failureCount).toBe(0);
    });
  });

  describe('concurrent model tracking', () => {
    it('should independently track multiple models', () => {
      breaker.recordFailure('model-a', 'oom', 'oom');
      breaker.recordFailure('model-b', 'timeout', 'timeout');
      breaker.recordFailure('model-c', 'ssh error', 'ssh_failure');

      expect(breaker.getRecord('model-a')!.failureCount).toBe(1);
      expect(breaker.getRecord('model-b')!.failureCount).toBe(1);
      expect(breaker.getRecord('model-c')!.failureCount).toBe(1);

      // Only open model-a
      breaker.recordFailure('model-a', 'oom 2', 'oom');
      breaker.recordFailure('model-a', 'oom 3', 'oom');

      expect(breaker.getRecord('model-a')!.state).toBe('OPEN');
      expect(breaker.getRecord('model-b')!.state).toBe('CLOSED');
      expect(breaker.getRecord('model-c')!.state).toBe('CLOSED');
    });
  });
});
