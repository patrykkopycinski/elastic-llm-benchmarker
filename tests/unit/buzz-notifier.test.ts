import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueEntry } from '../../src/services/queue-service.js';
import type { EnrichedQueueEntry } from '../../src/services/queue-progress-enrichment.js';
import {
  BuzzNotifier,
  SqliteTransitionStore,
  type QueueSnapshot,
  type MessageTransport,
  type EntryResolver,
} from '../../src/services/buzz-notifier.js';

const ENTRY_ID = 'abc123';

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: ENTRY_ID,
    modelId: 'mistralai/Devstral-Small-2-24B-Instruct-2512',
    source: 'user',
    priority: 100,
    status: 'pending',
    requestedAt: '2026-07-28T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    requestedBy: 'cli',
    leaseToken: null,
    heartbeatAt: null,
    ...overrides,
  };
}

function snapshotOf(...entries: QueueEntry[]): QueueSnapshot {
  return { entries, current: null };
}

interface RecordedPost {
  kind: 'root' | 'reply';
  rootEventId?: string;
  content: string;
}

/** Records what the notifier would publish, so counts are assertable without a relay. */
function createRecordingTransport(): MessageTransport & { posts: RecordedPost[] } {
  const posts: RecordedPost[] = [];
  return {
    posts,
    async postRoot(content: string) {
      posts.push({ kind: 'root', content });
      return `evt-${posts.length}`;
    },
    async postReply(rootEventId: string, content: string) {
      posts.push({ kind: 'reply', rootEventId, content });
      return `evt-${posts.length}`;
    },
  };
}

describe('BuzzNotifier', () => {
  it('posts one thread root plus one reply per status change and nothing while idle', async () => {
    const transport = createRecordingTransport();
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
    });

    // pending (new) → idle re-poll → deploying → idle → benchmarking → completed
    await notifier.processSnapshot(snapshotOf(entry({ status: 'pending' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'pending' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'deploying' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'deploying' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'completed' })));

    expect(transport.posts).toHaveLength(4);
    expect(transport.posts[0].kind).toBe('root');
    expect(transport.posts.slice(1).map((p) => p.kind)).toEqual(['reply', 'reply', 'reply']);
    expect(transport.posts.slice(1).every((p) => p.rootEventId === 'evt-1')).toBe(true);
  });

  it('does not replay transitions it already published when restarted', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'buzz-bridge-')), 'state.db');

    const before = createRecordingTransport();
    const first = new SqliteTransitionStore(dbPath);
    const running = new BuzzNotifier({ store: first, transport: before });
    await running.processSnapshot(snapshotOf(entry({ status: 'pending' })));
    await running.processSnapshot(snapshotOf(entry({ status: 'deploying' })));
    first.close();

    // Restart against the same state file, mid-run.
    const after = createRecordingTransport();
    const restarted = new BuzzNotifier({
      store: new SqliteTransitionStore(dbPath),
      transport: after,
    });
    await restarted.processSnapshot(snapshotOf(entry({ status: 'deploying' })));
    await restarted.processSnapshot(snapshotOf(entry({ status: 'completed' })));

    expect(before.posts).toHaveLength(2);
    expect(after.posts).toHaveLength(1);
    expect(after.posts[0]).toMatchObject({ kind: 'reply', rootEventId: 'evt-1' });
  });

  it('resolves a tracked entry by id when it drops out of the capped page', async () => {
    const transport = createRecordingTransport();
    const asked: string[] = [];
    const resolver: EntryResolver = {
      async resolveById(id) {
        asked.push(id);
        return entry({ status: 'completed' });
      },
    };
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
      resolver,
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));
    await notifier.processSnapshot(snapshotOf()); // truncated off the 100-doc page

    expect(asked).toEqual([ENTRY_ID]);
    expect(transport.posts).toHaveLength(2);
    expect(transport.posts[1]).toMatchObject({ kind: 'reply', rootEventId: 'evt-1' });
  });

  it('treats an unresolvable disappearance as a no-op, not a transition', async () => {
    const transport = createRecordingTransport();
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
      resolver: { async resolveById() { return null; } },
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));
    await notifier.processSnapshot(snapshotOf());
    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));

    expect(transport.posts).toHaveLength(1);
  });

  it('stops resolving an entry once it reaches a terminal status', async () => {
    const asked: string[] = [];
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport: createRecordingTransport(),
      resolver: {
        async resolveById(id) {
          asked.push(id);
          return null;
        },
      },
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'completed' })));
    await notifier.processSnapshot(snapshotOf());

    expect(asked).toEqual([]);
  });

  it('treats cancelled as terminal', async () => {
    const asked: string[] = [];
    const transport = createRecordingTransport();
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
      resolver: {
        async resolveById(id) {
          asked.push(id);
          return null;
        },
      },
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'pending' })));
    await notifier.processSnapshot(snapshotOf(entry({ status: 'cancelled' })));
    await notifier.processSnapshot(snapshotOf());

    expect(transport.posts).toHaveLength(2);
    expect(asked).toEqual([]);
  });

  it('reports the errorMessage on a failed transition', async () => {
    const transport = createRecordingTransport();
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));
    await notifier.processSnapshot(
      snapshotOf(entry({ status: 'failed', errorMessage: 'Stage 2 Kibana CI eval failed' })),
    );

    expect(transport.posts[1].content).toContain('Stage 2 Kibana CI eval failed');
  });

  it('sees the running entry via `current` when the page has truncated it', async () => {
    const transport = createRecordingTransport();
    const asked: string[] = [];
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
      resolver: {
        async resolveById(id) {
          asked.push(id);
          return null;
        },
      },
    });

    const current: EnrichedQueueEntry = { ...entry({ status: 'benchmarking' }) };
    await notifier.processSnapshot({ entries: [], current });

    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0].kind).toBe('root');
    expect(asked).toEqual([]);
  });

  it('summarises live eval progress on a benchmarking transition', async () => {
    const transport = createRecordingTransport();
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'pending' })));

    const current: EnrichedQueueEntry = {
      ...entry({ status: 'benchmarking' }),
      progress: {
        stage: 'stage2_evals',
        detail: 'Running prompt-injection',
        evalSuites: ['a', 'b', 'c', 'd', 'e'],
        evalCompleted: ['a', 'b'],
        evalCurrent: 'prompt-injection',
        evalTotal: 5,
        updatedAt: '2026-07-28T10:05:00.000Z',
      },
    };
    await notifier.processSnapshot({ entries: [], current });

    expect(transport.posts).toHaveLength(2);
    expect(transport.posts[1].content).toContain('Stage 2 — Security evals');
    expect(transport.posts[1].content).toContain('prompt-injection');
    expect(transport.posts[1].content).toContain('2/5');
  });

  it('lets a resolver failure surface instead of silently skipping the entry', async () => {
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport: createRecordingTransport(),
      resolver: {
        async resolveById() {
          throw new Error('resolve-by-id failed: 401 Unauthorized');
        },
      },
    });

    await notifier.processSnapshot(snapshotOf(entry({ status: 'benchmarking' })));

    await expect(notifier.processSnapshot(snapshotOf())).rejects.toThrow('401 Unauthorized');
  });
});
