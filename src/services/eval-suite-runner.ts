import { execFile } from 'node:child_process';
import type { ElasticsearchResultsStore } from './elasticsearch-results-store.js';
import { createLogger } from '../utils/logger.js';
import { OTelSpanRecorder } from '../utils/otel-span-recorder.js';
import type { Logger } from 'winston';
import type { AppConfig, KibanaConnectorConfig } from '../types/config.js';
import { stage2LocalConfigSchema } from '../types/config.js';
import { KibanaConnectorService } from './kibana-connector.js';
import { buildConnectorPayload } from './buildkite-connector-builder.js';

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
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
  /**
   * kbn-evals profile for golden cluster forwarding. Set to 'dev-vault' to
   * natively forward scores + traces to the golden kbn-evals cluster via
   * `--profile dev-vault` (reads credentials from the vault config.json).
   * Unset (default) runs with no golden export.
   */
  evalProfile?: string;
  /** Kibana connector ID for the LLM-as-a-judge evaluator (--judge). */
  connectorId?: string;
  /** Kibana base URL for eval score ingestion (--evaluations-kbn-url). */
  kibanaUrl?: string;
  /** Kibana API key for eval score ingestion (--evaluations-kbn-api-key). */
  kibanaApiKey?: string;
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

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_SUITES: readonly string[] = stage2LocalConfigSchema.parse({}).evalSuites;

export class EvalSuiteRunner {
  private readonly esStore: ElasticsearchResultsStore;
  private readonly logger: Logger;
  private readonly spanRecorder: OTelSpanRecorder;
  private readonly config?: AppConfig;

  constructor({
    esStore,
    logger,
    spanRecorder,
    config,
  }: {
    esStore: ElasticsearchResultsStore;
    logger?: Logger;
    spanRecorder?: OTelSpanRecorder;
    config?: AppConfig;
  }) {
    this.esStore = esStore;
    this.logger = logger ?? createLogger('info');
    this.spanRecorder = spanRecorder ?? new OTelSpanRecorder();
    this.config = config;
  }

  /**
   * kbn-evals resolves connector ids from the `KIBANA_TESTING_AI_CONNECTORS`
   * env var (see `createPlaywrightEvalsConfig` -> `getAvailableConnectors`),
   * NOT from Kibana's connectors API. Passing only `--judge <uuid>` for a
   * connector created via the API therefore always fails with
   * "Evaluation connector id <id> was not found, pick one from ".
   *
   * So we build the same base64 `.gen-ai` payload the Buildkite path uses and
   * inject it alongside `EVALUATION_CONNECTOR_ID` for the local run.
   *
   * The daemon's own environment may already carry a connector map (e.g. the
   * operator's EIS connectors). Merging — rather than skipping when set —
   * matters: an inherited map never contains the per-model vLLM connector, so
   * skipping would leave the id unresolvable exactly like passing nothing.
   */
  private buildEvalEnv(
    connectorId: string | undefined,
    endpointUrl: string,
    modelId: string,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!connectorId) {
      return env;
    }

    const { connectorJson } = buildConnectorPayload({
      endpointUrl,
      modelId,
      connectorId,
    });

    let merged: Record<string, unknown> = JSON.parse(
      Buffer.from(connectorJson, 'base64').toString('utf8'),
    );

    const inherited = env.KIBANA_TESTING_AI_CONNECTORS;
    if (inherited) {
      try {
        const decoded = JSON.parse(Buffer.from(inherited, 'base64').toString('utf8'));
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
          // Our per-model connector wins on id collision.
          merged = { ...(decoded as Record<string, unknown>), ...merged };
        }
      } catch {
        this.logger.warn('Ignoring unparseable inherited KIBANA_TESTING_AI_CONNECTORS', {
          modelId,
        });
      }
    }

    env.KIBANA_TESTING_AI_CONNECTORS = Buffer.from(JSON.stringify(merged)).toString('base64');
    env.EVALUATION_CONNECTOR_ID = connectorId;
    return env;
  }

  async run(opts: EvalRunOptions): Promise<EvalSuiteResult> {
    const {
      repoPath,
      endpointUrl,
      modelId,
      suites = this.config?.stage2Local.evalSuites ?? [...DEFAULT_SUITES],
      timeoutMs = DEFAULT_TIMEOUT_MS,
      evalProfile,
      connectorId: providedConnectorId,
      kibanaUrl,
      kibanaApiKey,
    } = opts;

    const startedAt = new Date().toISOString();
    const suiteResults: EvalSuiteResult['suiteResults'] = [];

    this.logger.info('Starting eval suite run', { modelId, suites, endpointUrl });

    const connectorId = providedConnectorId ?? (await this.createConnectorId(endpointUrl, modelId));
    if (!connectorId) {
      this.logger.warn('No evaluation connector ID available; eval CLI will likely fail', {
        modelId,
      });
    }

    for (const suite of suites) {
      const suiteStart = Date.now();
      const { span, end } = this.spanRecorder.startSpan('eval-suite', {
        suite,
        modelId,
        endpointUrl,
      });

      try {
        const args = [
          'scripts/evals.js',
          'run',
          '--suite',
          suite,
          '--project',
          modelId,
        ];
        if (connectorId) {
          args.push('--judge', connectorId);
        }
        if (kibanaUrl) {
          args.push('--evaluations-kbn-url', kibanaUrl);
        }
        if (kibanaApiKey) {
          args.push('--evaluations-kbn-api-key', kibanaApiKey);
        }
        if (evalProfile) {
          args.push('--profile', evalProfile);
        }
        const { stdout } = await execFilePromise('node', args, {
          cwd: repoPath,
          timeout: timeoutMs,
          env: this.buildEvalEnv(connectorId, endpointUrl, modelId),
        });

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

  /**
   * Creates or reuses a Kibana connector for the vLLM endpoint when the local
   * Stage 2 config provides Kibana credentials. Returns undefined when no
   * credentials are configured so the caller can fall back to a pre-created
   * connector passed via EvalRunOptions.
   */
  private async createConnectorId(
    endpointUrl: string,
    modelId: string,
  ): Promise<string | undefined> {
    const connectorConfig = this.buildConnectorConfig();
    if (!connectorConfig) {
      return undefined;
    }

    const service = new KibanaConnectorService({
      config: connectorConfig,
      logLevel: this.logger.level,
    });

    const result = await service.createConnector({ apiUrl: endpointUrl, modelId });
    if (!result.success || !result.connector) {
      this.logger.warn('Failed to create Kibana connector for eval run', {
        modelId,
        error: result.error ?? 'unknown error',
      });
      return undefined;
    }

    return result.connector.id;
  }

  private buildConnectorConfig(): KibanaConnectorConfig | null {
    if (!this.config) {
      return null;
    }

    const url = this.config.stage2Local.kibanaUrl ?? this.config.kibanaConnector.url;
    const apiKey = this.config.stage2Local.kibanaApiKey ?? this.config.kibanaConnector.apiKey;
    if (!url || !apiKey) {
      return null;
    }

    return {
      enabled: true,
      url,
      apiKey,
      connectorNamePrefix: this.config.kibanaConnector.connectorNamePrefix,
      requestTimeoutMs: this.config.kibanaConnector.requestTimeoutMs,
    };
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
