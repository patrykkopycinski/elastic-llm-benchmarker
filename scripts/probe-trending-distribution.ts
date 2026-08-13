import dotenv from 'dotenv';
import { ModelDiscoveryService } from '../src/services/model-discovery.js';
import { HardwareEstimator } from '../src/services/hardware-estimator.js';
import { HardwareProfileRegistry } from '../src/services/hardware-profiles.js';
import { DiscoveryScheduler, type ScoredModel } from '../src/services/discovery-scheduler.js';
import { ModelCandidateFilter } from '../src/services/model-candidate-filter.js';
import type { DiscoverySchedulerConfig } from '../src/types/config.js';
import { createLogger } from '../src/utils/logger.js';

dotenv.config();

// Mirrors the i9's live config/local.json discoveryScheduler + agentBuilderBaseline
// blocks exactly (fetched via scp 2026-07-29). Read-only dry run: no QueueService,
// no autoQueue call — never enqueues.
const discoveryConfig: DiscoverySchedulerConfig = {
  enabled: true,
  intervalMinutes: 1440,
  maxModelsPerRun: 10,
  minTrendingScore: 30,
  autoQueue: true,
  hardwareProfileId: '2xa100-80gb',
  fallbackSearchProbes: ['instruct', 'glm-4.5', 'mistral small', 'mixtral'],
  skipRecentlyBenchmarkedDays: 1,
} as DiscoverySchedulerConfig;

const profileRegistry = new HardwareProfileRegistry();
const profile = profileRegistry.getProfile(discoveryConfig.hardwareProfileId);
const discoveryService = new ModelDiscoveryService(
  process.env.HUGGINGFACE_TOKEN ?? '',
  [],
  'warn',
  profile?.hardware,
);
const candidateFilter = new ModelCandidateFilter('warn', {
  minContextWindow: 128000,
  targetHardwareProfile: profile?.hardware,
  requireToolCalling: true,
  minParameterCountBillions: 24,
  requireInstructVariant: true,
  checkKnownFailures: true,
});

const logger = createLogger('warn');
const scheduler = new DiscoveryScheduler({
  discoveryService,
  hardwareEstimator: new HardwareEstimator(),
  profileRegistry,
  queueService: undefined as any, // never reached: autoQueue() not called
  config: discoveryConfig,
  candidateFilter,
  logger,
});

const scored: ScoredModel[] = await scheduler.discoverAndScore();

console.log(`\n=== discoverAndScore() dry-run: ${scored.length} candidates scored ===`);
const hwFit = scored.filter((m) => m.hardwareFit);
console.log(`hardware-fit: ${hwFit.length}/${scored.length}`);
console.log(`>= minTrendingScore (30): ${scored.filter((m) => m.trendingScore >= 30).length}`);

const scores = scored.map((m) => m.trendingScore).sort((a, b) => a - b);
if (scores.length > 0) {
  const pct = (p: number) => scores[Math.min(scores.length - 1, Math.floor((p / 100) * scores.length))];
  console.log('\nTrending score distribution (all scored candidates):');
  console.log(`  min=${scores[0].toFixed(2)} p25=${pct(25).toFixed(2)} p50=${pct(50).toFixed(2)} p75=${pct(75).toFixed(2)} p90=${pct(90).toFixed(2)} max=${scores[scores.length - 1].toFixed(2)}`);
}

console.log('\nTop 15 by totalScore:');
for (const m of scored.slice(0, 15)) {
  console.log(`  ${m.trendingScore.toFixed(2).padStart(6)}  hwFit=${String(m.hardwareFit).padEnd(5)}  ${m.id}`);
}

console.log('\nUnique ids:', new Set(scored.map((m) => m.id)).size, 'of', scored.length);
