import Database from 'better-sqlite3';
import type { QueueEntry } from './queue-service.js';
import { PIPELINE_STAGE_LABELS, type PipelineProgress } from '../types/pipeline-progress.js';

export type QueueStatus = QueueEntry['status'];

/**
 * The fields this notifier reads, and no more.
 *
 * Deliberately narrower than `QueueEntry`: the SSE stream returns full entries,
 * but `GET /api/v1/evaluate/:id` — the truncation-recovery route — returns a
 * subset with no `leaseToken`, `priority`, or `metadata`. This intersection is
 * the only shape both feeds satisfy. `EnrichedQueueEntry` also satisfies it,
 * which is how live `progress` reaches the formatter.
 */
export interface NotifiableEntry {
  id: string;
  modelId: string;
  status: QueueStatus;
  errorMessage: string | null;
  progress?: PipelineProgress;
}

/** One re-poll of `GET /queue/events`: the (capped) page plus the running entry. */
export interface QueueSnapshot {
  entries: NotifiableEntry[];
  current: NotifiableEntry | null;
}

/** Publishes to Buzz. Injected so the diffing core stays free of I/O. */
export interface MessageTransport {
  /** Opens a thread; resolves to the new root event id. */
  postRoot(content: string): Promise<string>;
  postReply(rootEventId: string, content: string): Promise<string>;
}

export interface TransitionState {
  status: QueueStatus;
  /**
   * Thread root opened when this entry was first seen, or null when no thread
   * was ever opened because the entry was already finished by then.
   */
  rootEventId: string | null;
}

/**
 * Resolves a single entry by id, bypassing the capped page. Backed by
 * `GET /api/v1/evaluate/:id`, which is a direct document GET — no `size`, no
 * `sort` — so it reaches entries the 100-doc window has truncated away.
 */
export interface EntryResolver {
  /** Null means genuinely absent (404); a throw means the lookup itself failed. */
  resolveById(entryId: string): Promise<NotifiableEntry | null>;
}

export interface TransitionStore {
  get(entryId: string): TransitionState | undefined;
  set(entryId: string, state: TransitionState): void;
  /** Tracked entries that have not reached a terminal status yet. */
  nonTerminal(): Array<{ entryId: string } & TransitionState>;
  close(): void;
}

