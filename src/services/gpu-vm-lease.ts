import { hostname } from 'node:os';
import type { Client } from '@elastic/elasticsearch';
import { createLogger } from '../utils/logger.js';
import { INDEX_NAMES } from './es-index-mappings.js';

const INDEX = INDEX_NAMES.BENCHMARKER_DAEMON_LEASE;

/** Default staleness window: a lease whose heartbeat is older than this is reclaimable. */
const DEFAULT_STALE_AFTER_MS = 120_000;

/** Identity + freshness of a lease currently recorded in Elasticsearch. */
export interface LeaseHolder {
  vmHost: string;
  ownerHostname: string;
  ownerPid: number;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface AcquireResult {
  /** True when this process now owns the lease. */
  success: boolean;
  /** Present when the lease is held by a different, still-alive daemon. */
  heldBy?: LeaseHolder;
  /** Populated on unexpected Elasticsearch errors. */
  error?: string;
}

export interface GpuVmLeaseOptions {
  esClient: Client;
  /** The shared GPU VM host the lease guards (e.g. `config.ssh.host`). */
  vmHost: string;
  /** How long since the last heartbeat before a lease is considered stale. Default 120s. */
  staleAfterMs?: number;
  /** Overrides for tests. */
  now?: () => number;
  hostnameFn?: () => string;
  pid?: number;
  logLevel?: string;
}

interface EsLease {
  vm_host: string;
  owner_hostname: string;
  owner_pid: number;
  acquired_at: string;
  heartbeat_at: string;
}

interface EsGetResult {
  _source?: EsLease;
  _seq_no?: number;
  _primary_term?: number;
}

function toHolder(src: EsLease): LeaseHolder {
  return {
    vmHost: src.vm_host,
    ownerHostname: src.owner_hostname,
    ownerPid: src.owner_pid,
    acquiredAt: src.acquired_at,
    heartbeatAt: src.heartbeat_at,
  };
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const e = err as { statusCode?: number; meta?: { statusCode?: number } };
    return e.statusCode ?? e.meta?.statusCode;
  }
  return undefined;
}

/** Deterministic, index-safe document id derived from the VM host. */
function leaseDocId(vmHost: string): string {
  return `vm:${vmHost.trim().toLowerCase()}`;
}

/**
 * Cross-host mutual-exclusion lease for the shared GPU VM.
 *
 * All benchmarker daemons (across machines) share one Elasticsearch cluster and
 * deploy to the same GPU VM. The local PID lockfile only guards a single host,
 * so two daemons on different machines can both claim the VM and thrash it.
 * This service records a single lease document per VM host with a periodic
 * heartbeat; a second daemon refuses to start while the lease is fresh.
 *
 * Never throws: methods log and return structured results.
 */
export class GpuVmLeaseService {
  private readonly esClient: Client;
  private readonly vmHost: string;
  private readonly docId: string;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private readonly ownerHostname: string;
  private readonly ownerPid: number;
  private readonly logger: ReturnType<typeof createLogger>;
  private owns = false;

  constructor(options: GpuVmLeaseOptions) {
    this.esClient = options.esClient;
    this.vmHost = options.vmHost;
    this.docId = leaseDocId(options.vmHost);
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
    this.ownerHostname = (options.hostnameFn ?? hostname)();
    this.ownerPid = options.pid ?? process.pid;
    this.logger = createLogger(options.logLevel ?? 'info');
  }

  private isMine(holder: LeaseHolder): boolean {
    return holder.ownerHostname === this.ownerHostname && holder.ownerPid === this.ownerPid;
  }

  private isFresh(holder: LeaseHolder): boolean {
    const heartbeat = Date.parse(holder.heartbeatAt);
    if (Number.isNaN(heartbeat)) return false;
    return this.now() - heartbeat < this.staleAfterMs;
  }

  private buildDoc(acquiredAt: string): EsLease {
    return {
      vm_host: this.vmHost,
      owner_hostname: this.ownerHostname,
      owner_pid: this.ownerPid,
      acquired_at: acquiredAt,
      heartbeat_at: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Attempt to acquire the lease. Succeeds when the VM is free, the existing
   * lease is stale, or this process already owns it. Refuses (without throwing)
   * when another daemon holds a fresh lease.
   */
  async acquire(): Promise<AcquireResult> {
    try {
      const existing = await this.readLease();

      if (existing) {
        const holder = toHolder(existing.source);
        if (this.isFresh(holder) && !this.isMine(holder)) {
          return { success: false, heldBy: holder };
        }
        // Stale, or already ours: take/refresh it, guarding the rare race with
        // optimistic concurrency so a simultaneous takeover is detected.
        const acquiredAt = this.isMine(holder) ? holder.acquiredAt : new Date(this.now()).toISOString();
        try {
          await this.esClient.index({
            index: INDEX,
            id: this.docId,
            document: this.buildDoc(acquiredAt),
            if_seq_no: existing.seqNo,
            if_primary_term: existing.primaryTerm,
            refresh: true,
          });
        } catch (err) {
          if (statusOf(err) === 409) {
            return await this.refuseAfterConflict();
          }
          throw err;
        }
        this.owns = true;
        return { success: true };
      }

      // No lease yet: create with op_type=create so a concurrent creator loses.
      try {
        await this.esClient.create({
          index: INDEX,
          id: this.docId,
          document: this.buildDoc(new Date(this.now()).toISOString()),
          refresh: true,
        });
      } catch (err) {
        if (statusOf(err) === 409) {
          return await this.refuseAfterConflict();
        }
        throw err;
      }
      this.owns = true;
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('GPU VM lease acquire failed', { vmHost: this.vmHost, error: message });
      return { success: false, error: message };
    }
  }

  /** Re-read after a version conflict and refuse if a fresh non-us owner won the race. */
  private async refuseAfterConflict(): Promise<AcquireResult> {
    const current = await this.readLease();
    if (current) {
      const holder = toHolder(current.source);
      if (this.isFresh(holder) && !this.isMine(holder)) {
        return { success: false, heldBy: holder };
      }
    }
    return { success: false, error: 'lease contended (version conflict)' };
  }

  private async readLease(): Promise<
    { source: EsLease; seqNo: number | undefined; primaryTerm: number | undefined } | null
  > {
    try {
      const res = (await this.esClient.get({ index: INDEX, id: this.docId })) as EsGetResult;
      if (!res._source) return null;
      return { source: res._source, seqNo: res._seq_no, primaryTerm: res._primary_term };
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  /** Refresh the heartbeat. Best-effort: logs and swallows failures. */
  async heartbeat(): Promise<void> {
    if (!this.owns) return;
    try {
      await this.esClient.update({
        index: INDEX,
        id: this.docId,
        doc: { heartbeat_at: new Date(this.now()).toISOString() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('GPU VM lease heartbeat failed', { vmHost: this.vmHost, error: message });
    }
  }

  /** Release the lease if we own it. Best-effort: logs and swallows failures. */
  async release(): Promise<void> {
    if (!this.owns) return;
    try {
      await this.esClient.delete({ index: INDEX, id: this.docId, refresh: true });
      this.owns = false;
    } catch (err) {
      if (statusOf(err) === 404) {
        this.owns = false;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('GPU VM lease release failed', { vmHost: this.vmHost, error: message });
    }
  }

  /** True when this process currently believes it holds the lease. */
  holdsLease(): boolean {
    return this.owns;
  }
}
