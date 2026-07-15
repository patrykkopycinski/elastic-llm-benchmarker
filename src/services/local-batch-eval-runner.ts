import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';
import type { Stage2LocalConfig } from '../types/config.js';

export interface LocalBatchEvalOptions {
  /** vLLM endpoint base URL (e.g., http://10.0.0.5:8000/v1) */
  vllmBaseUrl: string;
  /** Model ID as served by the vLLM endpoint */
  modelId: string;
  /** Suites to run. Defaults to stage2Local.evalSuites */
  suites?: string[];
  /** Suites already passed — excluded from this batch invocation. */
  skipSuites?: string[];
}

export interface LocalBatchEvalSuiteResult {
  suite: string;
  status: 'pass' | 'fail';
  durationMs: number;
  /** Path to this suite's `node scripts/evals run` log, if the summary reported one. */
  logPath?: string;
}

export interface LocalBatchEvalResult {
  modelId: string;
  status: 'success' | 'partial' | 'failed';
  suites: LocalBatchEvalSuiteResult[];
  startedAt: string;
  completedAt: string;
  /** Path to `run-security-evals-batch.sh`'s summary JSON (matrix-output/batch-summary-*.json). */
  summaryPath?: string;
  /** Full batch runner stdout persisted under matrix-output/batch-logs/. */
  stdoutLogPath?: string;
  /**
   * Raw log output from the batch runner. Kept for backward compat with
   * callers reading a single "where do I look" path — prefer `summaryPath`
   * (structured) or each suite's `logPath` (per-suite `node scripts/evals`
   * output) for anything programmatic.
   */
  logPath?: string;
}

interface BatchSummaryResultEntry {
  suite: string;
  model: string;
  status: 'pass' | 'fail';
  duration_ms: number;
  log_file: string;
  worker: number;
}

interface BatchSummaryFile {
  run_id: string;
  timestamp: string;
  overall_exit: number;
  log_dir: string;
  results: BatchSummaryResultEntry[];
}

/** Node's default execFile maxBuffer (1 MiB) kills long batch runs before Summary is printed. */
export const BATCH_RUNNER_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      const exitCode = error
        ? typeof code === 'number'
          ? code
          : 1
        : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * `run-security-evals-batch.sh` prints `[batch HH:MM:SS] >>> Summary: <path>`
 * as its last line of stdout (see the script's final `log "Summary: ..."`
 * call). This is the only signal the caller has for where the structured
 * per-suite results landed — the script doesn't take a `--summary-out` flag.
 */
function extractSummaryPath(stdout: string): string | undefined {
  const match = stdout.match(/Summary:\s+(\S+\.json)\s*$/m);
  return match?.[1];
}

/**
 * Bridge between the benchmarker's Stage 2 pipeline and the skill-dev plugin's
 * `run-security-evals-batch.sh`. When `stage2Local.useBatchRunner` is enabled,
 * Stage 2 delegates here instead of running suites one-by-one via the single-stack
 * `eval-suite-runner.ts` path.
 *
 * The batch runner boots parallel isolated Scout stacks with the merged
 * `evals_security_all` config set, implements the two-stage EIS connector boot,
 * and isolates ES data dirs per worker. This is the fast path for running the
 * full security suite set against an OSS model served via vLLM.
 *
 * The vLLM endpoint is passed as a LiteLLM connector profile (`.gen-ai`,
 * `apiProvider: Other`), which the batch runner injects into Kibana via
 * `KIBANA_TESTING_AI_CONNECTORS`.
 */

/** Full ESQL regression dataset routinely exceeds the default 1h per-suite budget. */
export const ESQL_GENERATION_SUITE = 'security-esql-generation-regression';
export const ESQL_MIN_SUITE_TIMEOUT_MS = 7_200_000;

/**
 * Sum per-suite exec timeouts. ESQL gets at least {@link ESQL_MIN_SUITE_TIMEOUT_MS}
 * even when `basePerSuiteMs` is lower — a single-suite ESQL-only run otherwise
 * inherits only 1h and gets SIGKILL'd mid-dataset.
 */
export function resolveBatchTimeoutMs(suites: string[], basePerSuiteMs: number): number {
  return suites.reduce((total, suite) => {
    const perSuite =
      suite === ESQL_GENERATION_SUITE
        ? Math.max(basePerSuiteMs, ESQL_MIN_SUITE_TIMEOUT_MS)
        : basePerSuiteMs;
    return total + perSuite;
  }, 0);
}