/** Statuses after which an entry never transitions again. */
const TERMINAL_STATUSES: readonly QueueStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(status: QueueStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Durable last-seen state, so a restart replays nothing it already published. */
export class SqliteTransitionStore implements TransitionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS buzz_transitions (
        entry_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        -- Null for entries first seen already terminal: tracked so they are
        -- never re-examined, but no thread was ever opened for them.
        root_event_id TEXT
      )
    `);
  }

  get(entryId: string): TransitionState | undefined {
    const row = this.db
      .prepare('SELECT status, root_event_id FROM buzz_transitions WHERE entry_id = ?')
      .get(entryId) as { status: QueueStatus; root_event_id: string | null } | undefined;
    return row ? { status: row.status, rootEventId: row.root_event_id } : undefined;
  }

  set(entryId: string, state: TransitionState): void {
    this.db
      .prepare(
        // COALESCE keeps the original root — an entry is only ever threaded
        // once — while still filling one in for an entry first seen terminal.
        `INSERT INTO buzz_transitions (entry_id, status, root_event_id) VALUES (?, ?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET
           status = excluded.status,
           root_event_id = COALESCE(buzz_transitions.root_event_id, excluded.root_event_id)`,
      )
      .run(entryId, state.status, state.rootEventId);
  }

  nonTerminal(): Array<{ entryId: string } & TransitionState> {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT entry_id, status, root_event_id FROM buzz_transitions
         WHERE status NOT IN (${placeholders})`,
      )
      .all(...TERMINAL_STATUSES) as Array<{
      entry_id: string;
      status: QueueStatus;
      root_event_id: string | null;
    }>;
    return rows.map((r) => ({
      entryId: r.entry_id,
      status: r.status,
      rootEventId: r.root_event_id,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function formatRoot(entry: NotifiableEntry): string {
  return `**${entry.modelId}** — ${entry.status}`;
}

/** Renders live pipeline state so `benchmarking` says more than a bare status word. */
function formatProgress(progress: PipelineProgress): string {
  const parts = [PIPELINE_STAGE_LABELS[progress.stage]];
  if (progress.evalCurrent) parts.push(`running ${progress.evalCurrent}`);

  const done = progress.evalCompleted?.length;
  const total = progress.evalTotal ?? progress.evalSuites?.length;
  if (done !== undefined && total !== undefined) parts.push(`${done}/${total} suites done`);

  return parts.join(' — ');
}

function formatTransition(entry: NotifiableEntry): string {
  const headline = `**${entry.modelId}** → ${entry.status}`;
  if (entry.status === 'failed' && entry.errorMessage) {
    return `${headline}\n\n${entry.errorMessage}`;
  }
  if (entry.progress) {
    return `${headline}\n\n${formatProgress(entry.progress)}`;
  }
  return headline;
}

/**
 * Turns a stream of full-state re-polls into one message per actual status
 * change: a thread root the first time an entry is seen, a threaded reply for
 * every transition after that.
 */
export class BuzzNotifier {
  private readonly store: TransitionStore;
  private readonly transport: MessageTransport;
  private readonly resolver?: EntryResolver;

  constructor(opts: {
    store: TransitionStore;
    transport: MessageTransport;
    resolver?: EntryResolver;
  }) {
    this.store = opts.store;
    this.transport = opts.transport;
    this.resolver = opts.resolver;
  }

  async processSnapshot(snapshot: QueueSnapshot): Promise<void> {
    // `current` is fetched by an unbounded query, so it carries the running
    // entry even when the capped page has truncated it away.
    const observed = new Map<string, NotifiableEntry>();
    for (const entry of snapshot.entries) observed.set(entry.id, entry);
    if (snapshot.current) observed.set(snapshot.current.id, snapshot.current);

    for (const entry of observed.values()) {
      await this.observe(entry);
    }

    // Absence is always truncation, never deletion — `cancel()` rewrites the
    // doc in place and nothing in the queue service deletes. So a tracked
    // in-flight entry that vanished is resolved by id rather than skipped;
    // otherwise its terminal message never posts and the thread stays open.
    if (!this.resolver) return;
    for (const tracked of this.store.nonTerminal()) {
      if (observed.has(tracked.entryId)) continue;
      const resolved = await this.resolver.resolveById(tracked.entryId);
      if (resolved) await this.observe(resolved);
    }
  }

  private async observe(entry: NotifiableEntry): Promise<void> {
    const previous = this.store.get(entry.id);

    if (!previous) {
      // An entry that was already finished the first time we saw it has no
      // transition to narrate. Without this, first start against a queue
      // carrying history opens a thread per historical entry — the live queue
      // holds 100, so that is 100 messages before anything has happened.
      if (isTerminal(entry.status)) {
        this.store.set(entry.id, { status: entry.status, rootEventId: null });
        return;
      }

      const rootEventId = await this.transport.postRoot(formatRoot(entry));
      this.store.set(entry.id, { status: entry.status, rootEventId });
      return;
    }

    if (previous.status === entry.status) return;

    // No root means the entry was terminal on first sight, so it should never
    // transition again. If it somehow does, start a thread rather than drop it.
    if (previous.rootEventId === null) {
      const rootEventId = await this.transport.postRoot(formatTransition(entry));
      this.store.set(entry.id, { status: entry.status, rootEventId });
      return;
    }

    await this.transport.postReply(previous.rootEventId, formatTransition(entry));
    this.store.set(entry.id, { status: entry.status, rootEventId: previous.rootEventId });
  }
}
