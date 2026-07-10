import { execFile } from 'node:child_process';
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

export interface LocalBatchEvalResult {
  modelId: string;
  status: 'success' | 'partial' | 'failed';
  suites: Array<{
    suite: string;
    status: 'pass' | 'fail';
    durationMs: number;
  }>;
  startedAt: string;
  completedAt: string;
  /** Raw log output from the batch runner */
  logPath?: string;
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

    const { exitCode, stderr } = await execFilePromise(
      'bash',
      [batchScript, ...args],
      { cwd: pluginDir, timeout: timeoutMs, env },
    );

    const completedAt = new Date().toISOString();
    const status: LocalBatchEvalResult['status'] =
      exitCode === 0 ? 'success' : exitCode === null ? 'failed' : 'partial';

    if (exitCode !== 0) {
      this.logger.warn('Local batch eval completed with errors', {
        exitCode,
        stderr: stderr.slice(-500),
      });
    }

    const suiteResults = suites.map((suite) => ({
      suite,
      status: (exitCode === 0 ? 'pass' : 'fail') as 'pass' | 'fail',
      durationMs: 0,
    }));

    return {
      modelId: opts.modelId,
      status,
      suites: suiteResults,
      startedAt,
      completedAt,
      logPath: undefined,
    };
  }
}