/** Benchmarker security trio: alert-triage first on a fresh stack. */
export function orderBenchmarkerSuites(suites: string[]): string[] {
  const priority = [
    'security-alert-triage',
    'security-alerts-rag-regression',
    'security-esql-generation-regression',
  ];
  const ordered: string[] = [];
  for (const suite of priority) {
    if (suites.includes(suite)) {
      ordered.push(suite);
    }
  }
  for (const suite of suites) {
    if (!ordered.includes(suite)) {
      ordered.push(suite);
    }
  }
  return ordered;
}
export class LocalBatchEvalRunner {
  private readonly config: Stage2LocalConfig;
  private readonly logger: Logger;

  constructor(config: Stage2LocalConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? createLogger('info');
  }

  async run(opts: LocalBatchEvalOptions): Promise<LocalBatchEvalResult> {
    const startedAt = new Date().toISOString();
    const pluginDir = this.config.skillDevPluginDir;
    if (!pluginDir) {
      throw new Error('stage2Local.skillDevPluginDir is required when useBatchRunner is enabled');
    }

    const batchScript = join(pluginDir, 'scripts', 'run-security-evals-batch.sh');
    const skipSet = new Set(opts.skipSuites ?? []);
    const rawSuites = (opts.suites ?? this.config.evalSuites).filter((s) => !skipSet.has(s));
    if (rawSuites.length === 0) {
      return {
        modelId: opts.modelId,
        status: 'success',
        suites: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    const suites = orderBenchmarkerSuites(rawSuites);
    const workers = String(this.config.batchWorkers);
    const timeoutMs = resolveBatchTimeoutMs(suites, this.config.suiteTimeoutMs);

    // BATCH_SUITES is always set — never pass --smoke (it only substitutes
    // SMOKE_SUITES when BATCH_SUITES is unset and confuses ESQL-only runs).
    const args: string[] = [];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BATCH_WORKERS: workers,
      BATCH_MODELS: opts.modelId,
      BATCH_CONNECTOR_PROFILE: 'litellm',
      BATCH_SUITES: suites.join(','),
      BATCH_EXPORT_PROFILE: this.config.exportProfile,
      BATCH_SUITE_ORDER: 'benchmarker',
      BATCH_PAUSE_ALWAYS_ON_STACK: this.config.pauseAlwaysOnStack ? 'true' : 'false',
      BATCH_TEARDOWN_ON_EXIT: this.config.teardownBatchStack ? 'true' : 'false',
      BATCH_CLEANUP_STALE_PORTS: this.config.cleanupStalePorts ? 'true' : 'false',
      BOOT_POLL_ATTEMPTS: String(
        this.config.bootPollAttempts ??
          (process.env.BOOT_POLL_ATTEMPTS ? Number(process.env.BOOT_POLL_ATTEMPTS) : 1800),
      ),
      LITELLM_BASE_URL: opts.vllmBaseUrl,
      EVALUATION_CONCURRENCY: '3',
    };

    this.logger.info('Local batch eval: starting', {
      modelId: opts.modelId,
      vllmBaseUrl: opts.vllmBaseUrl,
      suites,
      workers,
      pluginDir,
      exportProfile: this.config.exportProfile,
      batchTimeoutMs: timeoutMs,
    });

    const { stdout, stderr, exitCode } = await execFilePromise(
      'bash',
      [batchScript, ...args],
      { cwd: pluginDir, timeout: timeoutMs, maxBuffer: BATCH_RUNNER_MAX_BUFFER_BYTES, env },
    );

    let stdoutLogPath: string | undefined;
    try {
      stdoutLogPath = join(
        pluginDir,
        'matrix-output',
        'batch-logs',
        `batch-stdout-runner-${Date.now()}.log`,
      );
      await mkdir(dirname(stdoutLogPath), { recursive: true });
      await writeFile(stdoutLogPath, stdout, 'utf8');
      this.logger.info('Local batch eval: stdout persisted', { stdoutLogPath });
    } catch (persistErr: unknown) {
      this.logger.warn('Local batch eval: could not persist stdout log', {
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }

    const completedAt = new Date().toISOString();

    if (exitCode !== 0) {
      this.logger.warn('Local batch eval completed with errors', {
        exitCode,
        stderr: stderr.slice(-500),
      });
    }

    const summaryPath = extractSummaryPath(stdout);
    let { suiteResults, parseError } = await this.parseSummary(summaryPath, suites, opts.modelId);

    if (parseError) {
      const jsonlResults = await this.parseJsonlStateResults(pluginDir, suites, opts.modelId);
      const jsonlPassCount = jsonlResults.filter((s) => s.status === 'pass').length;
      if (jsonlPassCount > 0) {
        this.logger.warn('Local batch eval: summary missing — using incremental worker JSONL results', {
          summaryPath,
          parseError,
          jsonlPassCount,
          jsonlSuiteCount: jsonlResults.length,
        });
        suiteResults = jsonlResults;
        parseError = undefined;
      } else {
        this.logger.warn('Local batch eval: could not parse structured summary — falling back to exitCode-only per-suite status', {
          summaryPath,
          parseError,
          stdoutTail: stdout.slice(-500),
        });
      }
    }

    const passCount = suiteResults.filter((s) => s.status === 'pass').length;
    const status: LocalBatchEvalResult['status'] =
      passCount === suiteResults.length && exitCode === 0
        ? 'success'
        : passCount > 0
          ? 'partial'
          : 'failed';

    return {
      modelId: opts.modelId,
      status,
      suites: suiteResults,
      startedAt,
      completedAt,
      summaryPath,
      stdoutLogPath,
      logPath: summaryPath,
    };
  }

  /**
   * Reads `run-security-evals-batch.sh`'s summary JSON and maps its flat
   * `results` array (one entry per suite×model×worker, written incrementally
   * by the script's `record_suite_result`) onto the suites this call
   * requested. Suites present in `opts.suites` but missing from `results`
   * (e.g. the batch crashed before that suite's worker got to it) are
   * reported as `fail` with `durationMs: 0` rather than silently omitted —
   * the caller always gets one entry per requested suite.
   */
  private async parseSummary(
    summaryPath: string | undefined,
    requestedSuites: string[],
    modelId: string,
  ): Promise<{ suiteResults: LocalBatchEvalSuiteResult[]; parseError?: string }> {
    const fallback = (): LocalBatchEvalSuiteResult[] =>
      requestedSuites.map((suite) => ({ suite, status: 'fail' as const, durationMs: 0 }));

    if (!summaryPath) {
      return { suiteResults: fallback(), parseError: 'no "Summary: <path>" line found in batch runner stdout' };
    }

    let summary: BatchSummaryFile;
    try {
      const raw = await readFile(summaryPath, 'utf-8');
      summary = JSON.parse(raw) as BatchSummaryFile;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { suiteResults: fallback(), parseError: `failed to read/parse ${summaryPath}: ${message}` };
    }

    const bySuite = new Map<string, BatchSummaryResultEntry>();
    for (const entry of summary.results ?? []) {
      if (entry.model === modelId) {
        bySuite.set(entry.suite, entry);
      }
    }

    const suiteResults = requestedSuites.map((suite): LocalBatchEvalSuiteResult => {
      const entry = bySuite.get(suite);
      if (!entry) {
        return { suite, status: 'fail', durationMs: 0 };
      }
      return {
        suite,
        status: entry.status,
        durationMs: entry.duration_ms,
        logPath: entry.log_file,
      };
    });

    return { suiteResults };
  }

  /**
   * Reads per-suite results written incrementally by `record_suite_result`
   * when the batch script is killed before it prints `Summary: <path>`.
   */
  private async parseJsonlStateResults(
    pluginDir: string,
    requestedSuites: string[],
    modelId: string,
  ): Promise<LocalBatchEvalSuiteResult[]> {
    const stateDir = join(pluginDir, 'matrix-output', '.batch-state');
    const bySuite = new Map<string, LocalBatchEvalSuiteResult>();

    try {
      const entries = await readdir(stateDir);
      const resultFiles = entries.filter((e) => /^worker-\d+-results\.jsonl$/.test(e));
      for (const file of resultFiles) {
        const raw = await readFile(join(stateDir, file), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as {
              suite?: string;
              model?: string;
              status?: string;
              duration_ms?: number;
              log_file?: string;
            };
            if (row.model !== modelId || !row.suite) continue;
            if (row.status !== 'pass' && row.status !== 'fail') continue;
            bySuite.set(row.suite, {
              suite: row.suite,
              status: row.status,
              durationMs: row.duration_ms ?? 0,
              logPath: row.log_file,
            });
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      // no state dir
    }

    return requestedSuites.map((suite) => {
      const entry = bySuite.get(suite);
      if (!entry) {
        return { suite, status: 'fail' as const, durationMs: 0 };
      }
      return entry;
    });
  }
}
