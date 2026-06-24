import { createLogger } from '../utils/logger.js';
import type { Logger } from 'winston';

export interface BuildkiteConfig {
  apiToken: string;
  orgSlug: string;
  onDemandPipelineSlug: string;
  weeklyPipelineSlug: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  retryOnFailure?: boolean;
  defaultEvalSuites?: string[];
  kibanaBranch?: string;
  /** Poll in background; caller keeps tunnel/model alive until poll completes. */
  detachPoll?: boolean;
}

export interface BuildkiteTriggeredBuild {
  pipelineSlug: string;
  buildNumber: number;
  buildUrl: string;
}

export interface TriggerOnDemandOptions {
  connectorJson: string;
  connectorId: string;
  evalSuiteIds: string[];
  modelId: string;
}

export interface TriggerWeeklyOptions {
  connectorJson: string;
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

export interface BuildkiteEvalTrigger {
  triggerOnDemandEval(options: TriggerOnDemandOptions): Promise<BuildkiteBuildResult>;
  triggerWeeklyEval(options: TriggerWeeklyOptions): Promise<BuildkiteBuildResult>;
  /** Create a build without waiting for completion. */
  createOnDemandBuild(options: TriggerOnDemandOptions): Promise<BuildkiteTriggeredBuild>;
  /** Poll an existing build until terminal state or timeout. */
  waitForBuild(
    pipelineSlug: string,
    buildNumber: number,
    buildUrl: string,
  ): Promise<BuildkiteBuildResult>;
  /** Download artifact body text (requires API token). */
  downloadArtifact(url: string): Promise<string | undefined>;
}

interface BuildkiteBuildResponse {
  number: number;
  web_url: string;
  state: string;
}

interface BuildkiteArtifactResponse {
  filename: string;
  download_url: string;
}

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
      `Benchmarker: ${options.modelId} on-demand eval`,
      this.buildOnDemandEnv(options),
    );
    return {
      pipelineSlug: this.config.onDemandPipelineSlug,
      buildNumber: build.number,
      buildUrl: build.web_url,
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

  async triggerOnDemandEval(options: TriggerOnDemandOptions): Promise<BuildkiteBuildResult> {
    const triggered = await this.createOnDemandBuild(options);
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

  async triggerWeeklyEval(options: TriggerWeeklyOptions): Promise<BuildkiteBuildResult> {
    const { connectorJson, modelId } = options;

    const env: Record<string, string> = {
      KIBANA_TESTING_AI_CONNECTORS: connectorJson,
      BENCHMARK_MODEL_ID: modelId,
    };

    if (this.config.kibanaBranch) {
      env['KIBANA_BRANCH'] = this.config.kibanaBranch;
    }

    const build = await this.createBuild(
      this.config.weeklyPipelineSlug,
      `Benchmarker: ${modelId} weekly eval`,
      env,
    );

    if (this.config.detachPoll) {
      return {
        buildUrl: build.web_url,
        buildNumber: build.number,
        status: 'running',
      };
    }

    return this.pollBuild(this.config.weeklyPipelineSlug, build.number, build.web_url);
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
        branch: this.config.kibanaBranch ?? 'main',
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

        if (build.state === 'passed') {
          const artifacts = await this.fetchArtifacts(pipelineSlug, buildNumber);
          return { buildUrl, buildNumber, status: 'passed', artifacts };
        }

        if (build.state === 'failed' || build.state === 'canceled') {
          const artifacts = await this.fetchArtifacts(pipelineSlug, buildNumber);
          return { buildUrl, buildNumber, status: 'failed', artifacts };
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
