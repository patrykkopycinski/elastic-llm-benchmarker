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
  /**
   * Raw Buildkite terminal state (passed|failed|canceled|skipped|not_run) when the build
   * reached a terminal state. Lets callers distinguish an infra outcome (skipped/canceled —
   * the eval never ran) from a genuine eval `failed`.
   */
  terminalState?: string;
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

/**
 * Terminal states where the build was preempted by Buildkite rather than actually running
 * the eval. `skip_queued_branch_builds: true` on the pipeline silently skips a queued build
 * (state `skipped`) when a newer/other build is active on the same branch; `not_run` is the
 * analogous "never executed" outcome. These are transient infra outcomes and should be
 * re-triggered, not counted as a model/eval `failed`. `canceled` is deliberately excluded:
 * an operator cancelling a build on Buildkite is a terminal decision, not an infra hiccup,
 * so it must not be auto-re-triggered up to maxSkipRetries times.
 */
const RETRIABLE_INFRA_BUILDKITE_STATES = new Set(['skipped', 'not_run']);

export function isRetriableInfraState(state: string | undefined): boolean {
  return state !== undefined && RETRIABLE_INFRA_BUILDKITE_STATES.has(state);
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
      const active = await this.listActivePipelineBuilds(pipelineSlug);
      if (active.length === 0) {
        return;
      }

      this.logger.info('Buildkite: waiting for pipeline to become idle', {
        pipeline: pipelineSlug,
        activeBuilds: active.map((b) => ({
          number: b.number,
          state: b.state,
          message: (b.message ?? '').slice(0, 80),
        })),
        elapsedMs: idleWaitMs - (deadline - Date.now()),
      });

      await new Promise((r) => setTimeout(r, idlePollMs));
    }

    const stillActive = await this.listActivePipelineBuilds(pipelineSlug);
    throw new Error(
      `Buildkite pipeline ${pipelineSlug} still has ${stillActive.length} active build(s) after ${idleWaitMs}ms`,
    );
  }

  /**
   * Builds that are `running` OR `scheduled` (queued/creating) both occupy the branch. With
   * `skip_queued_branch_builds: true`, POSTing a new build while another is still scheduled on
   * the same branch causes Buildkite to silently skip the older queued build — so both states
   * must clear before we create the next suite's build. The previous idle check only looked at
   * `running`, leaving a race where a still-`scheduled` build got skipped.
   */
  private async listActivePipelineBuilds(
    pipelineSlug: string,
  ): Promise<BuildkiteBuildResponse[]> {
    const [running, scheduled] = await Promise.all([
      this.listPipelineBuilds(pipelineSlug, 'running'),
      this.listPipelineBuilds(pipelineSlug, 'scheduled'),
    ]);
    const byNumber = new Map<number, BuildkiteBuildResponse>();
    for (const build of [...running, ...scheduled]) {
      byNumber.set(build.number, build);
    }
    return [...byNumber.values()];
  }

  private async listPipelineBuilds(
    pipelineSlug: string,
    state: 'running' | 'scheduled',
  ): Promise<BuildkiteBuildResponse[]> {
    // `skip_queued_branch_builds` is branch-scoped, so the idle guard must only consider
    // builds on OUR branch. Without the branch filter, foreign-branch running/scheduled builds
    // (other teams, PR CI) would block idle-wait for up to pipelineIdleWaitMs (default 3h) and
    // then throw, failing the whole CI eval even though our branch was clear the whole time.
    const branch = this.config.kibanaBranch ?? 'fix/weekly-evals-matrix';
    const url = `${this.apiBase}/pipelines/${pipelineSlug}/builds?state=${state}&branch=${encodeURIComponent(branch)}&per_page=10`;

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
    const body = JSON.stringify({
      commit: 'HEAD',
      // The benchmarker-injected vLLM connector bypass (BENCHMARK_MODEL_ID) lives in
      // .buildkite/scripts/steps/evals/setup_connectors.sh on fix/weekly-evals-matrix (PR #274606).
      // Until that lands on main, builds must run on this branch or LiteLLM generation overwrites
      // the injected KIBANA_TESTING_AI_CONNECTORS and the eval fails with "connector not found".
      branch: this.config.kibanaBranch ?? 'fix/weekly-evals-matrix',
      message,
      env,
    });

    // Retry transient network errors (fetch failed, ECONNRESET, ETIMEDOUT). A single
    // blip here otherwise propagates to pollWeeklyMatrix.catch(), which tears down the
    // vLLM deployment and abandons the run mid-flight (observed: 2026-06-30 run).
    const MAX_ATTEMPTS = 4;
    const BASE_DELAY_MS = 2_000;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            'Content-Type': 'application/json',
          },
          body,
        });

        if (!response.ok) {
          const text = await response.text();
          // 4xx (except 408/429) are not transient — surface immediately.
          if (response.status >= 400 && response.status < 500 &&
              response.status !== 408 && response.status !== 429) {
            throw new Error(`Buildkite build creation failed (${response.status}): ${text}`);
          }
          throw new Error(`Buildkite build creation failed (${response.status}): ${text}`);
        }

        return (await response.json()) as BuildkiteBuildResponse;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const transient = msg.includes('fetch failed') ||
          msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
          msg.includes('ENOTFOUND') || msg.includes('network') ||
          /failed \(4[08]0\)/.test(msg) || /failed \(5\d\d\)/.test(msg);
        if (!transient || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.warn('Buildkite createBuild: transient error, retrying', {
          attempt, maxAttempts: MAX_ATTEMPTS, delayMs: delay, error: msg,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('createBuild exhausted retries');
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
          return { buildUrl, buildNumber, status, terminalState: build.state, artifacts };
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
