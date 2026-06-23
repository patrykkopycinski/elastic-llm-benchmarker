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
}

export interface TriggerOnDemandOptions {
  connectorJson: string;
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

  async triggerOnDemandEval(options: TriggerOnDemandOptions): Promise<BuildkiteBuildResult> {
    const { connectorJson, evalSuiteIds, modelId } = options;

    const env: Record<string, string> = {
      KIBANA_TESTING_AI_CONNECTORS: connectorJson,
      LLM_EVAL_SUITES: evalSuiteIds.join(','),
      BENCHMARK_MODEL_ID: modelId,
    };

    if (this.config.kibanaBranch) {
      env['KIBANA_BRANCH'] = this.config.kibanaBranch;
    }

    return this.triggerAndPoll(
      this.config.onDemandPipelineSlug,
      `Benchmarker: ${modelId} on-demand eval`,
      env,
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

    return this.triggerAndPoll(
      this.config.weeklyPipelineSlug,
      `Benchmarker: ${modelId} weekly eval`,
      env,
    );
  }

  private async triggerAndPoll(
    pipelineSlug: string,
    message: string,
    env: Record<string, string>,
  ): Promise<BuildkiteBuildResult> {
    const build = await this.createBuild(pipelineSlug, message, env);
    return this.pollBuild(pipelineSlug, build.number, build.web_url);
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
