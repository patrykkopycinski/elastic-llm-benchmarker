import { spawn, execFile, type ChildProcess } from 'child_process';
import { promises as dnsPromises } from 'dns';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { createLogger } from '../utils/logger.js';
import type { TunnelConfig, TunnelProvider } from '../types/config.js';

const NGROK_LOCAL_API = 'http://127.0.0.1:4040';
const execFileAsync = promisify(execFile);

// ─── cloudflared tunnel state persistence ───────────────────────────────────
//
// A cloudflared quick tunnel mints a NEW random *.trycloudflare.com hostname on
// every process start, and the old hostname stops resolving the instant the
// owning process exits. If a daemon restart (crash, SIGKILL, redeploy) spawns a
// fresh tunnel, every in-flight Buildkite eval build still holds the OLD injected
// URL and fails with `ENOTFOUND` from the remote CI agent (observed: Ornith
// builds #188–191). To avoid that, we persist the surviving tunnel's pid + URL to
// a stable file and REUSE it across daemon restarts instead of rotating it.

interface CloudflaredState {
  pid: number;
  url: string;
  localPort: number;
  establishedAt: string;
}

function cloudflaredStateFile(localPort: number): string {
  const dir =
    process.env['BENCHMARKER_TUNNEL_STATE_DIR'] ??
    path.join(os.homedir(), '.elastic-llm-benchmarker');
  return path.join(dir, `cloudflared-${localPort}.json`);
}

async function readCloudflaredState(localPort: number): Promise<CloudflaredState | null> {
  try {
    const raw = await fs.readFile(cloudflaredStateFile(localPort), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CloudflaredState>;
    if (
      parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.url === 'string' &&
      parsed.localPort === localPort &&
      typeof parsed.establishedAt === 'string'
    ) {
      return parsed as CloudflaredState;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCloudflaredState(state: CloudflaredState): Promise<void> {
  const file = cloudflaredStateFile(state.localPort);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state), 'utf8');
  } catch {
    // best-effort — a failed write only means the next restart can't reuse the tunnel
  }
}

async function clearCloudflaredState(localPort: number): Promise<void> {
  try {
    await fs.rm(cloudflaredStateFile(localPort), { force: true });
  } catch {
    // ignore
  }
}

/** True when `pid` is a live process. ESRCH ⇒ dead; EPERM ⇒ alive but owned by another user. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kill zombie `ngrok http <port>` processes left by a prior daemon (API on :4040 may be dead). */
async function killOrphanNgrokForPort(localPort: number): Promise<void> {
  const pattern = `ngrok http ${localPort}`;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    const pids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(
      pids.map(async (pid) => {
        try {
          await execFileAsync('kill', ['-TERM', pid]);
        } catch {
          // already exited
        }
      }),
    );
    if (pids.length > 0) {
      // A killed agent's ngrok cloud endpoint stays "online" for a few seconds after the
      // local process dies (heartbeat lag). Wait for that dereg to propagate before the
      // caller spawns a fresh agent on the same reserved domain, else it hits ERR_NGROK_334
      // ("endpoint already online") against the orphan we just killed.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } catch {
    // pgrep exit 1 = no matches
  }
}

/** Kill zombie `cloudflared tunnel --url http://127.0.0.1:<port>` processes from a prior daemon. */
async function killOrphanCloudflaredForPort(localPort: number): Promise<void> {
  const pattern = `cloudflared tunnel --url http://127.0.0.1:${localPort}`;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    const pids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(
      pids.map(async (pid) => {
        try {
          await execFileAsync('kill', ['-TERM', pid]);
        } catch {
          // already exited
        }
      }),
    );
  } catch {
    // pgrep exit 1 = no matches
  }
}

/**
 * Wait for a freshly-minted public hostname to become resolvable via
 * **authoritative** DNS (`dns.resolve4`), returning the boolean result.
 *
 * This exists to work around a macOS resolver trap: `getaddrinfo` (which
 * `fetch`/undici use via `dns.lookup`) negatively caches the NXDOMAIN from the
 * FIRST lookup of a not-yet-propagated hostname and keeps serving it for the
 * record's TTL — so a too-early `fetch` poisons the cache and every later
 * `fetch` from the same host fails with `ENOTFOUND` even after the tunnel is
 * live. `dns.resolve4` queries the DNS servers directly and bypasses that
 * cache, so we poll it (never `getaddrinfo`) until the record propagates before
 * handing the URL to any `fetch`-based consumer (the CI-eval guard) or to
 * Buildkite. Returns false if it never resolves within the window.
 */
