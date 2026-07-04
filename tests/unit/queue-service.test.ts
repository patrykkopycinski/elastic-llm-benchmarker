import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { QueueService, DEFAULT_ENTRY_STALE_AFTER_MS } from '../../src/services/queue-service.js';

type ActiveEntrySrc = {
  model_id: string;
  source: 'user' | 'discovery';
  priority: number;
  status: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  requested_by: string | null;
  lease_token?: string | null;
  heartbeat_at?: string | null;
};

function activeHit(id: string, src: Partial<ActiveEntrySrc>): { _id: string; _source: ActiveEntrySrc } {
  return {
    _id: id,
    _source: {
      model_id: 'org/model',
      source: 'user',
      priority: 100,
      status: 'benchmarking',
      requested_at: '2026-01-01T00:00:00Z',
      started_at: '2026-01-01T00:01:00Z',
      completed_at: null,
      error_message: null,
      requested_by: null,
      lease_token: 'tok-1',
      heartbeat_at: '2026-01-01T00:01:00Z',
      ...src,
    },
  };
}

describe('QueueService lease fencing + reclaim', () => {
  let search: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let esClient: Client;
  let service: QueueService;

  beforeEach(() => {
    search = vi.fn();
    update = vi.fn().mockResolvedValue({ result: 'updated' });
    get = vi.fn();
    esClient = { search, update, get } as unknown as Client;
    service = new QueueService(esClient);
  });

  /** A fenced ES `get` response for terminal-write tests. */
  function getDoc(src: Partial<ActiveEntrySrc>, seqNo = 7, primaryTerm = 2) {
    return {
      found: true,
      _id: 'q1',
      _seq_no: seqNo,
      _primary_term: primaryTerm,
      _source: activeHit('q1', src)._source,
    };
  }

  /** An ES version-conflict error (409), thrown by update on OCC mismatch. */
  function versionConflict(): Error & { statusCode: number } {
    const err = new Error('version_conflict_engine_exception') as Error & { statusCode: number };
    err.statusCode = 409;
    return err;
  }

  describe('reclaimStaleEntries', () => {
    it('reclaims an entry whose heartbeat is older than the TTL', async () => {
      const nowMs = Date.parse('2026-01-01T01:00:00Z');
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      // heartbeat 10 min ago → stale (TTL 120s)
      search.mockResolvedValue({
        hits: { hits: [activeHit('q1', { heartbeat_at: '2026-01-01T00:50:00Z' })] },
      });

      const reclaimed = await service.reclaimStaleEntries();

      expect(reclaimed).toBe(1);
      expect(update).toHaveBeenCalledTimes(1);
      const arg = update.mock.calls[0][0];
      expect(arg.id).toBe('q1');
      expect(arg.script.source).toContain(`ctx._source.status = 'pending'`);
      expect(arg.script.source).toContain('ctx._source.lease_token = null');
    });

    it('leaves a freshly-heartbeated entry untouched', async () => {
      const nowMs = Date.parse('2026-01-01T00:01:30Z');
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      // heartbeat 30s ago → fresh (TTL 120s)
      search.mockResolvedValue({
        hits: { hits: [activeHit('q1', { heartbeat_at: '2026-01-01T00:01:00Z' })] },
      });

      const reclaimed = await service.reclaimStaleEntries();

      expect(reclaimed).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });

    it('treats a missing heartbeat as stale (falls back to started_at, then reclaims)', async () => {
      const nowMs = Date.parse('2026-01-01T02:00:00Z');
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      search.mockResolvedValue({
        hits: { hits: [activeHit('q1', { heartbeat_at: null, started_at: null })] },
      });

      const reclaimed = await service.reclaimStaleEntries();

      expect(reclaimed).toBe(1);
    });

    it('honours a custom staleAfterMs window', async () => {
      const nowMs = Date.parse('2026-01-01T00:02:00Z');
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      // heartbeat 60s ago; default TTL 120s → fresh, but 30s TTL → stale
      search.mockResolvedValue({
        hits: { hits: [activeHit('q1', { heartbeat_at: '2026-01-01T00:01:00Z' })] },
      });

      expect(await service.reclaimStaleEntries(30_000)).toBe(1);
    });

    it('does not count a noop reset (entry already left in-flight)', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T05:00:00Z'));
      search.mockResolvedValue({
        hits: { hits: [activeHit('q1', { heartbeat_at: '2026-01-01T00:00:00Z' })] },
      });
      update.mockResolvedValue({ result: 'noop' });

      expect(await service.reclaimStaleEntries()).toBe(0);
    });
  });

  describe('heartbeat', () => {
    it('returns true when the write applied', async () => {
      update.mockResolvedValue({ result: 'updated' });
      expect(await service.heartbeat('q1', 'tok-1')).toBe(true);
      const arg = update.mock.calls[0][0];
      expect(arg.script.params.token).toBe('tok-1');
      expect(arg.script.source).toContain('ctx._source.heartbeat_at = params.now');
    });

    it('returns false when fenced out (token mismatch → noop)', async () => {
      update.mockResolvedValue({ result: 'noop' });
      expect(await service.heartbeat('q1', 'stale-token')).toBe(false);
    });
  });

  describe('adoptEntry', () => {
    it('returns a fresh lease token when the entry is still in-flight', async () => {
      update.mockResolvedValue({ result: 'updated' });
      const token = await service.adoptEntry('q1');
      expect(token).toBeTypeOf('string');
      expect(token).not.toHaveLength(0);
    });

    it('returns null when the entry is no longer in-flight (noop)', async () => {
      update.mockResolvedValue({ result: 'noop' });
      expect(await service.adoptEntry('q1')).toBeNull();
    });
  });

  describe('updateStatus fencing', () => {
    it('emits an unguarded script when no lease token is supplied', async () => {
      await service.updateStatus('q1', 'completed');
      const arg = update.mock.calls[0][0];
      expect(arg.script.source).not.toContain('ctx._source.lease_token == params.token');
      expect(arg.script.source).toContain('ctx._source.lease_token = null'); // terminal clears lease
    });

    it('wraps the mutation in a lease guard when a token is supplied', async () => {
      await service.updateStatus('q1', 'failed', 'boom', 'tok-1');
      const arg = update.mock.calls[0][0];
      expect(arg.script.source).toContain('ctx._source.lease_token == null || ctx._source.lease_token == params.token');
      expect(arg.script.params.token).toBe('tok-1');
    });

    it('returns false when the fenced write is a noop', async () => {
      update.mockResolvedValue({ result: 'noop' });
      expect(await service.updateStatus('q1', 'failed', 'boom', 'other-token')).toBe(false);
    });
  });

  describe('complete/fail — lease fencing + optimistic concurrency', () => {
    it('fail() applies with if_seq_no/if_primary_term when the lease matches', async () => {
      get.mockResolvedValue(getDoc({ lease_token: 'tok-1', status: 'benchmarking' }, 7, 2));
      update.mockResolvedValue({ result: 'updated' });

      const res = await service.fail('q1', 'boom', 'tok-1');

      expect(res).toEqual({ applied: true });
      const arg = update.mock.calls[0][0];
      expect(arg.if_seq_no).toBe(7);
      expect(arg.if_primary_term).toBe(2);
      expect(arg.doc.status).toBe('failed');
      expect(arg.doc.error_message).toBe('boom');
      expect(arg.doc.lease_token).toBeNull();
    });

    it('complete() applies and clears the error_message', async () => {
      get.mockResolvedValue(getDoc({ lease_token: 'tok-1', status: 'deploying' }, 3, 1));

      const res = await service.complete('q1', 'tok-1');

      expect(res).toEqual({ applied: true });
      const arg = update.mock.calls[0][0];
      expect(arg.doc.status).toBe('completed');
      expect(arg.doc.error_message).toBeNull();
    });

    it('fences out a zombie whose lease no longer matches (no write)', async () => {
      // Entry was reclaimed (token now null) — the old holder must not clobber it.
      get.mockResolvedValue(getDoc({ lease_token: null, status: 'pending' }));

      const res = await service.fail('q1', 'boom', 'stale-token');

      expect(res).toEqual({ applied: false, reason: 'lease-mismatch' });
      expect(update).not.toHaveBeenCalled();
    });

    it('is idempotent — never clobbers an already-terminal status', async () => {
      get.mockResolvedValue(getDoc({ lease_token: 'tok-1', status: 'completed' }));

      const res = await service.fail('q1', 'boom', 'tok-1');

      expect(res).toEqual({ applied: false, reason: 'already-terminal' });
      expect(update).not.toHaveBeenCalled();
    });

    it('retries on a version conflict (heartbeat raced the write) then applies', async () => {
      get
        .mockResolvedValueOnce(getDoc({ lease_token: 'tok-1', status: 'benchmarking' }, 7, 2))
        .mockResolvedValueOnce(getDoc({ lease_token: 'tok-1', status: 'benchmarking' }, 9, 2));
      update
        .mockRejectedValueOnce(versionConflict())
        .mockResolvedValueOnce({ result: 'updated' });

      const res = await service.complete('q1', 'tok-1');

      expect(res).toEqual({ applied: true });
      expect(get).toHaveBeenCalledTimes(2);
      // Second attempt used the fresh seq_no from the re-read.
      expect(update.mock.calls[1][0].if_seq_no).toBe(9);
    });

    it('gives up after exhausting conflict retries', async () => {
      get.mockResolvedValue(getDoc({ lease_token: 'tok-1', status: 'benchmarking' }));
      update.mockRejectedValue(versionConflict());

      const res = await service.fail('q1', 'boom', 'tok-1');

      expect(res).toEqual({ applied: false, reason: 'conflict' });
    });

    it('reports not-found when the entry is gone', async () => {
      const err = new Error('not found') as Error & { statusCode: number };
      err.statusCode = 404;
      get.mockRejectedValue(err);

      const res = await service.complete('q1', 'tok-1');

      expect(res).toEqual({ applied: false, reason: 'not-found' });
    });
  });

  describe('reclaimStaleEntries excludeIds', () => {
    it('never reclaims an entry the caller is actively processing', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T05:00:00Z'));
      search.mockResolvedValue({
        hits: {
          hits: [
            activeHit('owned', { heartbeat_at: '2026-01-01T00:00:00Z' }),
            activeHit('orphan', { heartbeat_at: '2026-01-01T00:00:00Z' }),
          ],
        },
      });

      const reclaimed = await service.reclaimStaleEntries(
        DEFAULT_ENTRY_STALE_AFTER_MS,
        new Set(['owned']),
      );

      // Only the orphan is reset; the owned (excluded) entry is skipped.
      expect(reclaimed).toBe(1);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0].id).toBe('orphan');
    });
  });

  it('exposes a sane default stale window', () => {
    expect(DEFAULT_ENTRY_STALE_AFTER_MS).toBe(120_000);
  });

  describe('findRecentTerminalModelIds (discovery de-dup)', () => {
    it('returns the set of model ids terminal since the cutoff', async () => {
      search.mockResolvedValue({
        hits: {
          hits: [
            { _id: 'a', _source: { model_id: 'org/one' } },
            { _id: 'b', _source: { model_id: 'org/two' } },
            { _id: 'c', _source: { model_id: 'org/one' } },
          ],
        },
      });

      const ids = await service.findRecentTerminalModelIds('2026-06-01T00:00:00Z');

      expect(ids).toEqual(new Set(['org/one', 'org/two']));
      const query = search.mock.calls[0][0].query.bool.filter;
      expect(query).toContainEqual({ terms: { status: ['completed', 'failed'] } });
    });
  });

  describe('requeueFailedEntries (DLQ sweep)', () => {
    it('resets each failed entry to pending and counts applied writes', async () => {
      update
        .mockResolvedValueOnce({ result: 'updated' })
        .mockResolvedValueOnce({ result: 'noop' }); // no longer failed

      const requeued = await service.requeueFailedEntries(['q1', 'q2']);

      expect(requeued).toBe(1);
      expect(update).toHaveBeenCalledTimes(2);
      expect(update.mock.calls[0][0].script.source).toContain("status == 'failed'");
    });
  });

  describe('countByStatus', () => {
    it('maps aggregation buckets onto every status key', async () => {
      search.mockResolvedValue({
        aggregations: {
          by_status: {
            buckets: [
              { key: 'pending', doc_count: 3 },
              { key: 'failed', doc_count: 2 },
              { key: 'completed', doc_count: 5 },
            ],
          },
        },
        hits: { hits: [] },
      });

      const counts = await service.countByStatus();

      expect(counts).toEqual({
        pending: 3,
        deploying: 0,
        benchmarking: 0,
        completed: 5,
        failed: 2,
        cancelled: 0,
      });
    });
  });

  describe('sumBenchmarkMsSince (VM utilization)', () => {
    it('sums valid durations and ignores incomplete/invalid rows', async () => {
      search.mockResolvedValue({
        hits: {
          hits: [
            { _id: '1', _source: { started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T01:00:00Z' } },
            { _id: '2', _source: { started_at: '2026-01-01T00:00:00Z', completed_at: null } },
            { _id: '3', _source: { started_at: '2026-01-01T02:00:00Z', completed_at: '2026-01-01T01:00:00Z' } },
          ],
        },
      });

      const { runs, benchmarkMs } = await service.sumBenchmarkMsSince('2026-01-01T00:00:00Z');

      expect(runs).toBe(1);
      expect(benchmarkMs).toBe(60 * 60 * 1000);
    });
  });
});
