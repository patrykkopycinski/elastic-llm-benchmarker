import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';

export interface BuildkiteConfig {
  apiToken: string;
  orgSlug: string;
  onDemandPipelineSlug: string;
  weeklyPipelineSlug?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  retryOnFailure?: boolean;
  defaultEvalSuites?: string[];
  kibanaBranch?: string;
  /** Poll in background; caller keeps tunnel/model alive until poll completes. */
  detachPoll?: boolean;
  /** Reuse in-flight Benchmarker build when env matches instead of POSTing duplicate. */
  adoptRunningBuild?: boolean;
  /** Wait until pipeline has no running builds before POSTing a new build. */
  waitForPipelineIdle?: boolean;
  pipelineIdleWaitMs?: number;
  pipelineIdlePollMs?: number;
}

export interface BuildkiteTriggeredBuild {
  pipelineSlug: string;
  buildNumber: number;
  buildUrl: string;
  /** True when an existing running build was reused instead of creating a new one. */
  adopted?: boolean;
}

export interface TriggerOnDemandOptions {
  connectorJson: string;
  connectorId: string;
  evalSuiteIds: string[];
  modelId: string;
}

export interface TriggerWeeklyMatrixOptions {
  connectorJson: string;
  connectorId: string;
  evalSuiteIds: string[];
  modelId: string;
}

export interface BuildkiteArtifact {
  filename: string;
  url: string;
}

export interface BuildkiteBuildResult {
  buildUrl: string;
  buildNumber: number;
  status: 'passed' | 'failed' | 'running';
  artifacts?: BuildkiteArtifact[];
}

/** Buildkite states that mean the build will not make further progress. */
export const TERMINAL_BUILDKITE_STATES = new Set([
  'passed',
  'failed',
  'canceled',
  'skipped',
  'not_run',
]);

export function isTerminalBuildkiteState(state: string | undefined): state is string {
  return state !== undefined && TERMINAL_BUILDKITE_STATES.has(state);
}

export function buildResultStatusFromBuildkiteState(
  state: string,
): BuildkiteBuildResult['status'] {
  return state === 'passed' ? 'passed' : 'failed';
}

export interface BuildkiteEvalTrigger {
  triggerOnDemandEval(options: TriggerOnDemandOptions): Promise<BuildkiteBuildResult>;
  /** Create a build without waiting for completion. */
  createOnDemandBuild(options: TriggerOnDemandOptions): Promise<BuildkiteTriggeredBuild>;
  /**
   * Adopt a matching in-flight Benchmarker build, wait for pipeline idle, then create if needed.
   */
  createOnDemandBuildOrAdopt(options: TriggerOnDemandOptions): Promise<BuildkiteTriggeredBuild>;
  /**
   * Trigger a single weekly pipeline build with all suites running as parallel matrix steps.
   * Returns immediately with the build reference for polling.
   */
  createWeeklyMatrixBuild(options: TriggerWeeklyMatrixOptions): Promise<BuildkiteTriggeredBuild>;
  /** Poll an existing build until terminal state or timeout. */
  waitForBuild(
    pipelineSlug: string,
    buildNumber: number,
    buildUrl: string,
  ): Promise<BuildkiteBuildResult>;
  /** Download artifact body text (requires API token). */
  downloadArtifact(url: string): Promise<string | undefined>;
  /** Fetch raw Buildkite build state (running, passed, failed, canceled, …). */
  getBuildState(pipelineSlug: string, buildNumber: number): Promise<string | undefined>;
}

interface BuildkiteBuildResponse {
  number: number;
  web_url: string;
  state: string;
  message?: string;
  env?: Record<string, string>;
}

interface BuildkiteArtifactResponse {
  filename: string;
  download_url: string;
}

const BENCHMARKER_BUILD_MESSAGE_PREFIX = 'Benchmarker:';