async function waitForDnsPropagation(host: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const addrs = await dnsPromises.resolve4(host);
      if (addrs.length > 0) {
        return true;
      }
    } catch {
      // record not propagated to authoritative DNS yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

/**
 * Wait (up to 15s) for the local backend — the SSH port-forward to the GPU VM's
 * vLLM — to answer `/v1/models`, so early eval requests don't race an unready
 * upstream. Shared by all tunnel providers.
 */
async function waitForLocalBackend(localPort: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/v1/models`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) {
        return;
      }
    } catch {
      // wait for SSH forward / vLLM to become reachable
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface NgrokApiTunnel {
  name?: string;
  public_url?: string;
  config?: { addr?: string };
}

/** Fetch active tunnels from a running ngrok agent's local API. */
async function listNgrokApiTunnels(): Promise<NgrokApiTunnel[]> {
  try {
    const res = await fetch(`${NGROK_LOCAL_API}/api/tunnels`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { tunnels?: NgrokApiTunnel[] };
    return body.tunnels ?? [];
  } catch {
    return [];
  }
}

function tunnelMatchesLocalPort(tunnel: NgrokApiTunnel, localPort: number): boolean {
  const addr = tunnel.config?.addr ?? '';
  const portStr = String(localPort);
  return (
    addr === portStr ||
    addr === `http://localhost:${portStr}` ||
    addr === `http://127.0.0.1:${portStr}` ||
    addr === `https://localhost:${portStr}`
  );
}

function pickPublicTunnelUrl(tunnel: NgrokApiTunnel): string | null {
  const url = tunnel.public_url;
  if (url && isPublicTunnelUrl(url)) {
    return url;
  }
  return null;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Information about an established tunnel */
export interface TunnelInfo {
  /** The public URL of the tunnel */
  publicUrl: string;
  /** The tunnel provider used */
  provider: TunnelProvider;
  /** The local port being tunneled */
  localPort: number;
  /** Timestamp when the tunnel was established */
  establishedAt: string;
  /** Optional tunnel/session ID from the provider */
  tunnelId: string | null;
  /** Optional ngrok region */
  region: string | null;
}

/** Result of a tunnel operation */
export interface TunnelResult {
  /** Whether the tunnel was successfully established */
  success: boolean;
  /** Tunnel information, if successful */
  tunnel: TunnelInfo | null;
  /** Error message, if unsuccessful */
  error: string | null;
  /** Whether an existing tunnel was reused */
  reused: boolean;
}

/** Options for the TunnelService constructor */
export interface TunnelServiceOptions {
  /** Tunnel configuration from app config */
  config: TunnelConfig;
  /** Winston log level (default: 'info') */
  logLevel?: string;
}

/** Status of the tunnel service */
export interface TunnelStatus {
  /** Whether the tunnel service is enabled */
  enabled: boolean;
  /** Whether a tunnel is currently active */
  active: boolean;
  /** Current tunnel information, if active */
  tunnel: TunnelInfo | null;
  /** The configured provider */
  provider: TunnelProvider;
}

/** Interface for provider-specific tunnel implementations */
interface TunnelProvider_Impl {
  /** Check for an existing tunnel and return its URL if found */
  checkExisting(localPort: number): Promise<TunnelInfo | null>;
  /** Create a new tunnel */
  create(localPort: number): Promise<TunnelInfo>;
  /** Disconnect/close the tunnel */
  disconnect(): Promise<void>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error for tunnel operations */
export class TunnelError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

/** Error thrown when tunnel creation fails */
export class TunnelCreationError extends TunnelError {
  constructor(
    provider: string,
    public readonly attempts: number,
    cause?: Error,
  ) {
    super(
      `Failed to create ${provider} tunnel after ${attempts} attempt(s): ${cause?.message ?? 'unknown error'}`,
      provider,
      cause,
    );
    this.name = 'TunnelCreationError';
  }
}

/** Error thrown when tunnel provider is not available */
export class TunnelProviderNotAvailableError extends TunnelError {
  constructor(provider: string, reason: string) {
    super(`Tunnel provider '${provider}' is not available: ${reason}`, provider);
    this.name = 'TunnelProviderNotAvailableError';
  }
}

// ─── Ngrok helpers ────────────────────────────────────────────────────────────

/**
 * True when `url` is a routable public tunnel endpoint (not ngrok's local inspector on :4040).
 */
export function isPublicTunnelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      return false;
    }
    return (
      host.includes('ngrok') ||
      host.endsWith('.trycloudflare.com') ||
      host.endsWith('.dev') ||
      host.endsWith('.app')
    );
  } catch {
    return false;
  }
}

// ─── Ngrok Provider ───────────────────────────────────────────────────────────

/**
 * Ngrok tunnel provider implementation.
 *
 * Uses the ngrok **CLI** (`ngrok http <port>`) and the local agent API on :4040.
 * The npm `ngrok` package's `connect()` fails when the target port is already
 * bound (e.g. by our SSH port-forward to the GPU VM), so the CLI path is required.
 */
class NgrokProvider implements TunnelProvider_Impl {
  private readonly logger;
  private readonly authToken: string | undefined;
  private readonly region: string;
  private readonly domain: string | undefined;
  private cliProcess: ChildProcess | null = null;

  constructor(
    config: TunnelConfig,
    logLevel: string,
  ) {
    this.logger = createLogger(logLevel);
    this.authToken = config.ngrokAuthToken;
    this.region = config.ngrokRegion;
    this.domain = config.ngrokDomain;
  }

