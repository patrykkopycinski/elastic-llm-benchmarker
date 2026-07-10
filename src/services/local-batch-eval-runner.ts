import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
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
 * The vLLM endpoint is passed as a LiteLLM connector profile, which the batch
 * runner injects into Kibana as an OpenAI-compatible `.inference` connector.
 */
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
    const suites = opts.suites ?? this.config.evalSuites;
    const workers = String(this.config.batchWorkers);
    const timeoutMs = this.config.suiteTimeoutMs * suites.length;

    const args = [
      '--smoke',
    ];

    if (suites.length > 2) {
      args.length = 0;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BATCH_WORKERS: workers,
      BATCH_MODELS: opts.modelId,
      BATCH_CONNECTOR_PROFILE: 'litellm',
      BATCH_SUITES: suites.join(','),
      BATCH_EXPORT_PROFILE: this.config.exportProfile,
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
    });

    const { stdout, stderr, exitCode } = await execFilePromise(
      'bash',
      [batchScript, ...args],
      { cwd: pluginDir, timeout: timeoutMs, env },
    );

    const completedAt = new Date().toISOString();

    if (exitCode !== 0) {
      this.logger.warn('Local batch eval completed with errors', {
        exitCode,
        stderr: stderr.slice(-500),
      });
    }

    const summaryPath = extractSummaryPath(stdout);
    const { suiteResults, parseError } = await this.parseSummary(summaryPath, suites, opts.modelId);

    if (parseError) {
      this.logger.warn('Local batch eval: could not parse structured summary — falling back to exitCode-only per-suite status', {
        summaryPath,
        parseError,
        stdoutTail: stdout.slice(-500),
      });
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
}
