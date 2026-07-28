#!/usr/bin/env tsx
/**
 * Buzz bridge (outbound): watches the benchmarker queue and posts one Buzz
 * message per queue-entry status transition, so the queue can be followed from
 * chat instead of the dashboard.
 *
 * Runs alongside the queue API on the i9 and adds nothing to it — the queue
 * core is untouched, this only consumes its existing read surface.
 *
 * `GET /api/v1/queue/events` is a 5-second full-state re-poll, NOT a change
 * feed (`setInterval(sendState, 5000)`, queue-server.ts). Forwarding it
 * verbatim would publish 17,280 messages/day, so every payload is diffed
 * against durable last-seen state and only actual changes are published.
 *
 * Usage:
 *   BUZZ_BRIDGE_CHANNEL=<uuid> tsx src/scripts/buzz-bridge.ts
 *
 * Env:
 *   BUZZ_BRIDGE_CHANNEL    (required) channel UUID to post into
 *   BENCHMARKER_URL        base URL of the queue API (default below)
 *   BUZZ_BRIDGE_API_TOKEN  bearer token, when the API has auth enabled
 *   BUZZ_BRIDGE_STATE_DB   sqlite path for last-seen state
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { PIPELINE_STAGE_LABELS, type PipelineStage } from '../types/pipeline-progress.js';
import {
  BuzzNotifier,
  SqliteTransitionStore,
  type EntryResolver,
  type MessageTransport,
  type NotifiableEntry,
} from '../services/buzz-notifier.js';

const logger = createLogger();

/**
 * Loopback, on the port the i9 daemon actually runs.
 *
 * `3456` is the deployed value (verified live: `/healthz` answers
 * `{"status":"healthy","elasticsearch":"serverless"}`). It is NOT the code
 * default — `startQueueServer` falls back to `3200` — and it is emphatically
 * not `3100`, which is patryks-treadmill, a different live service that would
 * answer happily and be parsed as queue state.
 *
 * Loopback rather than the tailnet address because the API binds `127.0.0.1`
 * by default (fix/queue-api-loopback-bind) and no deploy script sets `HOST`.
 * Correct under both bind modes; override via `BENCHMARKER_URL` for remote
 * testing while the deployed build still binds `0.0.0.0`.
 */
export const DEFAULT_BENCHMARKER_URL = 'http://127.0.0.1:3456';

/**
 * Three missed 5s re-polls.
 *
 * The stream re-polls unconditionally, so silence is always a fault — but an
 * idle queue and a dead stream look identical from outside (no messages), and
 * "no messages" is this bridge's success signal. Without this the two are
 * indistinguishable.
 */
export const LIVENESS_TIMEOUT_MS = 15_000;

export function isStreamStale(lastPayloadAt: number, now: number): boolean {
  return now - lastPayloadAt > LIVENESS_TIMEOUT_MS;
}

function buildAuthHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fails fast when the configured base URL is not the benchmarker.
 *
 * A wrong port does not necessarily refuse the connection — it may be another
 * healthy service — so reachability alone proves nothing. The `elasticsearch`
 * key is the discriminator (`queue-server.ts` `/healthz`).
 */