  private async findApiTunnel(localPort: number): Promise<TunnelInfo | null> {
    const tunnels = await listNgrokApiTunnels();
    for (const tunnel of tunnels) {
      if (!tunnelMatchesLocalPort(tunnel, localPort)) {
        continue;
      }
      const publicUrl = pickPublicTunnelUrl(tunnel);
      if (!publicUrl) {
        continue;
      }
      return {
        publicUrl,
        provider: 'ngrok',
        localPort,
        establishedAt: new Date().toISOString(),
        tunnelId: tunnel.name ?? null,
        region: this.region,
      };
    }
    return null;
  }

  async checkExisting(localPort: number): Promise<TunnelInfo | null> {
    const existing = await this.findApiTunnel(localPort);
    if (existing) {
      this.logger.info('Found existing ngrok tunnel via local API', {
        url: existing.publicUrl,
        localPort,
      });
    }
    return existing;
  }

  async create(localPort: number): Promise<TunnelInfo> {
    const reused = await this.findApiTunnel(localPort);
    if (reused) {
      return reused;
    }

    await this.disconnect();
    await killOrphanNgrokForPort(localPort);

    await waitForLocalBackend(localPort);

    const bin = process.env['NGROK_BIN'] ?? 'ngrok';
    const args = ['http', String(localPort), '--log=stdout', '--log-level=warn'];
    if (this.domain) {
      args.push('--domain', this.domain);
      // Endpoint pooling lets this agent bind the reserved domain even when another
      // agent still holds it: a prior daemon whose cloud endpoint lingers "online"
      // during ngrok's grace period (ERR_NGROK_334 on restart), or a second machine
      // sharing the account. ngrok load-balances across pooled agents; since every
      // agent forwards to the same GPU VM, requests resolve to the model under test
      // regardless of which leg serves them. Verified available on the free plan.
      args.push('--pooling-enabled');
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.authToken) {
      env['NGROK_AUTHTOKEN'] = this.authToken;
    }

    this.logger.info('Starting ngrok CLI tunnel', {
      localPort,
      region: this.region,
      domain: this.domain ?? 'auto-generated',
      bin,
    });

    // Capture stdout/stderr (not 'ignore') so an immediate ngrok exit — session-limit
    // (ERR_NGROK_108), auth failure, domain-in-use, etc. — surfaces its real reason
    // instead of being masked by a generic "failed to expose" timeout message. ngrok's
    // structured `--log=stdout` lines land here.
    this.cliProcess = spawn(bin, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let ngrokOutput = '';
    const captureOutput = (chunk: Buffer): void => {
      ngrokOutput += chunk.toString();
      // Bound the buffer — we only need the tail (where errors appear) for diagnosis.
      if (ngrokOutput.length > 8_000) {
        ngrokOutput = ngrokOutput.slice(-8_000);
      }
    };
    this.cliProcess.stdout?.on('data', captureOutput);
    this.cliProcess.stderr?.on('data', captureOutput);

    // Without an 'error' listener, a spawn failure (e.g. ENOENT when the ngrok binary
    // is missing or NGROK_BIN is misconfigured) is emitted as an uncaught exception that
    // crashes the whole daemon. Capture it and surface a clean error from create().
    let spawnError: Error | null = null;
    this.cliProcess.on('error', (err: Error) => {
      spawnError = err;
      this.logger.error('Ngrok CLI process failed to spawn', { bin, error: err.message });
    });

    const deadlineMs = 45_000;
    const started = Date.now();
    let exitedEarly = false;
    while (Date.now() - started < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (spawnError) {
        break;
      }
      const tunnel = await this.findApiTunnel(localPort);
      if (tunnel) {
        this.logger.info('Ngrok tunnel established via CLI', {
          url: tunnel.publicUrl,
          localPort,
        });
        return tunnel;
      }
      if (this.cliProcess.exitCode !== null) {
        exitedEarly = true;
        break;
      }
    }

    const exitCode = this.cliProcess?.exitCode ?? null;
    await this.disconnect();
    if (spawnError) {
      throw new Error(`ngrok CLI failed to start (${bin}): ${(spawnError as Error).message}`);
    }
    // Include the captured ngrok output so the real failure cause (e.g. ERR_NGROK_108
    // "your account is limited to 1 simultaneous ngrok agent session") is visible in
    // the daemon log and the Stage-2 abort reason, not swallowed.
    const detail = ngrokOutput.trim() ? ` — ngrok output: ${ngrokOutput.trim().slice(-1_000)}` : '';
    if (exitedEarly || exitCode !== null) {
      throw new Error(
        `ngrok CLI exited early (code ${exitCode ?? 'unknown'}) before exposing port ${localPort}${detail}`,
      );
    }
    throw new Error(`ngrok CLI failed to expose port ${localPort} within ${deadlineMs}ms${detail}`);
  }

  async disconnect(): Promise<void> {
    if (this.cliProcess && this.cliProcess.exitCode === null) {
      this.cliProcess.kill('SIGTERM');
    }
    this.cliProcess = null;

    const tunnels = await listNgrokApiTunnels();
    await Promise.all(
      tunnels.map(async (tunnel) => {
        if (!tunnel.name) {
          return;
        }
        try {
          await fetch(`${NGROK_LOCAL_API}/api/tunnels/${tunnel.name}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(2_000),
          });
        } catch {
          // best-effort cleanup
        }
      }),
    );

    this.logger.info('Ngrok tunnel disconnected');
  }
}

// ─── Cloudflared Provider ─────────────────────────────────────────────────────

/** Matches a Cloudflare quick-tunnel hostname in cloudflared's log output. */
const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Cloudflare quick-tunnel provider.
 *
 * Runs `cloudflared tunnel --url http://localhost:<port>` which allocates a
 * fresh, random `*.trycloudflare.com` hostname on every invocation. Because the
 * hostname is ephemeral and unreserved, it can never collide with a stale
 * cloud-side endpoint the way ngrok's single free-tier reserved domain does
 * (ERR_NGROK_334). No account, auth token, or domain reservation is required —
 * this is the robust choice for unattended autonomous runs.
 *
 * The public URL is parsed from cloudflared's own log output (stdout/stderr);
 * there is no local inspector API to poll.
 */
class CloudflaredProvider implements TunnelProvider_Impl {
  private readonly logger;
  private cliProcess: ChildProcess | null = null;
  /** Remembered so disconnect() can clear/kill the persisted tunnel without an arg. */
  private lastLocalPort: number | null = null;

  constructor(logLevel: string) {
    this.logger = createLogger(logLevel);
  }

  async checkExisting(localPort: number): Promise<TunnelInfo | null> {
    this.lastLocalPort = localPort;
    // A quick tunnel started by a PRIOR daemon survives a daemon restart (it's spawned
    // detached). Reuse it — same pid, same hostname — so any in-flight CI build's
    // injected URL keeps resolving instead of being orphaned by a fresh spawn.
    const state = await readCloudflaredState(localPort);
    if (!state) {
      return null;
    }
    if (!isPidAlive(state.pid)) {
      await clearCloudflaredState(localPort);
      return null;
    }
    let host: string;
    try {
      host = new URL(state.url).hostname;
    } catch {
      await clearCloudflaredState(localPort);
      return null;
    }
    // A rotated/dead tunnel stops resolving instantly; only a still-resolving hostname
    // is safe to hand back for reuse (authoritative DNS, never getaddrinfo).
    const resolvable = await waitForDnsPropagation(host, 6_000);
    if (!resolvable) {
      return null;
    }
    this.logger.info('Reusing surviving cloudflared quick tunnel', {
      url: state.url,
      localPort,
      pid: state.pid,
    });
    return {
      publicUrl: state.url,
      provider: 'cloudflared',
      localPort,
      establishedAt: state.establishedAt,
      tunnelId: String(state.pid),
      region: null,
    };
  }

  async create(localPort: number): Promise<TunnelInfo> {
    this.lastLocalPort = localPort;
    await this.disconnect();
    await killOrphanCloudflaredForPort(localPort);
    await waitForLocalBackend(localPort);

    const bin = process.env['CLOUDFLARED_BIN'] ?? 'cloudflared';
    // Use 127.0.0.1 (not `localhost`) so cloudflared reaches the IPv4 SSH port-forward
    // directly — on macOS `localhost` can resolve to ::1 (IPv6) first, which the
    // forward does not bind, silently 502-ing every proxied request.
    const args = ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'];

    this.logger.info('Starting cloudflared quick tunnel', { localPort, bin });

    // detached so the tunnel OUTLIVES a daemon crash/restart — the reuse path in
    // checkExisting() then reattaches to it instead of rotating the URL.
    this.cliProcess = spawn(bin, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let output = '';
    let resolvedUrl: string | null = null;
    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      if (!resolvedUrl) {
        const match = output.match(TRYCLOUDFLARE_URL_RE);
        if (match) {
          resolvedUrl = match[0];
        }
      }
      // Bound the buffer — we only need the tail (where errors appear) for diagnosis.
      if (output.length > 16_000) {
        output = output.slice(-16_000);
      }
    };
    this.cliProcess.stdout?.on('data', capture);
    this.cliProcess.stderr?.on('data', capture);

    // Without an 'error' listener, a spawn failure (e.g. ENOENT when cloudflared
    // is missing or CLOUDFLARED_BIN is misconfigured) crashes the whole daemon as
    // an uncaught exception. Capture it and surface a clean error from create().
    let spawnError: Error | null = null;
    this.cliProcess.on('error', (err: Error) => {
      spawnError = err;
      this.logger.error('cloudflared process failed to spawn', { bin, error: err.message });
    });

    const deadlineMs = 45_000;
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (spawnError) {
        break;
      }
      if (resolvedUrl) {
        // Block until the fresh hostname propagates via authoritative DNS, so no
        // early getaddrinfo poisons the OS negative cache and the URL is live for
        // Buildkite + the guard's fetch probes by the time we return it.
        const host = new URL(resolvedUrl).hostname;
        const propagated = await waitForDnsPropagation(host);
        if (!propagated) {
          this.logger.warn(
            'Cloudflared hostname did not resolve via authoritative DNS within window — returning anyway',
            { host, localPort },
          );
        }
        const establishedAt = new Date().toISOString();
        const pid = this.cliProcess.pid;
        if (pid !== undefined) {
          await writeCloudflaredState({ pid, url: resolvedUrl, localPort, establishedAt });
          // Let the daemon exit without waiting on the detached tunnel; the persisted
          // pid + URL let a restarted daemon reattach via checkExisting().
          this.cliProcess.unref();
        }
        this.logger.info('Cloudflared tunnel established', {
          url: resolvedUrl,
          localPort,
          pid,
          dnsPropagated: propagated,
        });
        return {
          publicUrl: resolvedUrl,
          provider: 'cloudflared',
          localPort,
          establishedAt,
          tunnelId: pid !== undefined ? String(pid) : null,
          region: null,
        };
      }
      if (this.cliProcess.exitCode !== null) {
        break;
      }
    }

    const exitCode = this.cliProcess?.exitCode ?? null;
    await this.disconnect();
    if (spawnError) {
      throw new Error(`cloudflared failed to start (${bin}): ${(spawnError as Error).message}`);
    }
    const detail = output.trim() ? ` — cloudflared output: ${output.trim().slice(-1_000)}` : '';
    if (exitCode !== null) {
      throw new Error(
        `cloudflared exited early (code ${exitCode}) before exposing port ${localPort}${detail}`,
      );
    }
    throw new Error(
      `cloudflared failed to expose port ${localPort} within ${deadlineMs}ms${detail}`,
    );
  }

  async disconnect(): Promise<void> {
    if (this.cliProcess && this.cliProcess.exitCode === null) {
      this.cliProcess.kill('SIGTERM');
    }
    this.cliProcess = null;
    // Across a daemon restart we no longer hold the child handle, so also terminate the
    // detached survivor by its persisted pid and drop the state file — otherwise a stale
    // entry would make the NEXT checkExisting() reuse a tunnel we intended to tear down.
    if (this.lastLocalPort !== null) {
      const state = await readCloudflaredState(this.lastLocalPort);
      if (state && isPidAlive(state.pid)) {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
      await clearCloudflaredState(this.lastLocalPort);
    }
    this.logger.info('Cloudflared tunnel disconnected');
  }
}

// ─── Cloudflared Named-Tunnel Provider ────────────────────────────────────────

/** Kill zombie `cloudflared tunnel ... run <name>` processes from a prior daemon. */
async function killOrphanNamedTunnel(tunnelName: string): Promise<void> {
  const pattern = `cloudflared tunnel .*run ${tunnelName}`;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    const pids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(
      pids.map(async (pid) => {
        try {
          await execFileAsync('kill', ['-TERM', pid]);
        } catch {
          // already exited
        }
      }),
    );
  } catch {
    // pgrep exit 1 = no matches
  }
}

/** True when a `cloudflared ... run <name>` process is currently alive. */
async function isNamedTunnelRunning(tunnelName: string): Promise<boolean> {
  const pattern = `cloudflared tunnel .*run ${tunnelName}`;
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Persistent, account-owned **named** Cloudflare tunnel provider.
 *
 * Unlike the quick-tunnel provider, the public hostname is STABLE and owned by
 * the operator's Cloudflare account (routed via DNS to a pre-created tunnel).
 * There is no per-run URL churn, no `*.trycloudflare.com` abuse-throttling, and
 * no ngrok reserved-domain collision (ERR_NGROK_334). The daemon supervises one
 * long-lived `cloudflared tunnel --config <path> run <name>` process and reuses
 * it across restarts — so an in-flight CI build's injected URL keeps resolving.
 *
 * One-time operator setup (outside the daemon):
 *   cloudflared tunnel login
 *   cloudflared tunnel create <name>
 *   cloudflared tunnel route dns <name> <hostname>
 *   # write ~/.cloudflared/<name>-config.yml with ingress rules → 127.0.0.1:<port>
 */
class CloudflaredNamedProvider implements TunnelProvider_Impl {
  private readonly logger;
  private readonly tunnelName: string;
  private readonly publicHostname: string;
  private readonly configPath: string;
  private cliProcess: ChildProcess | null = null;

  constructor(config: TunnelConfig, logLevel: string) {
    this.logger = createLogger(logLevel);
    if (!config.cloudflaredTunnelName) {
      throw new TunnelProviderNotAvailableError(
        'cloudflared_named',
        'tunnel.cloudflaredTunnelName is required for the named-tunnel provider',
      );
    }
    if (!config.publicHostname) {
      throw new TunnelProviderNotAvailableError(
        'cloudflared_named',
        'tunnel.publicHostname is required for the named-tunnel provider',
      );
    }
    if (!config.cloudflaredConfigPath) {
      throw new TunnelProviderNotAvailableError(
        'cloudflared_named',
        'tunnel.cloudflaredConfigPath is required for the named-tunnel provider',
      );
    }
    this.tunnelName = config.cloudflaredTunnelName;
    this.publicHostname = config.publicHostname;
    this.configPath = config.cloudflaredConfigPath;
  }

  private buildTunnelInfo(localPort: number, establishedAt: string): TunnelInfo {
    return {
      publicUrl: this.publicHostname,
      provider: 'cloudflared_named',
      localPort,
      establishedAt,
      tunnelId: this.tunnelName,
      region: null,
    };
  }

  async checkExisting(localPort: number): Promise<TunnelInfo | null> {
    // The hostname is stable; a supervising process left by a prior daemon (or by
    // the operator) keeps it live. Reuse it instead of spawning a duplicate — two
    // `run <name>` processes on the same tunnel are load-balanced by Cloudflare but
    // the second just adds churn. DNS is permanent (routed once), so we only check
    // that a process is alive.
    if (await isNamedTunnelRunning(this.tunnelName)) {
      this.logger.info('Reusing running named cloudflared tunnel', {
        tunnelName: this.tunnelName,
        publicUrl: this.publicHostname,
        localPort,
      });
      return this.buildTunnelInfo(localPort, new Date().toISOString());
    }
    return null;
  }

  async create(localPort: number): Promise<TunnelInfo> {
    // A pre-existing supervisor already serves the stable hostname — reuse it.
    const existing = await this.checkExisting(localPort);
    if (existing) {
      return existing;
    }

    await killOrphanNamedTunnel(this.tunnelName);
    await waitForLocalBackend(localPort);

    const bin = process.env['CLOUDFLARED_BIN'] ?? 'cloudflared';
    const args = [
      'tunnel',
      '--no-autoupdate',
      '--config',
      this.configPath,
      'run',
      this.tunnelName,
    ];

    this.logger.info('Starting named cloudflared tunnel', {
      tunnelName: this.tunnelName,
      publicUrl: this.publicHostname,
      localPort,
      configPath: this.configPath,
      bin,
    });

    // detached so the tunnel OUTLIVES a daemon crash/restart; checkExisting()
    // reattaches to it on the next boot instead of spawning a duplicate.
    this.cliProcess = spawn(bin, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let output = '';
    let registered = false;
    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      // cloudflared logs "Registered tunnel connection" (one per edge conn) once the
      // supervisor is live and serving the stable hostname.
      if (!registered && /Registered tunnel connection|Connection .* registered/i.test(output)) {
        registered = true;
      }
      if (output.length > 16_000) {
        output = output.slice(-16_000);
      }
    };
    this.cliProcess.stdout?.on('data', capture);
    this.cliProcess.stderr?.on('data', capture);

    let spawnError: Error | null = null;
    this.cliProcess.on('error', (err: Error) => {
      spawnError = err;
      this.logger.error('named cloudflared process failed to spawn', {
        bin,
        error: err.message,
      });
    });

    const deadlineMs = 45_000;
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (spawnError) {
        break;
      }
      if (registered) {
        const establishedAt = new Date().toISOString();
        const pid = this.cliProcess.pid;
        // Let the daemon exit without waiting on the detached supervisor.
        this.cliProcess.unref();
        this.logger.info('Named cloudflared tunnel established', {
          tunnelName: this.tunnelName,
          publicUrl: this.publicHostname,
          localPort,
          pid,
        });
        return this.buildTunnelInfo(localPort, establishedAt);
      }
      if (this.cliProcess.exitCode !== null) {
        break;
      }
    }

    const exitCode = this.cliProcess?.exitCode ?? null;
    await this.disconnect();
    if (spawnError) {
      throw new Error(
        `named cloudflared failed to start (${bin}): ${(spawnError as Error).message}`,
      );
    }
    const detail = output.trim() ? ` — cloudflared output: ${output.trim().slice(-1_000)}` : '';
    if (exitCode !== null) {
      throw new Error(
        `named cloudflared exited early (code ${exitCode}) for tunnel ${this.tunnelName}${detail}`,
      );
    }
    throw new Error(
      `named cloudflared did not register within ${deadlineMs}ms for tunnel ${this.tunnelName}${detail}`,
    );
  }

  async disconnect(): Promise<void> {
    if (this.cliProcess && this.cliProcess.exitCode === null) {
      this.cliProcess.kill('SIGTERM');
    }
    this.cliProcess = null;
    // The supervisor is detached; across a restart we no longer hold the handle, so
    // kill any survivor by name so a fresh create() starts clean.
    await killOrphanNamedTunnel(this.tunnelName);
    this.logger.info('Named cloudflared tunnel disconnected', { tunnelName: this.tunnelName });
  }
}

// ─── Placeholder Providers ────────────────────────────────────────────────────

/**
 * Placeholder for future GCP Cloud Run tunnel provider.
 * Will support native GCP Cloud Run deployments for production use.
 */
class CloudRunProvider implements TunnelProvider_Impl {
  async checkExisting(_localPort: number): Promise<TunnelInfo | null> {
    throw new TunnelProviderNotAvailableError(
      'cloudrun',
      'GCP Cloud Run provider is not yet implemented. Use ngrok for now.',
    );
  }

  async create(_localPort: number): Promise<TunnelInfo> {
    throw new TunnelProviderNotAvailableError(
      'cloudrun',
      'GCP Cloud Run provider is not yet implemented. Use ngrok for now.',
    );
  }

  async disconnect(): Promise<void> {
    // No-op for unimplemented provider
  }
}

/**
 * GCP HTTPS Load Balancer provider for Tier-2 Buildkite weekly evals.
 *
 * Unlike the ephemeral tunnel providers (ngrok/cloudflared), the GCP LB is a
 * static, always-on endpoint provisioned once by Terraform with a reserved IP.
 * There is no process to spawn or supervise — the provider validates that the
 * configured URL is reachable and returns it. `disconnect()` is a no-op
 * because the LB persists across daemon restarts by design.
 *
 * Requires `tunnel.loadBalancerUrl` in config. When `loadBalancerApiKey` is
 * set, the provider sends it as `Authorization: Bearer <key>` in the readiness
 * probe so the LB (which authenticates via vLLM `--api-key`) accepts it.
 */
class LoadBalancerProvider implements TunnelProvider_Impl {
  private readonly logger;
  private readonly publicUrl: string;
  private readonly apiKey: string | undefined;

  constructor(config: TunnelConfig, logLevel: string) {
    this.logger = createLogger(logLevel);
    if (!config.loadBalancerUrl) {
      throw new TunnelProviderNotAvailableError(
        'load_balancer',
        'tunnel.loadBalancerUrl is required for the load_balancer provider. ' +
          'Provision it via Terraform (deploy/gcp/) and set the URL in config.',
      );
    }
    this.publicUrl = config.loadBalancerUrl;
    this.apiKey = config.loadBalancerApiKey;
  }

  async checkExisting(localPort: number): Promise<TunnelInfo | null> {
    // The LB is always-on; "existing" = the URL is currently reachable.
    const reachable = await this.isReachable();
    if (!reachable) {
      return null;
    }
    return {
      publicUrl: this.publicUrl,
      provider: 'load_balancer',
      localPort,
      establishedAt: new Date().toISOString(),
      tunnelId: hostFromUrl(this.publicUrl),
      region: null,
    };
  }

  async create(localPort: number): Promise<TunnelInfo> {
    await waitForLocalBackend(localPort);

    const reachable = await this.isReachable();
    if (!reachable) {
      throw new TunnelError(
        `GCP Load Balancer endpoint ${this.publicUrl} is not reachable. ` +
          'Verify the LB backend service, URL map, and GPU VM health.',
        'load_balancer',
      );
    }
    this.logger.info('GCP Load Balancer endpoint verified', {
      publicUrl: this.publicUrl,
      localPort,
    });
    return {
      publicUrl: this.publicUrl,
      provider: 'load_balancer',
      localPort,
      establishedAt: new Date().toISOString(),
      tunnelId: hostFromUrl(this.publicUrl),
      region: null,
    };
  }

  async disconnect(): Promise<void> {
    // No-op: the LB is a static GCP resource, not a process we own.
    this.logger.debug('LoadBalancerProvider.disconnect() — no-op (LB is always-on)');
  }

  /**
   * Probes `/v1/models` through the LB to confirm end-to-end reachability.
   * Sends the API key when configured so the authenticated backend accepts it.
   */
  private async isReachable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.publicUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Extracts the hostname from a URL for use as a stable tunnelId. */
function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── Tunnel Service ───────────────────────────────────────────────────────────

/**
 * Service for managing tunnel connections to expose the vLLM API publicly.
 *
 * Supports multiple tunnel providers with ngrok as the primary implementation.
 * Handles the complete tunnel lifecycle:
 * 1. Check for an existing tunnel to reuse
 * 2. Create a new tunnel if none exists
 * 3. Retry on failure with configurable attempts
 * 4. Graceful disconnection and cleanup
 *
 * The public URL is stored in the benchmark results for use by
 * Kibana connector creation and other downstream consumers.
 *
 * @example
 * ```typescript
 * const tunnelService = new TunnelService({
 *   config: appConfig.tunnel,
 *   logLevel: 'info',
 * });
 *
 * const result = await tunnelService.connect();
 * if (result.success) {
 *   console.log(`Public URL: ${result.tunnel.publicUrl}`);
 * }
 *
 * await tunnelService.disconnect();
 * ```
 */
export class TunnelService {
  private readonly logger;
  private readonly config: TunnelConfig;
  private readonly provider: TunnelProvider_Impl;
  private currentTunnel: TunnelInfo | null = null;

  constructor(options: TunnelServiceOptions) {
    this.config = options.config;
    const logLevel = options.logLevel ?? 'info';
    this.logger = createLogger(logLevel);
    this.provider = this.createProvider(logLevel);

    this.logger.info('TunnelService initialized', {
      enabled: this.config.enabled,
      provider: this.config.provider,
      localPort: this.config.localPort,
    });
  }

  /**
   * Creates the appropriate tunnel provider based on configuration.
   */
  private createProvider(logLevel: string): TunnelProvider_Impl {
    switch (this.config.provider) {
      case 'ngrok':
        return new NgrokProvider(this.config, logLevel);
      case 'cloudflared':
        return new CloudflaredProvider(logLevel);
      case 'cloudflared_named':
        return new CloudflaredNamedProvider(this.config, logLevel);
      case 'cloudrun':
        return new CloudRunProvider();
      case 'load_balancer':
        return new LoadBalancerProvider(this.config, logLevel);
      default:
        throw new TunnelError(
          `Unknown tunnel provider: ${this.config.provider as string}`,
          this.config.provider as string,
        );
    }
  }

  /**
   * Whether the tunnel service is enabled in configuration.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * The currently active tunnel, if any.
   */
  get activeTunnel(): TunnelInfo | null {
    return this.currentTunnel;
  }

  /**
   * Returns the current status of the tunnel service.
   */
  getStatus(): TunnelStatus {
    return {
      enabled: this.config.enabled,
      active: this.currentTunnel !== null,
      tunnel: this.currentTunnel,
      provider: this.config.provider,
    };
  }

  /**
   * Establishes a tunnel connection to the local vLLM API.
   *
   * First checks for an existing tunnel that can be reused.
   * If none exists, creates a new tunnel with retry logic.
   *
   * @returns TunnelResult with the public URL on success
   */
  async connect(): Promise<TunnelResult> {
    if (!this.config.enabled) {
      this.logger.info('Tunnel service is disabled, skipping connection');
      return {
        success: false,
        tunnel: null,
        error: 'Tunnel service is disabled',
        reused: false,
      };
    }

    const localPort = this.config.localPort;

    // Step 1: Check for existing tunnel
    try {
      const existing = await this.provider.checkExisting(localPort);
      if (existing) {
        this.currentTunnel = existing;
        this.logger.info('Reusing existing tunnel', {
          publicUrl: existing.publicUrl,
          provider: existing.provider,
        });
        return {
          success: true,
          tunnel: existing,
          error: null,
          reused: true,
        };
      }
    } catch (error) {
      this.logger.debug('Could not check for existing tunnel', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 2: Create new tunnel with retries
    const maxAttempts = this.config.retryAttempts + 1; // +1 for the initial attempt
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.info(`Creating tunnel (attempt ${attempt}/${maxAttempts})`, {
          provider: this.config.provider,
          localPort,
        });

        const tunnel = await this.createWithTimeout(localPort);
        this.currentTunnel = tunnel;

        this.logger.info('Tunnel established successfully', {
          publicUrl: tunnel.publicUrl,
          provider: tunnel.provider,
          attempt,
        });

        return {
          success: true,
          tunnel,
          error: null,
          reused: false,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Tunnel creation failed (attempt ${attempt}/${maxAttempts}): ${lastError.message}`,
        );

        if (attempt < maxAttempts) {
          await this.provider.disconnect().catch(() => {});
          // ERR_NGROK_334 ("endpoint already online") means a stale endpoint still holds our
          // reserved domain. The local agent is gone but the cloud endpoint clears on a
          // heartbeat timeout (tens of seconds). Fast 5s retries just re-collide, so back off
          // hard and escalate — the domain frees within ~30-60s and a later attempt succeeds.
          const domainBusy = /ERR_NGROK_334|already online/i.test(lastError.message);
          const delayMs = domainBusy
            ? Math.min(20_000 * attempt, 60_000)
            : this.config.retryDelayMs;
          this.logger.info(
            `Retrying in ${delayMs}ms...${domainBusy ? ' (reserved domain busy — waiting for stale endpoint to clear)' : ''}`,
          );
          await this.delay(delayMs);
        }
      }
    }

    const creationError = new TunnelCreationError(
      this.config.provider,
      maxAttempts,
      lastError ?? undefined,
    );

    this.logger.error('Failed to establish tunnel after all attempts', {
      provider: this.config.provider,
      attempts: maxAttempts,
      error: creationError.message,
    });

    return {
      success: false,
      tunnel: null,
      error: creationError.message,
      reused: false,
    };
  }

  /**
   * Tear down and re-establish the public tunnel (used when ngrok dies mid-poll).
   */
  async reconnect(): Promise<TunnelResult> {
    this.logger.info('Reconnecting tunnel', {
      provider: this.config.provider,
      localPort: this.config.localPort,
    });
    this.currentTunnel = null;
    if (
      this.config.provider === 'cloudflared' ||
      this.config.provider === 'cloudflared_named' ||
      this.config.provider === 'load_balancer'
    ) {
      // Reuse-first: the tunnel URL is injected into in-flight CI builds, so it must NOT
      // be rotated while the tunnel process is still alive (a transient public-endpoint
      // blip must not orphan a running eval). connect()'s checkExisting() reattaches to
      // the surviving tunnel; only when it's genuinely dead does it spawn a fresh one.
      // For the named provider the hostname is stable regardless, so reuse is always safe.
      return this.connect();
    }
    await this.provider.disconnect();
    await killOrphanNgrokForPort(this.config.localPort);
    return this.connect();
  }

  /**
   * Disconnects the current tunnel and cleans up resources.
   */
  async disconnect(): Promise<void> {
    if (!this.currentTunnel) {
      this.logger.debug('No active tunnel to disconnect');
      return;
    }

    this.logger.info('Disconnecting tunnel', {
      publicUrl: this.currentTunnel.publicUrl,
      provider: this.currentTunnel.provider,
    });

    await this.provider.disconnect();
    this.currentTunnel = null;

    this.logger.info('Tunnel disconnected successfully');
  }

  /**
   * Creates a tunnel with a timeout wrapper.
   */
  private async createWithTimeout(localPort: number): Promise<TunnelInfo> {
    const timeoutMs = this.config.timeoutMs;

    return new Promise<TunnelInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new TunnelError(
            `Tunnel creation timed out after ${timeoutMs}ms`,
            this.config.provider,
          ),
        );
      }, timeoutMs);

      this.provider
        .create(localPort)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Helper to delay execution.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
