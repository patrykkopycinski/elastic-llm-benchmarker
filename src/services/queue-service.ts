import { randomUUID } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import { INDEX_NAMES } from './es-index-mappings.js';

const INDEX = INDEX_NAMES.BENCHMARKER_QUEUE;

/**
 * Default staleness window for in-flight queue entries. An entry whose
 * `heartbeat_at` is older than this (or missing) is considered abandoned by a
 * dead daemon and is reclaimable back to `pending`. Mirrors the GPU VM lease's
 * 120s window so a single crashed run is retried, not silently marked failed.
 */
export const DEFAULT_ENTRY_STALE_AFTER_MS = 120_000;

/**
 * Max attempts for a fenced terminal write before giving up. Retries only fire
 * on a version conflict (a heartbeat racing the write); 3 is ample since the
 * only concurrent writer to an owned entry is its own heartbeat.
 */
const TERMINAL_WRITE_MAX_ATTEMPTS = 3;

/** Why a fenced terminal write did not apply. */
export type TerminalWriteReason =
  | 'lease-mismatch'
  | 'already-terminal'
  | 'not-found'
  | 'conflict';

/** True when an ES client error carries the given HTTP status code. */
function isStatusCode(err: unknown, code: number): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; meta?: { statusCode?: number } };
  return e.statusCode === code || e.meta?.statusCode === code;
}

export interface QueueEntry {
  id: string;
  modelId: string;
  source: 'user' | 'discovery';
  priority: number;
  status: 'pending' | 'deploying' | 'benchmarking' | 'completed' | 'failed' | 'cancelled';
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  requestedBy: string | null;
  /** Opaque fencing token stamped on claim; only the holder may write terminal status. */
  leaseToken: string | null;
  /** Last heartbeat from the owning daemon; drives stale-entry reclamation. */
  heartbeatAt: string | null;
  metadata?: {
    configOverrides?: {
      tensorParallelSize?: number;
      maxModelLen?: number;
    };
    skipReasoning?: boolean;
    /** Trending score assigned by the discovery scheduler. */
    trendingScore?: number;
    /** Whether the model fits the target hardware profile. */
    hardwareFit?: boolean;
    /** Hardware profile ID used for dry-run estimation. */
    hardwareProfileId?: string;
    /** Estimated VRAM in GB from dry-run check. */
    estimatedGb?: number | null;
    /** Whether the model fits the hardware profile. */
    fits?: boolean | null;
    /** Whether the enqueue was forced despite failing checks. */
    force?: boolean;
    /** Reason or note for the enqueue. */
    reason?: string;
    /** Number of prior auto-retries after transient/resource failures (retry budget). */
    infraRetryCount?: number;
  };
}

type EsSource = {
  model_id: string;
  source: 'user' | 'discovery';
  priority: number;
  status: QueueEntry['status'];
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  requested_by: string | null;
  lease_token?: string | null;
  heartbeat_at?: string | null;
  metadata?: {
    config_overrides?: {
      tensor_parallel_size?: number;
      max_model_len?: number;
    };
    skip_reasoning?: boolean;
    trending_score?: number;
    hardware_fit?: boolean;
    hardware_profile_id?: string;
    estimated_gb?: number | null;
    fits?: boolean | null;
    force?: boolean;
    reason?: string;
    infra_retry_count?: number;
  };
};

function toEntry(id: string, src: EsSource): QueueEntry {
  return {
    id,
    modelId: src.model_id,
    source: src.source,
    priority: src.priority,
    status: src.status,
    requestedAt: src.requested_at,
    startedAt: src.started_at ?? null,
    completedAt: src.completed_at ?? null,
    errorMessage: src.error_message ?? null,
    requestedBy: src.requested_by ?? null,
    leaseToken: src.lease_token ?? null,
    heartbeatAt: src.heartbeat_at ?? null,
    metadata: src.metadata ? {
      configOverrides: src.metadata.config_overrides ? {
        tensorParallelSize: src.metadata.config_overrides.tensor_parallel_size,
        maxModelLen: src.metadata.config_overrides.max_model_len,
      } : undefined,
      skipReasoning: src.metadata.skip_reasoning,
      trendingScore: src.metadata.trending_score,
      hardwareFit: src.metadata.hardware_fit,
      hardwareProfileId: src.metadata.hardware_profile_id,
      estimatedGb: src.metadata.estimated_gb,
      fits: src.metadata.fits,
      force: src.metadata.force,
      reason: src.metadata.reason,
      infraRetryCount: src.metadata.infra_retry_count,
    } : undefined,
  };
}

