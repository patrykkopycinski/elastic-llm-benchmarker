#!/usr/bin/env tsx
/**
 * One-off migration: copy benchmarker data from the local/stateful ES cluster
 * into the serverless ES project.
 *
 * Source (local) connection comes from SOURCE_ES_* env vars.
 * Destination (serverless) connection comes from the loaded app config, i.e.
 * ELASTICSEARCH_URL + ELASTICSEARCH_API_KEY in .env.
 *
 * Destination indices are created with proper mappings via
 * ElasticsearchResultsStore.initialize() (serverless-aware) before any docs are
 * copied. Docs are streamed with scroll + bulk (small dataset, ~1 MB).
 *
 * Usage:
 *   SOURCE_ES_URL=http://localhost:9223 SOURCE_ES_USERNAME=elastic \
 *   SOURCE_ES_PASSWORD=changeme tsx src/scripts/migrate-es-to-serverless.ts
 *
 *   # optional: --dry-run to only report source doc counts
 */

import { Client } from '@elastic/elasticsearch';
import { loadConfig } from '../config/index.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger();

/** Index name patterns this benchmarker owns on the source cluster. */
const SOURCE_INDEX_PATTERNS = 'benchmarker-*,recommendation-*';

interface CatIndexRow {
  index?: string;
  'docs.count'?: string;
}

function buildSourceClient(): Client {
  const url = process.env['SOURCE_ES_URL'] ?? 'http://localhost:9223';
  const apiKey = process.env['SOURCE_ES_API_KEY'];
  const username = process.env['SOURCE_ES_USERNAME'] ?? 'elastic';
  const password = process.env['SOURCE_ES_PASSWORD'] ?? 'changeme';
  return new Client({
    node: url,
    auth: apiKey ? { apiKey } : { username, password },
  });
}

function buildDestClient(): Client {
  const config = loadConfig();
  const es = config.elasticsearch;
  const auth = es.apiKey
    ? { apiKey: es.apiKey }
    : es.username && es.password
      ? { username: es.username, password: es.password }
      : undefined;
  if (!auth) {
    throw new Error(
      'Destination ES has no credentials. Set ELASTICSEARCH_URL + ELASTICSEARCH_API_KEY in .env.',
    );
  }
  if (es.cloudId) {
    return new Client({ cloud: { id: es.cloudId }, auth });
  }
  return new Client({ node: es.url, auth });
}

/** Copies one index from source to dest via scroll + bulk. Returns docs copied. */
async function copyIndex(source: Client, dest: Client, index: string): Promise<number> {
  let copied = 0;
  const first = await source.search<Record<string, unknown>>({
    index,
    scroll: '2m',
    size: 500,
    query: { match_all: {} },
  });
  let scrollId = first._scroll_id;
  let hits = first.hits.hits;

  while (hits.length > 0) {
    const operations = hits.flatMap((h) => [
      { index: { _index: index, _id: h._id } },
      h._source as Record<string, unknown>,
    ]);
    const bulkResp = await dest.bulk({ operations, refresh: false });
    if (bulkResp.errors) {
      const firstError = bulkResp.items.find((i) => i.index?.error)?.index?.error;
      throw new Error(
        `Bulk into ${index} reported errors: ${JSON.stringify(firstError ?? 'unknown')}`,
      );
    }
    copied += hits.length;
    if (!scrollId) break;
    const next = await source.scroll<Record<string, unknown>>({ scroll_id: scrollId, scroll: '2m' });
    scrollId = next._scroll_id;
    hits = next.hits.hits;
  }

  if (scrollId) {
    await source.clearScroll({ scroll_id: scrollId }).catch(() => undefined);
  }
  return copied;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const source = buildSourceClient();

  const rows = (await source.cat.indices({
    index: SOURCE_INDEX_PATTERNS,
    format: 'json',
    h: 'index,docs.count',
  })) as CatIndexRow[];

  const nonEmpty = rows.flatMap((r) => {
    const index = r.index;
    const docs = Number(r['docs.count'] ?? '0');
    if (!index || index.startsWith('.') || docs <= 0) return [];
    return [{ index, docs }];
  });

  if (nonEmpty.length === 0) {
    logger.info('No non-empty source indices found; nothing to migrate.');
    return;
  }

  logger.info('Source indices to migrate:', {
    indices: nonEmpty.map((r) => `${r.index}=${r.docs}`),
  });

  if (dryRun) {
    logger.info('Dry run — no data copied.');
    return;
  }

  const dest = buildDestClient();

  // Create destination indices with proper (serverless-aware) mappings first.
  const store = new ElasticsearchResultsStore(dest);
  await store.initialize();

  let total = 0;
  for (const { index } of nonEmpty) {
    const copied = await copyIndex(source, dest, index);
    await dest.indices.refresh({ index }).catch(() => undefined);
    logger.info(`Copied ${index}: ${copied} docs`);
    total += copied;
  }

  // Verify destination counts match source. Use the _count API on BOTH sides:
  // _cat/indices docs.count includes nested sub-documents (benchmark_metrics,
  // criteria_results), so it must not be used as the comparison baseline.
  logger.info('Verifying destination counts…');
  let mismatch = false;
  for (const { index } of nonEmpty) {
    const [srcCount, dstCount] = await Promise.all([
      source.count({ index }),
      dest.count({ index }),
    ]);
    const ok = srcCount.count === dstCount.count;
    if (!ok) mismatch = true;
    logger.info(
      `  ${index}: source=${srcCount.count} dest=${dstCount.count} ${ok ? 'OK' : 'MISMATCH'}`,
    );
  }

  logger.info(`Migration complete: ${total} docs copied across ${nonEmpty.length} indices.`);
  if (mismatch) {
    logger.error('One or more indices have mismatched counts — review above.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error('Migration failed', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
