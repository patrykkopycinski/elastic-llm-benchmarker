import type { ModelInfo } from '../types/benchmark.js';
import type { DiscoverySchedulerConfig } from '../types/config.js';
import type { ModelDiscoveryService } from './model-discovery.js';
import type { HardwareEstimator } from './hardware-estimator.js';
import type { HardwareProfileRegistry } from './hardware-profiles.js';
import type { QueueService } from './queue-service.js';
import type { HFModelConfig } from './hardware-estimator.js';
import type { Logger } from 'winston';
import { createLogger } from '../utils/logger.js';

/**
 * A model candidate enriched with trending and hardware-fit scores.
 */
export interface ScoredModel extends ModelInfo {
  /** Trending score (0–100) */
  trendingScore: number;
  /** Whether the model fits the configured hardware profile */
  hardwareFit: boolean;
  /** Combined score: trending * 0.6 + hardware bonus (0 or 40) */
  totalScore: number;
}

/**
 * Dependencies required by DiscoveryScheduler.
 */
export interface DiscoverySchedulerDependencies {
  discoveryService: ModelDiscoveryService;
  hardwareEstimator: HardwareEstimator;
  profileRegistry: HardwareProfileRegistry;
  queueService: QueueService;
  config: DiscoverySchedulerConfig;
  logger?: Logger;
}

/**
 * Result of a single auto-queue run.
 */
export interface AutoQueueResult {
  queued: number;
  skipped: number;
  errors: number;
}

/**
 * Result of a single discovery-and-queue cycle.
 */
export interface RunOnceResult {
  discovered: number;
  queued: number;
  skipped: number;
  errors: number;
  hardwareFitCount: number;
}

const RETRY_DELAY_MS = 60_000;

/**
 * Orchestrates periodic model discovery, trending-score computation,
 * hardware-fit checks, and automatic queueing.
 *
 * All public async methods are guaranteed never to throw;
 * errors are logged and absorbed into result counters or empty arrays.
 */
export class DiscoveryScheduler {
  private readonly deps: DiscoverySchedulerDependencies;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;

  get isRunning(): boolean {
    return this._isRunning;
  }
  constructor(deps: DiscoverySchedulerDependencies) {
    this.deps = deps;
    this.logger = deps.logger ?? createLogger('info');
  }

