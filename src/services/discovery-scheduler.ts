import type { ModelInfo } from '../types/benchmark.js';
import type { DiscoverySchedulerConfig } from '../types/config.js';
import type { ModelDiscoveryService } from './model-discovery.js';
import type { HardwareEstimator } from './hardware-estimator.js';
import type { HardwareProfileRegistry } from './hardware-profiles.js';
import type { QueueService } from './queue-service.js';
import type { HFModelConfig } from './hardware-estimator.js';
import type { ModelCandidateFilter } from './model-candidate-filter.js';
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
  /** ISO creation date from HuggingFace (used for recency / supersession). */
  createdAt: string | null;
  /** Normalized family key (org + base name, size/version/variant stripped). */
  family: string;
  /** True when a newer, hardware-fitting sibling in the same family exists. */
  superseded: boolean;
}

/**
 * A same-family sibling must be at least this much newer to supersede a model.
 * Separates a genuinely older generation (months apart) from same-generation
 * size variants (released together, e.g. Qwen3-Coder-30B vs -480B).
 */
const SUPERSEDE_MIN_AGE_GAP_MS = 30 * 24 * 60 * 60 * 1000;

/** Variant/quantization suffix tokens that never distinguish a model family. */
const FAMILY_VARIANT_TOKENS = new Set([
  'instruct', 'chat', 'it', 'base', 'preview', 'thinking', 'reasoner', 'reasoning',
  'fp8', 'fp16', 'bf16', 'awq', 'gptq', 'gguf', 'mlx', 'int3', 'int4', 'int8',
]);

function isSizeToken(token: string): boolean {
  // Dense size (7b, 1.5b, 32b), MoE active params (a3b, a22b), or NxMb (8x7b).
  return (
    /^\d+(\.\d+)?b$/.test(token) ||
    /^a\d+(\.\d+)?b$/.test(token) ||
    /^\d+x\d+(\.\d+)?b$/.test(token)
  );
}

/**
 * Derive a normalized family key from a model id, stripping the size, series
 * number, and variant/quantization suffixes so different generations of the
 * same family collapse together (e.g. `Qwen/Qwen2.5-Coder-32B-Instruct` and
 * `Qwen/Qwen3-Coder-30B-A3B-Instruct` both → `qwen/qwen-coder`).
 */