export class BuildkiteEvalTriggerImpl implements BuildkiteEvalTrigger {
  private readonly logger: Logger;
  private readonly config: BuildkiteConfig;
  private readonly apiBase: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(config: BuildkiteConfig, logLevel?: string) {
    this.logger = createLogger(logLevel ?? 'info');
    this.config = config;
    this.apiBase = `https://api.buildkite.com/v2/organizations/${config.orgSlug}`;
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 3_600_000;
  }

  async createOnDemandBuild(options: TriggerOnDemandOptions): Promise<BuildkiteTriggeredBuild> {
    const build = await this.createBuild(
      this.config.onDemandPipelineSlug,
      `${BENCHMARKER_BUILD_MESSAGE_PREFIX} ${options.modelId} on-demand eval`,
      this.buildOnDemandEnv(options),
    );
    return {
      pipelineSlug: this.config.onDemandPipelineSlug,
      buildNumber: build.number,
      buildUrl: build.web_url,
      adopted: false,
    };
  }

  async createOnDemandBuildOrAdopt(options: TriggerOnDemandOptions): Promise<BuildkiteTriggeredBuild> {
    if (this.config.adoptRunningBuild !== false) {
      const adopted = await this.findAdoptableRunningBuild(options);
      if (adopted) {
        this.logger.info('Buildkite: adopting existing running eval build', {
          buildNumber: adopted.buildNumber,
          modelId: options.modelId,
          suite: options.evalSuiteIds[0],
          connectorId: options.connectorId,
        });
        return adopted;
      }
    }

    if (this.config.waitForPipelineIdle !== false) {
      await this.waitForPipelineIdle();
    }

    return this.createOnDemandBuild(options);
  }

  async createWeeklyMatrixBuild(options: TriggerWeeklyMatrixOptions): Promise<BuildkiteTriggeredBuild> {
    const pipelineSlug = this.config.weeklyPipelineSlug ?? 'kibana-evals-weekly-llm-evals';

    if (this.config.waitForPipelineIdle !== false) {
      await this.waitForPipelineIdleOnSlug(pipelineSlug);
    }

    const env: Record<string, string> = {
      KIBANA_TESTING_AI_CONNECTORS: options.connectorJson,
      LLM_EVAL_SUITES: options.evalSuiteIds.join(','),
      BENCHMARK_MODEL_ID: options.modelId,
      EVAL_PROJECT: options.connectorId,
      EVALUATION_CONNECTOR_ID: options.connectorId,
      EVAL_MODEL_GROUPS: options.modelId,
    };

    if (this.config.kibanaBranch) {
      env['KIBANA_BRANCH'] = this.config.kibanaBranch;
    }

    const build = await this.createBuild(
      pipelineSlug,
      `${BENCHMARKER_BUILD_MESSAGE_PREFIX} ${options.modelId} weekly matrix eval`,
      env,
    );

    this.logger.info('Buildkite: weekly matrix build created', {
      pipelineSlug,
      buildNumber: build.number,
      suites: options.evalSuiteIds,
      modelId: options.modelId,
    });

    return {
      pipelineSlug,
      buildNumber: build.number,
      buildUrl: build.web_url,
      adopted: false,
    };
  }

  async waitForBuild(
    pipelineSlug: string,
    buildNumber: number,
    buildUrl: string,
  ): Promise<BuildkiteBuildResult> {
    return this.pollBuild(pipelineSlug, buildNumber, buildUrl);
  }

