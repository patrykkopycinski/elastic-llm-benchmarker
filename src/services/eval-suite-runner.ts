import { execFile } from 'node:child_process';
import type { ElasticsearchResultsStore } from './elasticsearch-results-store.js';
import { createLogger } from '../utils/logger.js';
import { OTelSpanRecorder } from '../utils/otel-span-recorder.js';
import type { Logger } from 'winston';

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export interface EvalRunOptions {
  repoPath: string;
  endpointUrl: string;
  modelId: string;
  suites?: string[];
  timeoutMs?: number;
}

export interface EvalSuiteResult {
  modelId: string;
  endpointUrl: string;
  status: 'success' | 'partial' | 'failed';
  suiteResults: Array<{
    suite: string;
    status: 'pass' | 'fail' | 'error';
    score?: number;
    durationMs: number;
    error?: string;
    traceId?: string;
  }>;
  startedAt: string;
  completedAt: string;
}

export class EvalSuiteError extends Error {
  readonly suite: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, suite: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'EvalSuiteError';
    this.suite = suite;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const DEFAULT_SUITES = ['tool_calls', 'latency'];
const DEFAULT_TIMEOUT_MS = 300_000;

export class EvalSuiteRunner {
  private readonly esStore: ElasticsearchResultsStore;
  private readonly logger: Logger;
  private readonly spanRecorder: OTelSpanRecorder;

  constructor({
    esStore,
    logger,
    spanRecorder,
  }: {
    esStore: ElasticsearchResultsStore;
    logger?: Logger;
    spanRecorder?: OTelSpanRecorder;
  }) {
    this.esStore = esStore;
    this.logger = logger ?? createLogger('info');
    this.spanRecorder = spanRecorder ?? new OTelSpanRecorder();
  }

  async run(opts: EvalRunOptions): Promise<EvalSuiteResult> {
    const {
      repoPath,
      endpointUrl,
      modelId,
      suites = DEFAULT_SUITES,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = opts;

    const startedAt = new Date().toISOString();
    const suiteResults: EvalSuiteResult['suiteResults'] = [];

    this.logger.info('Starting eval suite run', { modelId, suites, endpointUrl });

    for (const suite of suites) {
      const suiteStart = Date.now();
      const { span, end } = this.spanRecorder.startSpan('eval-suite', {
        suite,
        modelId,
        endpointUrl,
      });

      try {
        const { stdout } = await execFilePromise(
          'node',
          ['scripts/evals.js', 'run', '--suite', suite, '--endpoint', endpointUrl, '--model', modelId],
          { cwd: repoPath, timeout: timeoutMs },
        );

        const parsed = this.parseOutput(stdout);
        const durationMs = Date.now() - suiteStart;

        const status = parsed.error ? 'fail' : 'pass';
        suiteResults.push({
          suite,
          status,
          score: parsed.score,
          durationMs,
          error: parsed.error,
          traceId: span.traceId,
        });

        end({ status, durationMs: String(durationMs) });

        this.logger.info(`Suite ${suite} completed`, { status, durationMs, modelId });
      } catch (err: unknown) {
        const durationMs = Date.now() - suiteStart;
        const exitCode = err && typeof err === 'object' && 'code' in err ? (err.code as number | null) : null;
        const stdout = err && typeof err === 'object' && 'stdout' in err ? String(err.stdout) : '';

        const errorMessage = err instanceof Error ? err.message : String(err);
        const parsedFallback = stdout ? this.parseOutput(stdout) : null;

        suiteResults.push({
          suite,
          status: 'error',
          score: parsedFallback?.score,
          durationMs,
          error: parsedFallback?.error ?? errorMessage,
          traceId: span.traceId,
        });

        end({ status: 'error', durationMs: String(durationMs), error: errorMessage });

        this.logger.error(`Suite ${suite} failed`, { error: errorMessage, exitCode, modelId });
      }
    }

    const completedAt = new Date().toISOString();

    const passCount = suiteResults.filter((r) => r.status === 'pass').length;
    const errorCount = suiteResults.filter((r) => r.status === 'error').length;

    let status: EvalSuiteResult['status'];
    if (passCount === suiteResults.length) {
      status = 'success';
    } else if (errorCount === suiteResults.length) {
      status = 'failed';
    } else {
      status = 'partial';
    }

    const result: EvalSuiteResult = {
      modelId,
      endpointUrl,
      status,
      suiteResults,
      startedAt,
      completedAt,
    };

    try {
      await this.esStore.saveEvalResult(result);
    } catch (esErr: unknown) {
      this.logger.warn('Failed to save eval result to ES', {
        error: esErr instanceof Error ? esErr.message : String(esErr),
      });
    }

    return result;
  }

  private parseOutput(stdout: string): { score?: number; error?: string } {
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length === 0) {
      return { error: 'Empty stdout from eval script' };
    }

    const lastLine = lines[lines.length - 1]!;
    const fromLast = this.tryParseJson(lastLine);
    if (fromLast) return fromLast;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      const parsed = this.tryParseJson(line);
      if (parsed) return parsed;
    }

    return { error: `Unable to parse eval output. Raw stdout:\n${stdout.slice(0, 2000)}` };
  }

  private tryParseJson(line: string): { score?: number; error?: string } | null {
    try {
      const obj: unknown = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        const o = obj as Record<string, unknown>;

        if ('type' in o && o.type === 'result') {
          const score = 'score' in o ? this.coerceNumber(o.score) : undefined;
          const error = 'error' in o && typeof o.error === 'string' ? o.error : undefined;
          return { score, error };
        }

        if ('score' in o || 'results' in o) {
          const score = 'score' in o ? this.coerceNumber(o.score) : undefined;
          const error = 'error' in o && typeof o.error === 'string' ? o.error : undefined;
          return { score, error };
        }
      }
    } catch {
      // not valid JSON or expected shape
    }
    return null;
  }

  private coerceNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return undefined;
  }
}