export function deriveModelFamily(modelId: string): string {
  const slash = modelId.indexOf('/');
  const org = (slash >= 0 ? modelId.slice(0, slash) : '').toLowerCase();
  const name = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
  const tokens = name.split(/[-_.]/).filter(Boolean);
  const kept: string[] = [];
  tokens.forEach((tok, i) => {
    if (i === 0) {
      // Strip a series number glued to the root token: qwen2→qwen, llama3→llama.
      kept.push(tok.replace(/\d+$/, '') || tok);
      return;
    }
    if (isSizeToken(tok)) return;
    if (FAMILY_VARIANT_TOKENS.has(tok)) return;
    if (/^v?\d+(\.\d+)*$/.test(tok)) return; // standalone version token (2.5, 3, 3.1, v2)
    kept.push(tok);
  });
  const familyName = kept.join('-') || name;
  return org ? `${org}/${familyName}` : familyName;
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
  /** Optional pre-deploy filter (e.g. Agent Builder baseline). */
  candidateFilter?: ModelCandidateFilter;
  /** Fire-and-forget callback to pre-download model weights on the GPU VM. */
  weightPrefetcher?: (modelId: string) => void;
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
      const recentlyTerminal = await this.recentlyTerminalModelIds();
      const stats = await this.autoQueue(scored, recentlyTerminal);

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

        if (this.deps.candidateFilter) {
          const filterResult = this.deps.candidateFilter.evaluate(model);
          if (!filterResult.passed) {
            this.logger.debug(
              `Skipping ${model.id}: Agent Builder baseline — ${filterResult.rejections.map((r) => r.criterion).join(', ')}`,
            );
            continue;
          }
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
          createdAt: createdAt ? createdAt.toISOString() : null,
          family: deriveModelFamily(model.id),
          superseded: false,
        });
      } catch (err) {
        this.logger.debug(`Skipping ${model.id}: error during scoring: ${String(err)}`);
        // Continue to next model; never throw
      }
    }

    this.markSupersededByFamily(scored);
    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored;
  }

  /**
   * Flag models that a newer, hardware-fitting sibling in the same family has
   * superseded. Prevents a stale generation (e.g. Qwen2.5-Coder) from winning a
   * benchmarking slot over a newer sibling that fits the same hardware. The
   * flag is advisory for scoring; {@link autoQueue} skips superseded models.
   */
  private markSupersededByFamily(scored: ScoredModel[]): void {
    const byFamily = new Map<string, ScoredModel[]>();
    for (const model of scored) {
      const group = byFamily.get(model.family);
      if (group) group.push(model);
      else byFamily.set(model.family, [model]);
    }

    for (const group of byFamily.values()) {
      if (group.length < 2) continue;
      for (const model of group) {
        const modelMs = model.createdAt ? Date.parse(model.createdAt) : NaN;
        if (Number.isNaN(modelMs)) continue;
        const hasNewerFittingSibling = group.some((other) => {
          if (other === model || !other.hardwareFit) return false;
          const otherMs = other.createdAt ? Date.parse(other.createdAt) : NaN;
          return !Number.isNaN(otherMs) && otherMs - modelMs >= SUPERSEDE_MIN_AGE_GAP_MS;
        });
        if (hasNewerFittingSibling) {
          model.superseded = true;
          this.logger.info('Discovery: model superseded by a newer same-family release', {
            modelId: model.id,
            family: model.family,
          });
        }
      }
    }
  }

  /**
   * Enqueues scored models that have not yet been evaluated.
   *
   * When `autoQueue` is disabled, returns all models as skipped.
   * Never throws.
   */
  /**
   * Model ids that reached a terminal state (completed/failed) within the
   * configured freshness window. Skipping these keeps discovery from spending
   * cost-cap budget re-benchmarking a just-evaluated or quarantined model. An
   * ES error fails open (empty set) so discovery is never blocked. Returns an
   * empty set when the freshness filter is disabled (0 days).
   */
  private async recentlyTerminalModelIds(): Promise<ReadonlySet<string>> {
    const days = this.deps.config.skipRecentlyBenchmarkedDays ?? 30;
    if (days <= 0) return new Set();
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    try {
      return await this.deps.queueService.findRecentTerminalModelIds(sinceIso);
    } catch (err) {
      this.logger.warn('Discovery: recent-terminal dedup query failed (failing open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Set();
    }
  }

  async autoQueue(
    scoredModels: ScoredModel[],
    skipModelIds: ReadonlySet<string> = new Set(),
  ): Promise<AutoQueueResult> {
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

        if (skipModelIds.has(model.id)) {
          this.logger.debug(
            `Skipping ${model.id}: benchmarked or quarantined within the freshness window`,
          );
          skipped++;
          continue;
        }

        if (model.superseded) {
          this.logger.debug(
            `Skipping ${model.id}: superseded by a newer same-family release that fits the hardware`,
          );
          skipped++;
          continue;
        }

        const priority = scoredModels.length - index;
        await this.deps.queueService.enqueue(model.id, 'discovery', priority, undefined, {
          trendingScore: model.trendingScore,
          hardwareFit: model.hardwareFit,
        });
        this.deps.weightPrefetcher?.(model.id);
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
      // Push the Agent Builder baseline floors (context + parameter count)
      // into discovery so the candidate list fills with qualifying large
      // models instead of stopping early on small, high-download ones that
      // the downstream filter would only reject.
      const filter = this.deps.candidateFilter;
      const minParamBillions = filter?.getMinParameterCountBillions();
      const result = await this.deps.discoveryService.discover({
        limit: this.deps.config.maxModelsPerRun * 3,
        search: this.deps.config.search,
        sort: this.deps.config.sort,
        ...(filter ? { minContextWindow: filter.getMinContextWindow() } : {}),
        ...(minParamBillions
          ? { minParameterCount: minParamBillions * 1_000_000_000 }
          : {}),
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