  async downloadArtifact(url: string): Promise<string | undefined> {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
      });
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    }
  }

  async getBuildState(pipelineSlug: string, buildNumber: number): Promise<string | undefined> {
    const build = await this.fetchBuild(pipelineSlug, buildNumber);
    return build?.state;
  }

  async triggerOnDemandEval(options: TriggerOnDemandOptions): Promise<BuildkiteBuildResult> {
    const triggered = await this.createOnDemandBuildOrAdopt(options);
    if (this.config.detachPoll) {
      return {
        buildUrl: triggered.buildUrl,
        buildNumber: triggered.buildNumber,
        status: 'running',
      };
    }
    return this.waitForBuild(
      triggered.pipelineSlug,
      triggered.buildNumber,
      triggered.buildUrl,
    );
  }

  private buildOnDemandEnv(options: TriggerOnDemandOptions): Record<string, string> {
    const evalSuiteId = options.evalSuiteIds[0];
    if (!evalSuiteId) {
      throw new Error('At least one eval suite id is required for on-demand Buildkite eval');
    }
    if (options.evalSuiteIds.length > 1) {
      this.logger.warn('On-demand Buildkite eval supports one suite per build; using first', {
        evalSuiteId,
        ignored: options.evalSuiteIds.slice(1),
      });
    }

    const connectorId = options.connectorId;
    if (!connectorId) {
      throw new Error('connectorId is required for on-demand Buildkite eval');
    }

    const env: Record<string, string> = {
      KIBANA_TESTING_AI_CONNECTORS: options.connectorJson,
      // Kibana run_suite.sh requires EVAL_SUITE_ID (singular), not LLM_EVAL_SUITES.
      EVAL_SUITE_ID: evalSuiteId,
      BENCHMARK_MODEL_ID: options.modelId,
      // Skip matrix fanout even when the pipeline step sets EVAL_FANOUT=1 (build env wins for unset step keys).
      EVAL_PROJECT: connectorId,
      EVAL_MODEL_GROUPS: options.modelId,
      EVALUATION_CONNECTOR_ID: connectorId,
    };

    if (this.config.kibanaBranch) {
      env['KIBANA_BRANCH'] = this.config.kibanaBranch;
    }

    return env;
  }

  private matchesBenchmarkerOptions(
    build: BuildkiteBuildResponse,
    options: TriggerOnDemandOptions,
  ): boolean {
    const suiteId = options.evalSuiteIds[0];
    if (!suiteId) return false;

    const env = build.env ?? {};
    const connectorId = options.connectorId;
    const connectorMatch =
      env['EVAL_PROJECT'] === connectorId ||
      env['EVALUATION_CONNECTOR_ID'] === connectorId;
    const suiteMatch = env['EVAL_SUITE_ID'] === suiteId;
    const modelMatch =
      env['BENCHMARK_MODEL_ID'] === options.modelId ||
      env['EVAL_MODEL_GROUPS'] === options.modelId;

    return connectorMatch && suiteMatch && modelMatch;
  }

  private isBenchmarkerBuildMessage(message: string | undefined): boolean {
    return (message ?? '').startsWith(BENCHMARKER_BUILD_MESSAGE_PREFIX);
  }

  private async findAdoptableRunningBuild(
    options: TriggerOnDemandOptions,
  ): Promise<BuildkiteTriggeredBuild | undefined> {
    const running = await this.listPipelineBuilds(this.config.onDemandPipelineSlug, 'running');

    for (const summary of running) {
      if (!this.isBenchmarkerBuildMessage(summary.message)) {
        continue;
      }

      const detail = await this.fetchBuild(
        this.config.onDemandPipelineSlug,
        summary.number,
      );
      if (!detail || !this.matchesBenchmarkerOptions(detail, options)) {
        continue;
      }

      return {
        pipelineSlug: this.config.onDemandPipelineSlug,
        buildNumber: detail.number,
        buildUrl: detail.web_url,
        adopted: true,
      };
    }

    return undefined;
  }

  private async waitForPipelineIdle(): Promise<void> {
    return this.waitForPipelineIdleOnSlug(this.config.onDemandPipelineSlug);
  }

  private async waitForPipelineIdleOnSlug(pipelineSlug: string): Promise<void> {
    const idleWaitMs = this.config.pipelineIdleWaitMs ?? this.pollTimeoutMs;
    const idlePollMs = this.config.pipelineIdlePollMs ?? this.pollIntervalMs;
    const deadline = Date.now() + idleWaitMs;

    while (Date.now() < deadline) {
      const running = await this.listPipelineBuilds(pipelineSlug, 'running');
      if (running.length === 0) {
        return;
      }

      this.logger.info('Buildkite: waiting for pipeline to become idle', {
        pipeline: pipelineSlug,
        runningBuilds: running.map((b) => ({
          number: b.number,
          message: (b.message ?? '').slice(0, 80),
        })),
        elapsedMs: idleWaitMs - (deadline - Date.now()),
      });

      await new Promise((r) => setTimeout(r, idlePollMs));
    }

    const stillRunning = await this.listPipelineBuilds(pipelineSlug, 'running');
    throw new Error(
      `Buildkite pipeline ${pipelineSlug} still has ${stillRunning.length} running build(s) after ${idleWaitMs}ms`,
    );
  }

  private async listPipelineBuilds(
    pipelineSlug: string,
    state: 'running' | 'scheduled',
  ): Promise<BuildkiteBuildResponse[]> {
    const url = `${this.apiBase}/pipelines/${pipelineSlug}/builds?state=${state}&per_page=10`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
      });
      if (!response.ok) {
        this.logger.warn('Buildkite list builds returned non-OK', {
          pipelineSlug,
          state,
          status: response.status,
        });
        return [];
      }
      const data: unknown = await response.json();
      return Array.isArray(data) ? (data as BuildkiteBuildResponse[]) : [];
    } catch (err) {
      this.logger.warn('Buildkite list builds failed', {
        pipelineSlug,
        state,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async fetchBuild(
    pipelineSlug: string,
    buildNumber: number,
  ): Promise<BuildkiteBuildResponse | undefined> {
    const url = `${this.apiBase}/pipelines/${pipelineSlug}/builds/${buildNumber}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
      });
      if (!response.ok) {
        return undefined;
      }
      return (await response.json()) as BuildkiteBuildResponse;
    } catch {
      return undefined;
    }
  }

  private async createBuild(
    pipelineSlug: string,
    message: string,
    env: Record<string, string>,
  ): Promise<BuildkiteBuildResponse> {
    const url = `${this.apiBase}/pipelines/${pipelineSlug}/builds`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commit: 'HEAD',
        branch: 'main',
        message,
        env,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Buildkite build creation failed (${response.status}): ${text}`);
    }

    return (await response.json()) as BuildkiteBuildResponse;
  }

  private async pollBuild(
    pipelineSlug: string,
    buildNumber: number,
    buildUrl: string,
  ): Promise<BuildkiteBuildResult> {
    const url = `${this.apiBase}/pipelines/${pipelineSlug}/builds/${buildNumber}`;
    const startTime = Date.now();

    while (Date.now() - startTime < this.pollTimeoutMs) {
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.config.apiToken}` },
        });

        if (!response.ok) {
          this.logger.warn('Buildkite poll returned non-OK', { status: response.status });
          await new Promise((r) => setTimeout(r, this.pollIntervalMs));
          continue;
        }

        const build = (await response.json()) as BuildkiteBuildResponse;

        if (isTerminalBuildkiteState(build.state)) {
          const artifacts = await this.fetchArtifacts(pipelineSlug, buildNumber);
          const status = buildResultStatusFromBuildkiteState(build.state);
          if (status === 'failed' && build.state !== 'failed') {
            this.logger.warn('Buildkite build ended in non-pass terminal state', {
              buildNumber,
              state: build.state,
            });
          }
          return { buildUrl, buildNumber, status, artifacts };
        }

        this.logger.debug('Buildkite build still running', {
          buildNumber,
          state: build.state,
          elapsedMs: Date.now() - startTime,
        });
      } catch (err) {
        this.logger.warn('Buildkite poll error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    this.logger.error('Buildkite poll timed out', { buildNumber, timeoutMs: this.pollTimeoutMs });
    return { buildUrl, buildNumber, status: 'running' };
  }

  private async fetchArtifacts(
    pipelineSlug: string,
    buildNumber: number,
  ): Promise<BuildkiteArtifact[]> {
    const url = `${this.apiBase}/pipelines/${pipelineSlug}/builds/${buildNumber}/artifacts`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiToken}` },
      });

      if (!response.ok) return [];

      const artifacts = (await response.json()) as BuildkiteArtifactResponse[];
      return artifacts.map((a) => ({ filename: a.filename, url: a.download_url }));
    } catch {
      return [];
    }
  }
}
