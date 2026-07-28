/**
 * The truncation-recovery path, driven through the real `QueueService`.
 *
 * `getQueue()` is `match_all` / `size: 100` / `[priority desc, requested_at asc]`,
 * so an entry can fall off the page while it is still in flight. The notifier
 * must still close its thread. Asserting that from a hand-written "entry is
 * missing" snapshot would only restate the assumption, so this seeds a corpus
 * and lets the production query do the truncating.
 */
import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Client } from '@elastic/elasticsearch';
import { QueueService } from '../../src/services/queue-service.js';
import { createQueueServer } from '../../src/api/queue-server.js';
import type { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import { HttpEntryResolver } from '../../src/scripts/buzz-bridge.js';
import {
  BuzzNotifier,
  SqliteTransitionStore,
  type EntryResolver,
  type MessageTransport,
} from '../../src/services/buzz-notifier.js';

const DISCOVERY_ID = 'discovery-entry-under-test';

interface EsDoc {
  _id: string;
  _source: Record<string, unknown>;
}

function doc(id: string, source: Record<string, unknown>): EsDoc {
  return {
    _id: id,
    _source: {
      model_id: `org/model-${id}`,
      source: 'user',
      priority: 100,
      status: 'completed',
      requested_at: '2026-07-01T00:00:00.000Z',
      started_at: null,
      completed_at: null,
      error_message: null,
      requested_by: 'cli',
      ...source,
    },
  };
}

/**
 * Honours the `query`, `sort` and `size` the caller actually sends rather than
 * returning a canned page — otherwise the test could not detect a wrong model
 * of the ordering.
 */
function createFakeEs(docs: EsDoc[]): Client {
  const matches = (source: Record<string, unknown>, clause: Record<string, never>): boolean => {
    const [field, value] = Object.entries(clause.term as Record<string, unknown>)[0];
    return source[field] === value;
  };

  return {
    async search(req: Record<string, never>) {
      const query = (req.query ?? {}) as Record<string, never>;
      const bool = (query.bool ?? {}) as Record<string, never>;
      const must = (bool.must ?? []) as Array<Record<string, never>>;
      const should = (bool.should ?? []) as Array<Record<string, never>>;

      let hits = docs.filter((d) => must.every((clause) => matches(d._source, clause)));
      if (should.length > 0) {
        hits = hits.filter((d) => should.some((clause) => matches(d._source, clause)));
      }

      // Applied last-key-first; Array.prototype.sort is stable, so this yields
      // the same precedence as ES's multi-field sort.
      const sortSpec = (req.sort ?? []) as Array<Record<string, { order: 'asc' | 'desc' }>>;
      for (const spec of [...sortSpec].reverse()) {
        const [field, { order }] = Object.entries(spec)[0];
        hits.sort((a, b) => {
          const left = a._source[field] as string | number;
          const right = b._source[field] as string | number;
          const cmp = left < right ? -1 : left > right ? 1 : 0;
          return order === 'desc' ? -cmp : cmp;
        });
      }

      return { hits: { hits: hits.slice(0, (req.size as unknown as number) ?? 10) } };
    },

    async get({ id }: { id: string }) {
      const found = docs.find((d) => d._id === id);
      if (!found) {
        const err = new Error('document_missing_exception') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return { found: true, _id: found._id, _source: found._source };
    },
  } as unknown as Client;
}

function createRecordingTransport(): MessageTransport & { posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    async postRoot(content) {
      posts.push(content);
      return 'root-1';
    },
    async postReply(_rootEventId, content) {
      posts.push(content);
      return `reply-${posts.length}`;
    },
  };
}

describe('truncation recovery', () => {
  it('closes the thread for an entry the 100-doc page never shows', async () => {
    // 100 completed `user` entries at priority 100 — the shape the live queue
    // is already in — plus the priority-10 discovery entry we drive.
    const docs: EsDoc[] = [
      ...Array.from({ length: 100 }, (_, i) =>
        doc(`filler-${i}`, { requested_at: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
      ),
      doc(DISCOVERY_ID, {
        source: 'discovery',
        priority: 10,
        status: 'benchmarking',
        requested_at: '2026-07-28T12:00:00.000Z',
      }),
    ];

    const service = new QueueService(createFakeEs(docs));

    // Premise, verified rather than assumed: the production query really does
    // drop this entry, and really does still resolve it by id.
    const page = await service.getQueue();
    expect(page).toHaveLength(100);
    expect(page.some((e) => e.id === DISCOVERY_ID)).toBe(false);
    expect(await service.getById(DISCOVERY_ID)).toMatchObject({ id: DISCOVERY_ID });

    const transport = createRecordingTransport();
    const resolver: EntryResolver = {
      resolveById: (id) => service.getById(id),
    };
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
      resolver,
    });

    // While benchmarking, `getCurrent()` still carries it — that overlay is how
    // the thread gets opened at all for an already-truncated entry.
    await notifier.processSnapshot({
      entries: await service.getQueue(),
      current: await service.getCurrent(),
    });
    expect(transport.posts).toHaveLength(1);

    // Terminal. `getCurrent()` matches only deploying/benchmarking, so it drops
    // the entry at exactly the transition that closes the thread, and the page
    // never had it. Resolve-by-id is the only thing left.
    docs[docs.length - 1]._source.status = 'completed';

    await notifier.processSnapshot({
      entries: await service.getQueue(),
      current: await service.getCurrent(),
    });

    expect(await service.getCurrent()).toBeNull();
    expect(transport.posts).toHaveLength(2);
    expect(transport.posts[1]).toContain('completed');
  });

  it('does not post again once the truncated entry has terminated', async () => {
    const docs: EsDoc[] = [
      ...Array.from({ length: 100 }, (_, i) => doc(`filler-${i}`)),
      doc(DISCOVERY_ID, { source: 'discovery', priority: 10, status: 'completed' }),
    ];
    const service = new QueueService(createFakeEs(docs));
    const transport = createRecordingTransport();
    const notifier = new BuzzNotifier({
      store: new SqliteTransitionStore(':memory:'),
      transport,
      resolver: { resolveById: (id) => service.getById(id) },
    });

    const snapshot = { entries: await service.getQueue(), current: await service.getCurrent() };

    // Cold start against a queue that is nothing but history must be silent:
    // none of these 101 entries has a transition left to narrate.
    await notifier.processSnapshot(snapshot);
    expect(transport.posts).toEqual([]);

    // And idle re-polls stay silent — a terminal entry is not tracked as
    // non-terminal, so it is never resolved or posted again either.
    await notifier.processSnapshot(snapshot);
    await notifier.processSnapshot(snapshot);

    expect(transport.posts).toEqual([]);
  });
});

/**
 * The same recovery path, but with the HTTP hop left in.
 *
 * The tests above drive `QueueService.getById()` directly, and the route is
 * covered separately in `queue-server.test.ts` — so the one seam nothing
 * exercised was `HttpEntryResolver` talking to the real route. For a truncated
 * entry that route is the only way `completed` is ever observed (`getCurrent()`
 * matches only deploying/benchmarking), so it is the wrong place to rely on two
 * separately-covered halves.
 */
describe('resolve-by-id over HTTP', () => {
  async function mount(docs: EsDoc[], opts: { requireAuth?: boolean; token?: string } = {}) {
    const esClient = createFakeEs(docs);
    const service = new QueueService(esClient);
    const app = createQueueServer({
      esClient,
      queueService: service,
      resultsStore: {} as unknown as ElasticsearchResultsStore,
      requireAuth: opts.requireAuth ?? false,
    });

    const server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    return {
      service,
      resolver: new HttpEntryResolver(`http://127.0.0.1:${port}`, opts.token),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function truncatedFixture(): EsDoc[] {
    return [
      ...Array.from({ length: 100 }, (_, i) =>
        doc(`filler-${i}`, { requested_at: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
      ),
      doc(DISCOVERY_ID, {
        source: 'discovery',
        priority: 10,
        status: 'benchmarking',
        requested_at: '2026-07-28T12:00:00.000Z',
      }),
    ];
  }

  it('closes a truncated entry through the real route', async () => {
    const docs = truncatedFixture();
    const harness = await mount(docs);

    try {
      expect((await harness.service.getQueue()).some((e) => e.id === DISCOVERY_ID)).toBe(false);

      const transport = createRecordingTransport();
      const notifier = new BuzzNotifier({
        store: new SqliteTransitionStore(':memory:'),
        transport,
        resolver: harness.resolver,
      });

      await notifier.processSnapshot({
        entries: await harness.service.getQueue(),
        current: await harness.service.getCurrent(),
      });
      expect(transport.posts).toHaveLength(1);

      docs[docs.length - 1]._source.status = 'completed';

      await notifier.processSnapshot({
        entries: await harness.service.getQueue(),
        current: await harness.service.getCurrent(),
      });

      expect(transport.posts).toHaveLength(2);
      expect(transport.posts[1]).toContain('completed');
    } finally {
      await harness.close();
    }
  });

  it('returns null over HTTP only for an id the route itself reports missing', async () => {
    const harness = await mount(truncatedFixture());
    try {
      // Resolve a present id first. Without this the null below proves nothing:
      // a wrong path 404s exactly like an unknown id, so the assertion would
      // still pass against a route that does not exist.
      expect(await harness.resolver.resolveById(DISCOVERY_ID)).toMatchObject({
        id: DISCOVERY_ID,
        status: 'benchmarking',
      });

      expect(await harness.resolver.resolveById('no-such-entry')).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('throws loudly on a 401 rather than silently leaving the thread open', async () => {
    // Auth on, no token configured on the bridge. Silence here would be
    // indistinguishable from an idle queue, so this must surface.
    const harness = await mount(truncatedFixture(), { requireAuth: true });
    try {
      await expect(harness.resolver.resolveById(DISCOVERY_ID)).rejects.toThrow(/401/);
    } finally {
      await harness.close();
    }
  });
});