  /**
   * Starts the periodic discovery interval. The first run executes
   * immediately; subsequent runs occur every `intervalMinutes`.
   * Guarded against double-start.
   */
  start(): void {
    if (this._isRunning) {
      this.logger.warn('Discovery scheduler is already running');
      return;
    }
    this._isRunning = true;
    this.logger.info('DiscoveryScheduler started', {
      intervalMinutes: this.deps.config.intervalMinutes,
    });
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.deps.config.intervalMinutes * 60 * 1000);
  }

  /**
   * Stops the periodic discovery interval.
   * Guarded against double-stop.
   */
  stop(): void {
    if (!this._isRunning) {
      this.logger.warn('Discovery scheduler is not running');
      return;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._isRunning = false;
    this.logger.info('DiscoveryScheduler stopped');
  }

  /**
   * Runs one full discovery → score → (optional) queue cycle.
   * Never throws.
   */
  async runOnce(): Promise<RunOnceResult> {
    try {
      const scored = await this.discoverAndScore();
      const stats = await this.autoQueue(scored);

      return {
        discovered: scored.length,
        queued: stats.queued,
        skipped: stats.skipped,
        errors: stats.errors,
        hardwareFitCount: scored.filter((m) => m.hardwareFit).length,
      };
    } catch (err) {
      this.logger.error(`runOnce failed unexpectedly: ${String(err)}`);
      return { discovered: 0, queued: 0, skipped: 0, errors: 0, hardwareFitCount: 0 };
    }
  }

  /**
   * Discovers models, computes trending scores, checks hardware fit,
   * and returns a sorted list of scored candidates.
   *
   * If the HuggingFace API returns a 429 status, the method waits
   * 60 seconds and retries once. If the retry also fails, it returns
   * an empty array.
   *
   * Never throws.
   */
  async discoverAndScore(): Promise<ScoredModel[]> {
    let discoveryResult: { models: ModelInfo[] } | null = await this.tryDiscover();

    if (discoveryResult === null) {
      this.logger.warn('HF API rate limited (429), waiting 60s before retry');
      await this.delay(RETRY_DELAY_MS);
      discoveryResult = await this.tryDiscover();
      if (discoveryResult === null) {
        this.logger.warn('HF API still rate limited after retry, returning empty array');
        return [];
      }
    }

    const profile = this.deps.profileRegistry.getProfile(this.deps.config.hardwareProfileId);
    if (!profile) {
      this.logger.error(
        `Hardware profile not found: ${this.deps.config.hardwareProfileId}, skipping hardware checks`,
      );
    }

    const scored: ScoredModel[] = [];

    for (const model of discoveryResult.models) {
      try {
        const config = await this.deps.discoveryService.fetchModelConfig(model.id);
        if (!config) {
          this.logger.debug(`Skipping ${model.id}: config.json fetch failed`);
          continue;
        }

        const entry = await this.deps.discoveryService.fetchModelInfo(model.id);
        const downloads =
          typeof (entry as unknown as Record<string, unknown>)?.downloads === 'number'
            ? ((entry as unknown as Record<string, unknown>).downloads as number)
            : 0;
        const createdAtRaw =
          ((entry as unknown as Record<string, unknown>).createdAt as string | undefined) ??
          ((entry as unknown as Record<string, unknown>).created_at as string | undefined);
        const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;

        const daysSinceCreation = createdAt
          ? Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)))
          : 30;

        const likesPerDay = downloads / daysSinceCreation;
        const downloadsGrowth = Math.log10(downloads + 1) * 10;
        const recencyScore = daysSinceCreation <= 30 ? 100 : daysSinceCreation <= 90 ? 50 : 10;
        const rawTrending = likesPerDay * 0.5 + downloadsGrowth * 0.3 + recencyScore * 0.2;
        const trendingScore = Math.min(100, Math.max(0, rawTrending));

        if (trendingScore < this.deps.config.minTrendingScore) {
          this.logger.debug(
            `Skipping ${model.id}: trendingScore ${trendingScore.toFixed(2)} < ${this.deps.config.minTrendingScore}`,
          );
          continue;
        }

        let fits = true;
        if (profile) {
          const dryRun = this.deps.hardwareEstimator.dryRunCheck(
            config as HFModelConfig,
            profile.hardware,
          );
          fits = dryRun.fits;
        }

        const rawTotal = trendingScore * 0.6 + (fits ? 40 : 0);
        const totalScore = Math.min(100, Math.max(0, rawTotal));

        scored.push({
          ...model,
          trendingScore: Math.round(trendingScore * 100) / 100,
          hardwareFit: fits,
          totalScore: Math.round(totalScore * 100) / 100,
        });
      } catch (err) {
        this.logger.debug(`Skipping ${model.id}: error during scoring: ${String(err)}`);
        // Continue to next model; never throw
      }
    }

    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored;
  }

  /**
   * Enqueues scored models that have not yet been evaluated.
   *
   * When `autoQueue` is disabled, returns all models as skipped.
   * Never throws.
   */
  async autoQueue(scoredModels: ScoredModel[]): Promise<AutoQueueResult> {
    if (!this.deps.config.autoQueue) {
      return { queued: 0, skipped: scoredModels.length, errors: 0 };
    }

    let queued = 0;
    let skipped = 0;
    let errors = 0;

    let index = 0;
    for (const model of scoredModels) {
      try {
        if (this.deps.discoveryService.isEvaluated(model.id)) {
          skipped++;
          continue;
        }

        const priority = scoredModels.length - index;
        await this.deps.queueService.enqueue(model.id, 'discovery', priority, undefined, {
          trendingScore: model.trendingScore,
          hardwareFit: model.hardwareFit,
        });
        queued++;
      } catch (err) {
        this.logger.warn(`Failed to enqueue ${model.id}: ${String(err)}`);
        errors++;
      }
      index++;
    }

    return { queued, skipped, errors };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async tryDiscover(): Promise<{ models: ModelInfo[] } | null> {
    try {
      const result = await this.deps.discoveryService.discover({
        limit: this.deps.config.maxModelsPerRun * 3,
        search: this.deps.config.search,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429')) {
        return null;
      }
      this.logger.warn(`Discovery failed: ${msg}`);
      return { models: [] };
    }
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