export async function assertBenchmarkerIdentity(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${baseUrl}/healthz`;

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    throw new Error(
      `Health probe could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Health probe returned ${response.status} from ${url}`);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('elasticsearch' in body)) {
    throw new Error(
      `${url} answered 200 without an "elasticsearch" key — that is almost certainly a ` +
        `different service on this port, not the benchmarker. Refusing to parse its ` +
        `responses as queue state.`,
    );
  }
}

/**
 * Accumulates stream chunks and emits one string per complete SSE `data`
 * frame. Stateful because chunk boundaries are arbitrary: a single frame can
 * arrive split across several reads.
 */
export function createSseFrameParser(): (chunk: string) => string[] {
  let buffer = '';

  return (chunk: string): string[] => {
    buffer += chunk;
    const frames: string[] = [];

    for (
      let boundary = buffer.indexOf('\n\n');
      boundary !== -1;
      boundary = buffer.indexOf('\n\n')
    ) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      // Comment keepalives (`: ...`) and non-data fields (`event:`, `id:`)
      // carry no payload; only `data:` lines do.
      const data = rawFrame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).replace(/^ /, ''))
        .join('\n');

      if (data) frames.push(data);
    }

    return frames;
  };
}

/** Derived from the labels record so an upstream stage addition is accepted, not rejected. */
const PIPELINE_STAGES = Object.keys(PIPELINE_STAGE_LABELS) as [PipelineStage, ...PipelineStage[]];

const pipelineProgressSchema = z.object({
  stage: z.enum(PIPELINE_STAGES),
  detail: z.string(),
  evalSuites: z.array(z.string()).optional(),
  evalCompleted: z.array(z.string()).optional(),
  evalCurrent: z.string().nullish(),
  evalTotal: z.number().optional(),
  step: z.number().optional(),
  stepTotal: z.number().optional(),
  updatedAt: z.string(),
});

/**
 * The fields the notifier reads. Unknown keys are stripped rather than
 * rejected, which is what lets one schema cover both the SSE payload (full
 * `QueueEntry`) and `GET /api/v1/evaluate/:id` (a subset with no `leaseToken`,
 * `priority`, or `metadata`).
 */
const notifiableEntrySchema = z.object({
  id: z.string(),
  modelId: z.string(),
  status: z.enum(['pending', 'deploying', 'benchmarking', 'completed', 'failed', 'cancelled']),
  errorMessage: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  // Progress is presentational; a malformed or unrecognised shape must not
  // throw out the whole snapshot and stall transition detection with it.
  progress: pipelineProgressSchema.optional().catch(undefined),
});

export const queueSnapshotSchema = z.object({
  entries: z.array(notifiableEntrySchema),
  current: notifiableEntrySchema.nullish().transform((value) => value ?? null),
});

/**
 * Resolves one entry by id via `GET /api/v1/evaluate/:id`, which is a direct
 * document GET (`esClient.get`) — no `size`, no `sort` — so it reaches entries
 * that the 100-doc, priority-desc queue page has truncated away.
 */
export class HttpEntryResolver implements EntryResolver {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolveById(entryId: string): Promise<NotifiableEntry | null> {
    const url = `${this.baseUrl}/api/v1/evaluate/${encodeURIComponent(entryId)}`;
    const response = await this.fetchImpl(url, { headers: buildAuthHeaders(this.token) });

    if (response.status === 404) return null;

    // Never swallow an auth failure: this route is the only way an entry that
    // fell off the queue page gets its terminal message, so a silent skip
    // leaves the thread open forever with no signal that anything broke.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Resolve-by-id was rejected with ${response.status} for entry ${entryId}. The API has ` +
          `auth enabled; set BUZZ_BRIDGE_API_TOKEN or threads will never close.`,
      );
    }

    if (!response.ok) {
      throw new Error(`Resolve-by-id returned ${response.status} for entry ${entryId}`);
    }

    return notifiableEntrySchema.parse(await response.json());
  }
}

/** Runs a `buzz` subcommand, feeding `content` on stdin, and returns stdout. */
export type CliRunner = (argv: string[], stdin: string) => Promise<string>;

const buzzSendResultSchema = z.object({
  accepted: z.boolean(),
  event_id: z.string(),
  message: z.string().optional().default(''),
});

function runBuzzCli(argv: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('buzz', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`buzz ${argv[0]} ${argv[1]} exited ${code}: ${stderr.trim()}`));
    });

    child.stdin.end(stdin);
  });
}

/** Publishes via the `buzz` CLI. Injected, so the notifier core stays testable without a relay. */
export class BuzzCliTransport implements MessageTransport {
  constructor(
    private readonly channelId: string,
    private readonly run: CliRunner = runBuzzCli,
  ) {}

  postRoot(content: string): Promise<string> {
    return this.send(content, []);
  }

