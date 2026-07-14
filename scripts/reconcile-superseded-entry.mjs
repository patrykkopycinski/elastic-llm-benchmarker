#!/usr/bin/env node
/**
 * Annotate a terminal queue entry as superseded by a later successful run.
 * Usage: node scripts/reconcile-superseded-entry.mjs <entryId> <supersededByEntryId>
 */
import dotenv from 'dotenv';
import { Client } from '@elastic/elasticsearch';

dotenv.config();

const entryId = process.argv[2];
const supersededBy = process.argv[3];
if (!entryId || !supersededBy) {
  console.error('Usage: reconcile-superseded-entry.mjs <entryId> <supersededByEntryId>');
  process.exit(1);
}

const node = process.env.ES_URL ?? process.env.ELASTICSEARCH_URL ?? 'http://localhost:9223';
const apiKey = process.env.ES_API_KEY ?? process.env.ELASTICSEARCH_API_KEY;
const client = new Client(apiKey ? { node, auth: { apiKey } } : { node });

const prefix = `[superseded by ${supersededBy}] `;

try {
  const existing = await client.get({ index: 'benchmarker-queue', id: entryId });
  const src = existing._source ?? {};
  const current = typeof src.error_message === 'string' ? src.error_message : '';
  if (current.startsWith(prefix)) {
    console.log(`Already reconciled: ${entryId}`);
    process.exit(0);
  }
  await client.update({
    index: 'benchmarker-queue',
    id: entryId,
    doc: { error_message: `${prefix}${current}`.slice(0, 2000) },
  });
  console.log(`Reconciled ${entryId} → superseded by ${supersededBy}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await client.close();
}
