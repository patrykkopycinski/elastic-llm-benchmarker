/**
 * One-off smoke: run a single MaintenanceScheduler tick against the real
 * cluster and confirm a benchmarker-vm-cost snapshot lands. Never enqueues or
 * touches the GPU VM. Run: npx tsx scripts/smoke-maintenance.ts
 */
import { Client } from '@elastic/elasticsearch';
import { loadConfig } from '../src/config/index.js';
import { ensureIndices, INDEX_NAMES } from '../src/services/es-index-mappings.js';
import { QueueService } from '../src/services/queue-service.js';
import { ElasticsearchResultsStore } from '../src/services/elasticsearch-results-store.js';
import { MaintenanceScheduler } from '../src/services/maintenance-scheduler.js';
import { createLogger } from '../src/utils/logger.js';

async function main(): Promise<void> {
  const config = loadConfig(undefined, { configPath: 'config/local.json' });
  const es = config.elasticsearch;
  const esClient = new Client({
    ...(es.cloudId ? { cloud: { id: es.cloudId } } : { node: es.url }),
    ...(es.apiKey ? { auth: { apiKey: es.apiKey } } : {}),
    ...(es.username && es.password ? { auth: { username: es.username, password: es.password } } : {}),
  });

  await ensureIndices(esClient);
  const queueService = new QueueService(esClient);
  const resultsStore = new ElasticsearchResultsStore(esClient);
  await resultsStore.initialize();

  const scheduler = new MaintenanceScheduler({
    esClient,
    queueService,
    resultsStore,
    config: config.maintenance,
    costCaps: config.costCaps,
    vmHost: config.ssh.host,
    hardwareProfileId: config.discoveryScheduler.hardwareProfileId,
    logger: createLogger(config.logLevel ?? 'info'),
  });

  const result = await scheduler.runOnce();
  console.log('\n=== maintenance tick result ===');
  console.log(JSON.stringify(result, null, 2));

  // Refresh so the just-written snapshot is searchable, then read it back.
  await esClient.indices.refresh({ index: INDEX_NAMES.BENCHMARKER_VM_COST }).catch(() => undefined);
  const search = await esClient.search({
    index: INDEX_NAMES.BENCHMARKER_VM_COST,
    size: 1,
    sort: [{ '@timestamp': { order: 'desc' } }],
  });
  const hit = search.hits.hits[0]?._source;
  console.log('\n=== latest benchmarker-vm-cost doc ===');
  console.log(hit ? JSON.stringify(hit, null, 2) : 'NONE FOUND');
  process.exit(hit ? 0 : 2);
}

main().catch((err) => {
  console.error('smoke-maintenance failed:', err);
  process.exit(1);
});