export class QueueService {
  constructor(private readonly esClient: Client) { }

  async enqueue(
    modelId: string,
    source: 'user' | 'discovery',
    priority?: number,
    requestedBy?: string,
    metadata?: QueueEntry['metadata'],
  ): Promise<QueueEntry> {
    const existing = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          must: [{ term: { model_id: modelId } }],
          filter: [{ terms: { status: ['pending', 'deploying', 'benchmarking'] } }],
        },
      },
      size: 1,
    });
    const existingHit = existing.hits.hits[0];
    if (existingHit) {
      return toEntry(existingHit._id!, existingHit._source!);
    }

    const p = priority ?? (source === 'user' ? 100 : 10);
    const now = new Date().toISOString();
    const doc: EsSource = {
      model_id: modelId,
      source,
      priority: p,
      status: 'pending',
      requested_at: now,
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: requestedBy ?? null,
      lease_token: null,
      heartbeat_at: null,
      metadata: metadata ? {
        config_overrides: metadata.configOverrides ? {
          tensor_parallel_size: metadata.configOverrides.tensorParallelSize,
          max_model_len: metadata.configOverrides.maxModelLen,
        } : undefined,
        skip_reasoning: metadata.skipReasoning,
        trending_score: metadata.trendingScore,
        hardware_fit: metadata.hardwareFit,
        hardware_profile_id: metadata.hardwareProfileId,
        estimated_gb: metadata.estimatedGb,
        fits: metadata.fits,
        force: metadata.force,
        reason: metadata.reason,
        infra_retry_count: metadata.infraRetryCount,
      } : undefined,
    };
    const res = await this.esClient.index({
      index: INDEX,
      document: doc,
      refresh: true,
    });
    const id = res._id!;
    return toEntry(id, doc);
  }

  async dequeue(): Promise<QueueEntry | null> {
    const searchRes = await this.esClient.search<EsSource>({
      index: INDEX,
      query: { term: { status: 'pending' } },
      sort: [{ priority: { order: 'desc' } }, { requested_at: { order: 'asc' } }],
      size: 1,
    });
    const hit = searchRes.hits.hits[0];
    if (!hit) return null;

    const now = new Date().toISOString();
    const leaseToken = randomUUID();
    const updateRes = await this.esClient.update({
      index: INDEX,
      id: hit._id!,
      script: {
        source: `
          if (ctx._source.status == 'pending') {
            ctx._source.status = 'deploying';
            ctx._source.started_at = params.now;
            ctx._source.heartbeat_at = params.now;
            ctx._source.lease_token = params.token;
          } else {
            ctx.op = 'none';
          }
        `,
        params: { now, token: leaseToken },
      },
      refresh: true,
    });

    if (updateRes.result === 'noop') return null;

    const getRes = await this.esClient.get<EsSource>({
      index: INDEX,
      id: hit._id!,
    });
    return toEntry(getRes._id!, getRes._source!);
  }

  async getQueue(filters?: { status?: string; source?: string }): Promise<QueueEntry[]> {
    const must: object[] = [];
    if (filters?.status) must.push({ term: { status: filters.status } });
    if (filters?.source) must.push({ term: { source: filters.source } });
    const query = must.length > 0 ? { bool: { must } } : { match_all: {} };

    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query,
      sort: [{ priority: { order: 'desc' } }, { requested_at: { order: 'asc' } }],
      size: 100,
    });

    return res.hits.hits.map((h) => toEntry(h._id!, h._source!));
  }

  /**
   * Get a specific queue entry by ID (efficient for polling).
   * Much faster than getQueue() when only one entry is needed.
   */
  async getById(id: string): Promise<QueueEntry | null> {
    try {
      const res = await this.esClient.get<EsSource>({
        index: INDEX,
        id,
      });

      if (!res.found || !res._source) {
        return null;
      }

      return toEntry(res._id!, res._source);
    } catch (err: any) {
      if (err.statusCode === 404 || err.meta?.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getCurrent(): Promise<QueueEntry | null> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          should: [
            { term: { status: 'deploying' } },
            { term: { status: 'benchmarking' } },
          ],
          minimum_should_match: 1,
        },
      },
      size: 1,
    });
    const hit = res.hits.hits[0];
    if (!hit) return null;
    return toEntry(hit._id!, hit._source!);
  }

  /** All in-flight queue entries (deploying or benchmarking). */
  async getActiveEntries(): Promise<QueueEntry[]> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          should: [
            { term: { status: 'deploying' } },
            { term: { status: 'benchmarking' } },
          ],
          minimum_should_match: 1,
        },
      },
      sort: [{ started_at: { order: 'asc' } }],
      size: 100,
    });
    return res.hits.hits.map((h) => toEntry(h._id!, h._source!));
  }

  /**
   * Mark all deploying/benchmarking entries as failed.
   * Used when a new daemon starts after an unclean shutdown.
   *
   * Prefer {@link reclaimStaleEntries} on daemon startup: it retries crashed
   * runs instead of losing them, and never touches an entry a live daemon is
   * still heartbeating. `failActiveEntries` remains for explicit operator
   * "fail everything" actions (e.g. `benchmarker-queue clear`).
   */
  async failActiveEntries(errorMessage: string): Promise<number> {
    const entries = await this.getActiveEntries();
    for (const entry of entries) {
      await this.updateStatus(entry.id, 'failed', errorMessage);
    }
    return entries.length;
  }

  /**
   * Reset in-flight entries whose heartbeat is stale (or missing) back to
   * `pending` so a new daemon retries them, rather than blindly failing them.
   * Entries a live daemon is still heartbeating (fresh within `staleAfterMs`)
   * are left untouched. Called on daemon startup after acquiring the VM lease.
   *
   * @returns count of entries reclaimed to `pending`.
   */
  async reclaimStaleEntries(
    staleAfterMs: number = DEFAULT_ENTRY_STALE_AFTER_MS,
    excludeIds?: ReadonlySet<string>,
  ): Promise<number> {
    const entries = await this.getActiveEntries();
    const nowMs = Date.now();
    let reclaimed = 0;
    for (const entry of entries) {
      // Never reclaim an entry the live caller is actively processing —
      // the periodic backstop must not reset a run out from under its owner.
      if (excludeIds?.has(entry.id)) continue;
      const freshnessRef = entry.heartbeatAt ?? entry.startedAt;
      const refMs = freshnessRef ? Date.parse(freshnessRef) : NaN;
      const isStale = Number.isNaN(refMs) || nowMs - refMs >= staleAfterMs;
      if (!isStale) continue;
      if (await this.reclaimEntry(entry.id)) reclaimed++;
    }
    return reclaimed;
  }

  /**
   * Reset a single in-flight entry back to `pending` (clearing lease + timing),
   * so it is retried from scratch rather than lost. No-op if the entry is no
   * longer `deploying`/`benchmarking`.
   * @returns true when the reset was applied.
   */
  async reclaimEntry(id: string): Promise<boolean> {
    const updateRes = await this.esClient.update({
      index: INDEX,
      id,
      script: {
        source: `
          if (ctx._source.status == 'deploying' || ctx._source.status == 'benchmarking') {
            ctx._source.status = 'pending';
            ctx._source.started_at = null;
            ctx._source.heartbeat_at = null;
            ctx._source.lease_token = null;
            ctx._source.error_message = null;
          } else {
            ctx.op = 'none';
          }
        `,
      },
      refresh: true,
    });
    return updateRes.result !== 'noop';
  }

  /**
   * Refresh the heartbeat on an in-flight entry the caller owns. Only writes
   * when the held `leaseToken` still matches and the entry is in-flight.
   * @returns true when the heartbeat was applied.
   */
  async heartbeat(id: string, leaseToken: string): Promise<boolean> {
    const now = new Date().toISOString();
    const updateRes = await this.esClient.update({
      index: INDEX,
      id,
      script: {
        source: `
          if (ctx._source.lease_token == params.token
              && (ctx._source.status == 'deploying' || ctx._source.status == 'benchmarking')) {
            ctx._source.heartbeat_at = params.now;
          } else {
            ctx.op = 'none';
          }
        `,
        params: { now, token: leaseToken },
      },
    });
    return updateRes.result !== 'noop';
  }

  /**
   * Take ownership of an in-flight entry a previous daemon abandoned (used on
   * the scheduler resume path): stamp a fresh lease token + heartbeat so the
   * resuming daemon can fence its own terminal writes.
   * @returns the new lease token, or null if the entry is no longer in-flight.
   */
  async adoptEntry(id: string): Promise<string | null> {
    const now = new Date().toISOString();
    const leaseToken = randomUUID();
    const updateRes = await this.esClient.update({
      index: INDEX,
      id,
      script: {
        source: `
          if (ctx._source.status == 'deploying' || ctx._source.status == 'benchmarking') {
            ctx._source.heartbeat_at = params.now;
            ctx._source.lease_token = params.token;
          } else {
            ctx.op = 'none';
          }
        `,
        params: { now, token: leaseToken },
      },
      refresh: true,
    });
    return updateRes.result === 'noop' ? null : leaseToken;
  }

  /**
   * Mark an entry `completed`, fenced by the caller's lease token. Only the
   * process holding the current lease may write terminal status. See
   * {@link writeTerminalFenced} for the concurrency guarantee.
   */
  async complete(
    id: string,
    leaseToken: string,
  ): Promise<{ applied: boolean; reason?: TerminalWriteReason }> {
    return this.writeTerminalFenced(id, 'completed', undefined, leaseToken);
  }

  /**
   * Mark an entry `failed` with an error message, fenced by the caller's lease
   * token. Only the process holding the current lease may write terminal
   * status. See {@link writeTerminalFenced} for the concurrency guarantee.
   */
  async fail(
    id: string,
    errorMessage: string,
    leaseToken: string,
  ): Promise<{ applied: boolean; reason?: TerminalWriteReason }> {
    return this.writeTerminalFenced(id, 'failed', errorMessage, leaseToken);
  }

  /**
   * Fenced terminal write — the root-cause fix for the spurious-`failed` bug.
   *
   * Reads the current doc, then:
   *  1. Rejects unless `lease_token` matches EXACTLY (no `== null` escape): a
   *     zombie daemon whose lease was reclaimed (token nulled) or adopted (token
   *     replaced) can never clobber the live owner.
   *  2. Is idempotent — never overwrites an already-terminal status.
   *  3. Writes with `if_seq_no`/`if_primary_term` optimistic concurrency so a
   *     write that races another modification (typically a heartbeat that
   *     advanced the version between our read and write) is retried against the
   *     fresh version rather than silently lost. The lease check re-runs on each
   *     retry, so retrying never weakens the fence.
   */
  private async writeTerminalFenced(
    id: string,
    status: Extract<QueueEntry['status'], 'completed' | 'failed' | 'cancelled'>,
    errorMessage: string | undefined,
    leaseToken: string,
  ): Promise<{ applied: boolean; reason?: TerminalWriteReason }> {
    for (let attempt = 0; attempt < TERMINAL_WRITE_MAX_ATTEMPTS; attempt++) {
      let current: {
        found?: boolean;
        _source?: EsSource;
        _seq_no?: number;
        _primary_term?: number;
      };
      try {
        current = await this.esClient.get<EsSource>({ index: INDEX, id });
      } catch (err: unknown) {
        if (isStatusCode(err, 404)) return { applied: false, reason: 'not-found' };
        throw err;
      }
      const src = current._source;
      if (!current.found || !src) return { applied: false, reason: 'not-found' };

      // Fence: only the current lease holder may write terminal status.
      if (src.lease_token !== leaseToken) {
        return { applied: false, reason: 'lease-mismatch' };
      }
      // Idempotent: never clobber a status another writer already finalized.
      if (src.status === 'completed' || src.status === 'failed' || src.status === 'cancelled') {
        return { applied: false, reason: 'already-terminal' };
      }

      const now = new Date().toISOString();
      const doc: Partial<EsSource> = {
        status,
        completed_at: now,
        lease_token: null,
        error_message: errorMessage ?? null,
      };

      try {
        await this.esClient.update({
          index: INDEX,
          id,
          doc,
          if_seq_no: current._seq_no,
          if_primary_term: current._primary_term,
          refresh: true,
        });
        return { applied: true };
      } catch (err: unknown) {
        // Version conflict: a concurrent write (e.g. a heartbeat) advanced the
        // doc between our read and write. Re-read and retry — the lease check on
        // the next attempt still fences out zombies.
        if (isStatusCode(err, 409)) continue;
        throw err;
      }
    }
    return { applied: false, reason: 'conflict' };
  }

  /**
   * Update an entry's status. Prefer {@link complete}/{@link fail} for terminal
   * transitions — they are lease-fenced with optimistic concurrency. This
   * remains for non-terminal transitions (`deploying`→`benchmarking`) and
   * explicit unfenced admin writes (e.g. `failActiveEntries`).
   *
   * When `leaseToken` is supplied the write is fenced: it only applies when the
   * entry's current `lease_token` matches (or is unset, for legacy/unclaimed
   * entries), so a zombie daemon cannot stamp status over a live owner. Returns
   * whether the write was applied.
   */
  async updateStatus(
    id: string,
    status: QueueEntry['status'],
    errorMessage?: string,
    leaseToken?: string,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);

    const mutations: string[] = [
      `ctx._source.status = params.status;`,
      ...(terminal ? [`ctx._source.completed_at = params.now; ctx._source.lease_token = null;`] : []),
      ...(errorMessage !== undefined ? [`ctx._source.error_message = params.error_message;`] : []),
    ];

    // When a lease token is held, fence the write: apply only if the entry's
    // current token matches or is unset (legacy entries claimed pre-fencing).
    const source = leaseToken
      ? `
          if (ctx._source.lease_token == null || ctx._source.lease_token == params.token) {
            ${mutations.join(' ')}
          } else {
            ctx.op = 'none';
          }
        `
      : mutations.join(' ');

    const updateRes = await this.esClient.update({
      index: INDEX,
      id,
      script: {
        source,
        params: {
          status,
          now,
          error_message: errorMessage ?? null,
          token: leaseToken ?? null,
        },
      },
      refresh: true,
    });
    return updateRes.result !== 'noop';
  }

  async cancel(id: string): Promise<boolean | null> {
    try {
      const updateRes = await this.esClient.update({
        index: INDEX,
        id,
        script: {
          source: `
            if (ctx._source.status == 'pending') {
              ctx._source.status = 'cancelled';
              ctx._source.completed_at = params.now;
            } else {
              ctx.op = 'none';
            }
          `,
          params: { now: new Date().toISOString() },
        },
        refresh: true,
      });
      return updateRes.result !== 'noop';
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  async cancelAllPending(): Promise<number> {
    const pending = await this.findPending(500);
    let cancelled = 0;
    for (const entry of pending) {
      const result = await this.cancel(entry.id);
      if (result === true) cancelled++;
    }
    return cancelled;
  }

  async findPending(limit: number = 10): Promise<QueueEntry[]> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: { term: { status: 'pending' } },
      sort: [{ priority: { order: 'desc' } }, { requested_at: { order: 'asc' } }],
      size: limit,
    });
    return res.hits.hits.map((h) => toEntry(h._id!, h._source!));
  }

  async hasPending(): Promise<boolean> {
    const res = await this.esClient.count({
      index: INDEX,
      query: { term: { status: 'pending' } },
    });
    return (res.count ?? 0) > 0;
  }

  async getPending(): Promise<number> {
    const res = await this.esClient.count({
      index: INDEX,
      query: { term: { status: 'pending' } },
    });
    return res.count ?? 0;
  }

  /**
   * Count queue entries that reached a terminal state (`completed`/`failed`)
   * at or after `sinceIso`. Drives the daily cost-cap gate: capping models/day
   * transitively caps the CI-eval builds + EIS reasoning each model triggers.
   * `cancelled` is excluded — a cancel spends no GPU/CI/token budget.
   */
  async countTerminalSince(sinceIso: string): Promise<number> {
    const res = await this.esClient.count({
      index: INDEX,
      query: {
        bool: {
          filter: [
            { terms: { status: ['completed', 'failed'] } },
            { range: { completed_at: { gte: sinceIso } } },
          ],
        },
      },
    });
    return res.count ?? 0;
  }

  /**
   * Model ids that reached a terminal state (`completed` or `failed`) at or
   * after `sinceIso`. Drives discovery de-dup: a model just benchmarked or
   * quarantined should not be re-queued and spend cost-cap budget on a repeat.
   * `cancelled` is excluded (a cancel is not an evaluation).
   */
  async findRecentTerminalModelIds(sinceIso: string): Promise<Set<string>> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          filter: [
            { terms: { status: ['completed', 'failed'] } },
            { range: { completed_at: { gte: sinceIso } } },
          ],
        },
      },
      _source: ['model_id'],
      size: 1000,
    });
    const ids = new Set<string>();
    for (const hit of res.hits.hits) {
      const modelId = hit._source?.model_id;
      if (modelId) ids.add(modelId);
    }
    return ids;
  }

  /**
   * Re-enqueue quarantined (`failed`) entries whose failure was classified
   * retriable and which have sat past `olderThanIso`, up to `limit`. The DLQ
   * triage sweep: a `transient-infra` failure may become runnable after a vLLM
   * image bump or infra recovery. Resets the entry to `pending` with a fresh
   * priority and clears the terminal timestamp/error. Returns the model ids
   * re-enqueued. The caller decides retriability (owns the classifier).
   */
  async requeueFailedEntries(
    ids: readonly string[],
  ): Promise<number> {
    let requeued = 0;
    const now = new Date().toISOString();
    for (const id of ids) {
      const res = await this.esClient.update({
        index: INDEX,
        id,
        script: {
          source: `
            if (ctx._source.status == 'failed') {
              ctx._source.status = 'pending';
              ctx._source.started_at = null;
              ctx._source.completed_at = null;
              ctx._source.heartbeat_at = null;
              ctx._source.lease_token = null;
              ctx._source.error_message = null;
              ctx._source.requested_at = params.now;
            } else {
              ctx.op = 'none';
            }
          `,
          params: { now },
        },
        refresh: true,
      });
      if (res.result !== 'noop') requeued++;
    }
    return requeued;
  }

  /**
   * Fetch `failed` entries at or before `beforeIso`, newest terminal first,
   * up to `limit`. Used by the DLQ triage sweep to find quarantine candidates.
   */
  async findFailedEntries(beforeIso: string, limit: number = 100): Promise<QueueEntry[]> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          filter: [
            { term: { status: 'failed' } },
            { range: { completed_at: { lte: beforeIso } } },
          ],
        },
      },
      sort: [{ completed_at: { order: 'asc' } }],
      size: limit,
    });
    return res.hits.hits.map((h) => toEntry(h._id!, h._source!));
  }

  /**
   * Sum wall-clock benchmark time (started_at → completed_at) across terminal
   * (`completed`/`failed`) entries that finished at or after `sinceIso`, plus a
   * run count. Feeds the VM utilization ratio (benchmark-hours / wall-hours):
   * the GPU VM is never stopped, so low utilization is the signal to widen
   * discovery / raise the daily cap, not to stop the VM.
   */
  async sumBenchmarkMsSince(sinceIso: string): Promise<{ runs: number; benchmarkMs: number }> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      query: {
        bool: {
          filter: [
            { terms: { status: ['completed', 'failed'] } },
            { range: { completed_at: { gte: sinceIso } } },
          ],
        },
      },
      _source: ['started_at', 'completed_at'],
      size: 1000,
    });
    let benchmarkMs = 0;
    let runs = 0;
    for (const hit of res.hits.hits) {
      const src = hit._source;
      if (!src?.started_at || !src.completed_at) continue;
      const start = Date.parse(src.started_at);
      const end = Date.parse(src.completed_at);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
      benchmarkMs += end - start;
      runs++;
    }
    return { runs, benchmarkMs };
  }

  /** Count queue entries grouped by terminal/in-flight status. */
  async countByStatus(): Promise<Record<QueueEntry['status'], number>> {
    const res = await this.esClient.search<EsSource>({
      index: INDEX,
      size: 0,
      aggs: { by_status: { terms: { field: 'status', size: 20 } } },
    });
    const buckets =
      (res.aggregations?.by_status as { buckets?: Array<{ key: string; doc_count: number }> })
        ?.buckets ?? [];
    const counts: Record<QueueEntry['status'], number> = {
      pending: 0,
      deploying: 0,
      benchmarking: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const b of buckets) {
      if (b.key in counts) counts[b.key as QueueEntry['status']] = b.doc_count;
    }
    return counts;
  }

  async shouldAutoStop(entryId: string, maxDurationMs: number): Promise<boolean> {
    const [entryRes, pendingRes] = await Promise.all([
      this.esClient.get<EsSource>({ index: INDEX, id: entryId }).catch(() => null),
      this.esClient.count({
        index: INDEX,
        query: { term: { status: 'pending' } },
      }),
    ]);

    if (!entryRes?.found || !entryRes._source) return false;
    const src = entryRes._source;
    if (src.status !== 'deploying' && src.status !== 'benchmarking') return false;
    if ((pendingRes.count ?? 0) === 0) return false;

    const startedAt = src.started_at;
    if (!startedAt) return false;
    const elapsed = Date.now() - new Date(startedAt).getTime();
    return elapsed > maxDurationMs;
  }
}