  postReply(rootEventId: string, content: string): Promise<string> {
    return this.send(content, ['--reply-to', rootEventId]);
  }

  private async send(content: string, extraArgs: string[]): Promise<string> {
    // `--content -` reads stdin: passing content as a flag value mangles the
    // newlines in multi-line transition messages.
    const argv = ['messages', 'send', '--channel', this.channelId, '--content', '-', ...extraArgs];
    const result = buzzSendResultSchema.parse(JSON.parse(await this.run(argv, content)));

    if (!result.accepted) {
      throw new Error(`Buzz relay rejected the message: ${result.message || '(no reason given)'}`);
    }

    return result.event_id;
  }
}

interface BridgeConfig {
  baseUrl: string;
  channelId: string;
  token: string | undefined;
  stateDbPath: string;
}

function readConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const channelId = env.BUZZ_BRIDGE_CHANNEL;
  if (!channelId) {
    throw new Error('BUZZ_BRIDGE_CHANNEL is required (channel UUID to post transitions into)');
  }

  return {
    baseUrl: env.BENCHMARKER_URL ?? DEFAULT_BENCHMARKER_URL,
    channelId,
    token: env.BUZZ_BRIDGE_API_TOKEN,
    stateDbPath: env.BUZZ_BRIDGE_STATE_DB ?? '.buzz-bridge-state.db',
  };
}

/**
 * Consumes the SSE stream until it ends, feeding each payload to the notifier.
 * Returns on stream end so the caller can reconnect.
 */
async function consumeStream(
  config: BridgeConfig,
  notifier: BuzzNotifier,
  markAlive: () => void,
): Promise<void> {
  const url = `${config.baseUrl}/api/v1/queue/events`;
  const response = await fetch(url, { headers: buildAuthHeaders(config.token) });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Queue event stream was rejected with ${response.status}. The API has auth enabled; set ` +
        `BUZZ_BRIDGE_API_TOKEN. Without it this bridge goes silent, which is indistinguishable ` +
        `from an idle queue.`,
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(`Queue event stream returned ${response.status} from ${url}`);
  }

  const feed = createSseFrameParser();
  const decoder = new TextDecoder();

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    for (const frame of feed(decoder.decode(chunk, { stream: true }))) {
      markAlive();

      const parsed = queueSnapshotSchema.safeParse(JSON.parse(frame));
      if (!parsed.success) {
        logger.error('Discarding an unparseable queue snapshot', {
          error: parsed.error.message,
        });
        continue;
      }

      await notifier.processSnapshot(parsed.data);
    }
  }
}

async function main(): Promise<void> {
  const config = readConfig(process.env);

  // Before anything else: prove this is the benchmarker and not another
  // service on the same port. Wrong-service data is silent and corrupting.
  await assertBenchmarkerIdentity(config.baseUrl);
  logger.info('Benchmarker identity confirmed', { baseUrl: config.baseUrl });

  const store = new SqliteTransitionStore(config.stateDbPath);
  const notifier = new BuzzNotifier({
    store,
    transport: new BuzzCliTransport(config.channelId),
    resolver: new HttpEntryResolver(config.baseUrl, config.token),
  });

  let lastPayloadAt = Date.now();
  const markAlive = () => (lastPayloadAt = Date.now());
  const liveness = setInterval(() => {
    if (isStreamStale(lastPayloadAt, Date.now())) {
      logger.error('No queue snapshot in three re-poll intervals — the stream is not healthy', {
        silentForMs: Date.now() - lastPayloadAt,
      });
    }
  }, LIVENESS_TIMEOUT_MS);

  const shutdown = () => {
    clearInterval(liveness);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Watching queue transitions', { channel: config.channelId });

  // The server closes the stream on its own schedule; reconnect rather than
  // exit, and let last-seen state make the reconnect a no-op.
  for (;;) {
    try {
      await consumeStream(config, notifier, markAlive);
      logger.warn('Queue event stream ended; reconnecting');
    } catch (err) {
      logger.error('Queue event stream failed; reconnecting', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.error('Buzz bridge failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  });
}
