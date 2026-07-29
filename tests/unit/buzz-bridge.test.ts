import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BENCHMARKER_URL,
  LIVENESS_TIMEOUT_MS,
  assertBenchmarkerIdentity,
  createSseFrameParser,
  queueSnapshotSchema,
  HttpEntryResolver,
  BuzzCliTransport,
  isStreamStale,
} from '../../src/scripts/buzz-bridge.js';

/** Minimal Response stand-in; only what the code under test reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

describe('buzz-bridge', () => {
  describe('defaults', () => {
    it('defaults to loopback on the port the i9 daemon actually runs', () => {
      // 3456 is the deployed value; 3200 is only the code default and 3100 is
      // patryks-treadmill, a different live service.
      expect(DEFAULT_BENCHMARKER_URL).toBe('http://127.0.0.1:3456');
    });

    it('treats three missed 5s re-polls as a stale stream', () => {
      expect(LIVENESS_TIMEOUT_MS).toBe(15_000);
      expect(isStreamStale(1_000, 1_000 + LIVENESS_TIMEOUT_MS - 1)).toBe(false);
      expect(isStreamStale(1_000, 1_000 + LIVENESS_TIMEOUT_MS + 1)).toBe(true);
    });
  });

  describe('assertBenchmarkerIdentity', () => {
    it('accepts a healthz body carrying the elasticsearch discriminator', async () => {
      await expect(
        assertBenchmarkerIdentity(DEFAULT_BENCHMARKER_URL, async () =>
          jsonResponse(200, { status: 'healthy', elasticsearch: 'serverless' }),
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects a 200 from a different service squatting the port', async () => {
      // e.g. patryks-treadmill on :3100 — reachable, healthy, wrong service.
      await expect(
        assertBenchmarkerIdentity('http://127.0.0.1:3100', async () =>
          jsonResponse(200, { status: 'ok', service: 'treadmill' }),
        ),
      ).rejects.toThrow(/elasticsearch/);
    });

    it('rejects an unhealthy status code', async () => {
      await expect(
        assertBenchmarkerIdentity(DEFAULT_BENCHMARKER_URL, async () =>
          jsonResponse(503, { status: 'unhealthy', elasticsearch: 'unreachable' }),
        ),
      ).rejects.toThrow(/503/);
    });
  });

  describe('createSseFrameParser', () => {
    it('reassembles a data frame split across chunks', () => {
      const feed = createSseFrameParser();
      expect(feed('data: {"entries":[],')).toEqual([]);
      expect(feed('"current":null}\n\n')).toEqual(['{"entries":[],"current":null}']);
    });

    it('returns both frames when two arrive in one chunk', () => {
      const feed = createSseFrameParser();
      expect(feed('data: one\n\ndata: two\n\n')).toEqual(['one', 'two']);
    });

    it('ignores comment keepalives and non-data fields', () => {
      const feed = createSseFrameParser();
      expect(feed(': keepalive\n\n')).toEqual([]);
      expect(feed('event: ping\nid: 7\n\n')).toEqual([]);
    });
  });

  describe('queueSnapshotSchema', () => {
    it('parses the live SSE payload shape', () => {
      const parsed = queueSnapshotSchema.parse({
        entries: [
          {
            id: '8z7xSJ8B0V_wgDgp4hQ5',
            modelId: 'mistralai/Devstral-Small-2-24B-Instruct-2512',
            source: 'user',
            priority: 100,
            status: 'failed',
            requestedAt: '2026-07-09T22:13:58.995Z',
            startedAt: '2026-07-09T22:15:28.372Z',
            completedAt: '2026-07-09T22:24:06.134Z',
            errorMessage: 'Stage 2 Kibana CI eval failed',
            requestedBy: 'cli',
            leaseToken: null,
            heartbeatAt: '2026-07-09T22:23:58.136Z',
          },
        ],
        current: null,
      });

      expect(parsed.entries[0].status).toBe('failed');
      expect(parsed.entries[0].errorMessage).toBe('Stage 2 Kibana CI eval failed');
    });

    it('carries progress through on the current entry', () => {
      const parsed = queueSnapshotSchema.parse({
        entries: [],
        current: {
          id: 'x1',
          modelId: 'org/model',
          status: 'benchmarking',
          errorMessage: null,
          progress: {
            stage: 'stage2_evals',
            detail: 'Running prompt-injection',
            evalCompleted: ['a', 'b'],
            evalTotal: 5,
            updatedAt: '2026-07-28T10:05:00.000Z',
          },
        },
      });

      expect(parsed.current?.progress?.evalTotal).toBe(5);
    });

    it('rejects a payload whose entries are not queue entries', () => {
      expect(() => queueSnapshotSchema.parse({ entries: [{ nope: true }], current: null })).toThrow();
    });
  });

  describe('HttpEntryResolver', () => {
    const resolverFor = (impl: typeof fetch) =>
      new HttpEntryResolver(DEFAULT_BENCHMARKER_URL, undefined, impl);

    it('parses the /api/v1/evaluate/:id subset shape', async () => {
      // Note: no leaseToken, priority, or metadata on this route's response.
      const resolved = await resolverFor(async () =>
        jsonResponse(200, {
          id: 'x1',
          modelId: 'org/model',
          status: 'completed',
          source: 'discovery',
          requestedAt: '2026-07-28T10:00:00.000Z',
          startedAt: '2026-07-28T10:01:00.000Z',
          completedAt: '2026-07-28T10:30:00.000Z',
          errorMessage: null,
          requestedBy: 'discovery',
        }),
      ).resolveById('x1');

      expect(resolved).toMatchObject({ id: 'x1', status: 'completed' });
    });

    it('returns null when the entry genuinely does not exist', async () => {
      const resolved = await resolverFor(async () =>
        jsonResponse(404, { error: 'Evaluation not found' }),
      ).resolveById('gone');

      expect(resolved).toBeNull();
    });

    it('throws loudly on 401 rather than silently skipping the entry', async () => {
      await expect(
        resolverFor(async () => jsonResponse(401, { error: 'Unauthorized' })).resolveById('x1'),
      ).rejects.toThrow(/401/);
    });

    it('throws loudly on 403 rather than silently skipping the entry', async () => {
      await expect(
        resolverFor(async () => jsonResponse(403, { error: 'Forbidden' })).resolveById('x1'),
      ).rejects.toThrow(/403/);
    });

    it('sends a bearer token when one is configured', async () => {
      const seen: Array<Record<string, string>> = [];
      const resolver = new HttpEntryResolver(
        DEFAULT_BENCHMARKER_URL,
        'secret-token',
        async (_url, init) => {
          seen.push((init?.headers ?? {}) as Record<string, string>);
          return jsonResponse(404, { error: 'Evaluation not found' });
        },
      );

      await resolver.resolveById('x1');

      expect(seen[0].Authorization).toBe('Bearer secret-token');
    });
  });

  describe('BuzzCliTransport', () => {
    it('opens a thread root and returns the new event id', async () => {
      const calls: Array<{ argv: string[]; stdin: string }> = [];
      const transport = new BuzzCliTransport('chan-uuid', async (argv, stdin) => {
        calls.push({ argv, stdin });
        return JSON.stringify({ accepted: true, event_id: 'root-1', message: '' });
      });

      const id = await transport.postRoot('hello');

      expect(id).toBe('root-1');
      expect(calls[0].argv).toEqual([
        'messages',
        'send',
        '--channel',
        'chan-uuid',
        '--content',
        '-',
      ]);
      expect(calls[0].stdin).toBe('hello');
    });

    it('threads a reply under the root event', async () => {
      const calls: string[][] = [];
      const transport = new BuzzCliTransport('chan-uuid', async (argv) => {
        calls.push(argv);
        return JSON.stringify({ accepted: true, event_id: 'reply-1', message: '' });
      });

      const id = await transport.postReply('root-1', 'update');

      expect(id).toBe('reply-1');
      expect(calls[0]).toContain('--reply-to');
      expect(calls[0][calls[0].indexOf('--reply-to') + 1]).toBe('root-1');
    });

    it('fails loudly when the relay rejects the message', async () => {
      const transport = new BuzzCliTransport('chan-uuid', async () =>
        JSON.stringify({ accepted: false, event_id: '', message: 'relay refused' }),
      );

      await expect(transport.postRoot('hello')).rejects.toThrow(/relay refused/);
    });
  });
});
