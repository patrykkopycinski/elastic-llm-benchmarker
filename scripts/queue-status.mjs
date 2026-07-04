import { loadConfig } from '../dist/index.js';
import { Client } from '@elastic/elasticsearch';

const config = loadConfig(undefined, { configPath: 'config/local.json' });
const client = new Client({
  node: config.elasticsearch.url,
  auth: config.elasticsearch.apiKey
    ? { apiKey: config.elasticsearch.apiKey }
    : config.elasticsearch.username
      ? { username: config.elasticsearch.username, password: config.elasticsearch.password ?? '' }
      : undefined,
});

const index = 'benchmarker-queue';
const agg = await client.search({
  index,
  size: 0,
  aggs: { by_status: { terms: { field: 'status', size: 20 } } },
});
console.log('=== queue by status ===');
for (const b of agg.aggregations?.by_status?.buckets ?? []) {
  console.log(`  ${b.key}: ${b.doc_count}`);
}

const recent = await client.search({
  index,
  size: 15,
  sort: [{ completed_at: { order: 'desc', missing: '_last' } }, { requested_at: { order: 'desc' } }],
  _source: ['model_id', 'status', 'priority', 'source', 'error_message', 'completed_at', 'metadata'],
});
console.log('\n=== 15 most recently updated ===');
for (const h of recent.hits.hits) {
  const s = h._source;
  const retry = s.metadata?.infra_retry_count ?? s.metadata?.infraRetryCount ?? 0;
  console.log(
    `  [${s.status}] ${s.model_id}  (src=${s.source}, prio=${s.priority}, retry=${retry})` +
      (s.error_message ? `\n      err: ${String(s.error_message).slice(0, 140)}` : ''),
  );
}
process.exit(0);
