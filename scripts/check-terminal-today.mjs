import { loadConfig } from '../dist/index.js';
import { Client } from '@elastic/elasticsearch';
import { QueueService } from '../dist/index.js';

const config = loadConfig(undefined, { configPath: 'config/local.json' });
const client = new Client({
  node: config.elasticsearch.url,
  auth: config.elasticsearch.apiKey
    ? { apiKey: config.elasticsearch.apiKey }
    : config.elasticsearch.username
      ? { username: config.elasticsearch.username, password: config.elasticsearch.password ?? '' }
      : undefined,
});
const queue = new QueueService(client);
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
const n = await queue.countTerminalSince(today.toISOString());
console.log(`terminal_today=${n} since=${today.toISOString()}`);
process.exit(0);
