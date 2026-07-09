/**
 * READ-ONLY DLQ sweep preview. Mirrors MaintenanceScheduler.sweepDlq exactly
 * (findFailedEntries → classifyFailure → cap) but writes NOTHING, so it can be
 * run any day to forecast what the date-gated 07-06 sweep will re-enqueue —
 * without triggering surprise GPU benchmarks.
 *
 * Run: npx tsx scripts/dryrun-dlq-sweep.ts
 */
import { Client } from '@elastic/elasticsearch';
import { loadConfig } from '../src/config/index.js';
import { QueueService } from '../src/services/queue-service.js';
import { classifyFailure } from '../src/utils/failure-classifier.js';

async function main(): Promise<void> {
  const config = loadConfig(undefined, { configPath: 'config/local.json' });
  const es = config.elasticsearch;
  const esClient = new Client({
    ...(es.cloudId ? { cloud: { id: es.cloudId } } : { node: es.url }),
    ...(es.apiKey ? { auth: { apiKey: es.apiKey } } : {}),
    ...(es.username && es.password ? { auth: { username: es.username, password: es.password } } : {}),
  });
  const queue = new QueueService(esClient);

  const days = config.maintenance.dlqRetryAfterDays;
  const cap = config.maintenance.dlqMaxRequeuePerSweep;
  const nowMs = Date.now();

  // Universe: every failed entry (beforeIso = now).
  const all = await queue.findFailedEntries(new Date(nowMs).toISOString(), 500);

  // What the DEFAULT window sweep would select if run *right now* (07-04).
  const beforeNow = new Date(nowMs - days * 24 * 3600_000).toISOString();
  // What the sweep will select when it runs on 07-06 (its boot tick ~20:22Z).
  const jul06 = Date.parse('2026-07-06T20:22:00.000Z');
  const beforeJul06 = new Date(jul06 - days * 24 * 3600_000).toISOString();

  const classify = (e: (typeof all)[number]) => classifyFailure(e.errorMessage);

  console.log(`DLQ config: dlqRetryAfterDays=${days}, dlqMaxRequeuePerSweep=${cap}`);
  console.log(`Total failed entries: ${all.length}\n`);

  // Per-entry classification (universe).
  const retriable = all.filter((e) => classify(e).retriable);
  const quarantined = all.filter((e) => !classify(e).retriable);
  console.log(`Retriable (would eventually re-queue): ${retriable.length}`);
  console.log(`Quarantined (never auto-retried):      ${quarantined.length}\n`);

  const fmt = (e: (typeof all)[number]) => {
    const c = classify(e);
    const msg = (e.errorMessage ?? '').slice(0, 70).replace(/\s+/g, ' ');
    return `  [${c.category}${c.retriable ? ' ↻' : ' ⛔'}] ${e.modelId}\n      completed=${e.completedAt} :: ${msg}`;
  };

  console.log('--- RETRIABLE ---');
  retriable.forEach((e) => console.log(fmt(e)));
  console.log('\n--- QUARANTINED (sample of 10) ---');
  quarantined.slice(0, 10).forEach((e) => console.log(fmt(e)));

  // Faithful sweep selection for two reference points.
  const selectFor = (beforeIso: string): string[] =>
    all
      .filter((e) => (e.completedAt ?? '') <= beforeIso)
      .filter((e) => classify(e).retriable)
      .slice(0, cap)
      .map((e) => e.modelId);

  console.log(`\n=== SWEEP FORECAST (window=${days}d, cap=${cap}) ===`);
  console.log(`If run TODAY (before ${beforeNow}): would re-queue ${selectFor(beforeNow).length}`);
  selectFor(beforeNow).forEach((m) => console.log(`    ↻ ${m}`));
  console.log(`On 07-06 tick   (before ${beforeJul06}): would re-queue ${selectFor(beforeJul06).length}`);
  selectFor(beforeJul06).forEach((m) => console.log(`    ↻ ${m}`));
  console.log('\n(READ-ONLY — nothing was written to ES.)');
  process.exit(0);
}

main().catch((err) => {
  console.error('dryrun-dlq-sweep failed:', err);
  process.exit(1);
});
