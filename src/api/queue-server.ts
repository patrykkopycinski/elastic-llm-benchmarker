import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@elastic/elasticsearch';
import { QueueService } from '../services/queue-service.js';
import { createLogger } from '../utils/logger.js';

const MODEL_ID_PATTERN = /^[\w\-./]+$/;
const MODEL_ID_MAX_LENGTH = 256;

export interface QueueServerConfig {
  port?: number;
  esUrl?: string;
  esApiKey?: string;
  esUsername?: string;
  esPassword?: string;
}

function createEsClient(config: QueueServerConfig): Client {
  const node = config.esUrl ?? process.env.ES_URL ?? 'http://localhost:9200';
  const apiKey = config.esApiKey ?? process.env.ES_API_KEY;
  const username = config.esUsername ?? process.env.ES_USERNAME;
  const password = config.esPassword ?? process.env.ES_PASSWORD;

  const auth = apiKey
    ? { apiKey }
    : username && password
      ? { username, password }
      : undefined;

  return new Client({ node, ...(auth ? { auth } : {}) });
}

function sanitizeForLog(value: string): string {
  return value.replace(/[<>&"']/g, '');
}

export function createQueueServer(config: QueueServerConfig = {}) {
  const logger = createLogger();
  const esClient = createEsClient(config);
  const queueService = new QueueService(esClient);

  const app = express();
  app.use(express.json({ limit: '10kb' }));

  app.use((_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.options('/{*path}', (_req, res) => res.sendStatus(204));

  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });

  app.post('/api/queue', async (req, res) => {
    try {
      const { modelId, priority, requestedBy } = req.body ?? {};
      if (!modelId || typeof modelId !== 'string') {
        res.status(400).json({ error: 'modelId is required' });
        return;
      }
      if (modelId.length > MODEL_ID_MAX_LENGTH || !MODEL_ID_PATTERN.test(modelId)) {
        res.status(400).json({
          error:
            'modelId must be alphanumeric with dashes, dots, underscores, and slashes (max 256 chars)',
        });
        return;
      }
      const entry = await queueService.enqueue(
        modelId,
        'user',
        typeof priority === 'number' ? priority : undefined,
        typeof requestedBy === 'string' ? requestedBy : undefined,
      );
      res.status(201).json(entry);
    } catch (err) {
      logger.error('POST /api/queue failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/queue', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const entries = await queueService.getQueue({ status, source });
      res.json(entries);
    } catch (err) {
      logger.error('GET /api/queue failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/queue/current', async (_req, res) => {
    try {
      const entry = await queueService.getCurrent();
      res.json(entry);
    } catch (err) {
      logger.error('GET /api/queue/current failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.delete('/api/queue/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!id || typeof id !== 'string') {
        res.status(400).json({ error: 'Invalid id parameter' });
        return;
      }
      const cancelled = await queueService.cancel(id);
      if (cancelled === null) {
        res.status(404).json({ error: 'Queue entry not found' });
      } else if (cancelled) {
        res.status(200).json({ ok: true });
      } else {
        res.status(409).json({ error: 'Entry not in pending status' });
      }
    } catch (err) {
      logger.error(`DELETE /api/queue/${sanitizeForLog(req.params.id)} failed`, {
        err,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/queue/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendState = async () => {
      try {
        const [entries, current] = await Promise.all([
          queueService.getQueue(),
          queueService.getCurrent(),
        ]);
        res.write(`data: ${JSON.stringify({ entries, current })}\n\n`);
      } catch (err) {
        logger.error('SSE state fetch failed', { err });
      }
    };

    sendState();
    const interval = setInterval(sendState, 5000);

    req.on('close', () => {
      clearInterval(interval);
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

export function startQueueServer(config: QueueServerConfig = {}) {
  const port = config.port ?? (process.env.PORT ? Number(process.env.PORT) : 3100);
  const app = createQueueServer(config);
  const server = app.listen(port, () => {
    const logger = createLogger();
    logger.info(`Queue API listening on port ${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startQueueServer({
    port: Number(process.env.PORT) || 3100,
    esUrl: process.env.ES_URL,
    esApiKey: process.env.ES_API_KEY,
    esUsername: process.env.ES_USERNAME,
    esPassword: process.env.ES_PASSWORD,
  });
}
