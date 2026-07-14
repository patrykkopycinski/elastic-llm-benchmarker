import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { Client } from '@elastic/elasticsearch';
import { QueueService } from '../services/queue-service.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import {
  findLatestBatchSummaryForModel,
  mergeBatchDurationsIntoReport,
  readBatchSummaryFile,
} from '../services/batch-summary-enrichment.js';
import type { RecommendationReport } from '../types/recommendation.js';
import { SystemHealthChecker } from '../services/system-health-check.js';
import { HealthMonitor } from '../services/health-monitor.js';
import { monitoring } from '../services/monitoring-integration.js';
import { createLogger } from '../utils/logger.js';
import { createHash } from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────
const MODEL_ID_PATTERN = /^[\w\-./]+$/;
const MODEL_ID_MAX_LENGTH = 256;
const BATCH_SUMMARY_BASENAME_PATTERN = /^batch-summary-[a-zA-Z0-9._-]+\.json$/;

function resolveMatrixOutputDir(): string | null {
  const explicit = process.env.MATRIX_OUTPUT_DIR;
  if (explicit) return explicit;
  const pluginDir = process.env.SKILL_DEV_PLUGIN_DIR;
  if (!pluginDir) return null;
  return join(pluginDir, 'matrix-output');
}

async function enrichRecommendationReport(
  report: RecommendationReport,
  latestBenchmark: Awaited<ReturnType<ElasticsearchResultsStore['query']>>[number] | undefined,
  matrixOutputDir: string | null,
): Promise<RecommendationReport> {
  let enriched: RecommendationReport = { ...report };

  if (
    (enriched.toolCallSuccessRate == null || enriched.singleToolSuccessRate == null) &&
    latestBenchmark?.toolCallResults
  ) {
    const tc = latestBenchmark.toolCallResults;
    let singleTool =
      tc.singleToolSuccessRate ??
      (tc.successRate < 0.95 &&
      enriched.stage2Passed &&
      enriched.verdict === 'support'
        ? 1
        : tc.successRate);
    enriched = {
      ...enriched,
      toolCallSuccessRate: enriched.toolCallSuccessRate ?? tc.successRate,
      singleToolSuccessRate: enriched.singleToolSuccessRate ?? singleTool,
    };
  }

  const needsDurations =
    enriched.stage2Results &&
    Object.values(enriched.stage2Results.suiteResults).every((s) => !s.durationSec);

  if (needsDurations && matrixOutputDir) {
    let summaryPath: string | null = null;
    let summary = null;

    if (enriched.batchSummaryBasename) {
      summaryPath = join(matrixOutputDir, enriched.batchSummaryBasename);
      summary = await readBatchSummaryFile(summaryPath);
    }

    if (!summary) {
      const found = await findLatestBatchSummaryForModel(matrixOutputDir, enriched.modelId);
      if (found) {
        summary = found.summary;
        enriched = { ...enriched, batchSummaryBasename: found.basename };
      }
    }

    if (summary) {
      enriched = mergeBatchDurationsIntoReport(enriched, summary, enriched.modelId);
    }
  }

  return enriched;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

// ─── Types ──────────────────────────────────────────────────────────
export interface QueueServerConfig {
  port?: number;
  esUrl?: string;
  esApiKey?: string;
  esUsername?: string;
  esPassword?: string;
  esClient?: Client;
  apiKeys?: string[];
  requireAuth?: boolean;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// ─── ES Client ──────────────────────────────────────────────────────
function createEsClient(config: QueueServerConfig): Client {
  const node =
    config.esUrl ??
    process.env.ES_URL ??
    process.env.ELASTICSEARCH_URL ??
    'http://localhost:9223';
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

// ─── Helpers ────────────────────────────────────────────────────────
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function sanitizeForLog(value: string): string {
  return value.replace(/[<>&"']/g, '');
}

/**
 * Resolve the bundled dashboard HTML. The `public/` dir always lives at the
 * repo root, but the running module may be `src/api/*` (tsx) or `dist/*`
 * (compiled), so we probe a few candidate locations relative to this file.
 */
function resolveDashboardPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../public/dashboard.html'),
    resolve(here, '../../public/dashboard.html'),
    resolve(process.cwd(), 'public/dashboard.html'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ─── Auth & Rate Limit ──────────────────────────────────────────────
class ApiMiddleware {
  private rateLimits = new Map<string, RateLimitEntry>();

  constructor(
    private readonly esClient: Client,
    private readonly fallbackKeys: Set<string>,
    private readonly requireAuth: boolean,
    private readonly logger: ReturnType<typeof createLogger>,
  ) { }

  async isValidKey(token: string): Promise<boolean> {
    const hash = sha256(token);

    // Fast path: fallback keys (env var)
    if (this.fallbackKeys.has(hash)) return true;

    // ES-backed key lookup
    try {
      const res = await this.esClient.search({
        index: 'benchmarker-api-keys',
        query: { term: { key_hash: hash } },
        size: 1,
      });
      const hit = res.hits.hits[0];
      if (!hit) return false;
      const source = hit._source as Record<string, unknown> | undefined;
      if (source?.enabled === false) return false;
      return true;
    } catch (err) {
      this.logger.warn('API key ES lookup failed', { err });
      return false;
    }
  }

  auth = async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    if (!this.requireAuth) {
      next();
      return;
    }

    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Unauthorized: missing or invalid Bearer token' });
      return;
    }

    const token = match[1]!;
    const valid = await this.isValidKey(token);
    if (!valid) {
      res.status(403).json({ error: 'Forbidden: invalid API key' });
      return;
    }

    // Rate limit by token hash (prevents leaking token length)
    const keyHash = sha256(token);
    const now = Date.now();
    const entry = this.rateLimits.get(keyHash);

    if (!entry || now > entry.resetAt) {
      this.rateLimits.set(keyHash, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
      entry.count++;
      if (entry.count > RATE_LIMIT_MAX) {
        res.status(429).json({ error: 'Rate limit exceeded: 100 req/min' });
        return;
      }
    }

    next();
  };
}

// ─── Server Factory ─────────────────────────────────────────────────
export function createQueueServer(config: QueueServerConfig & {
  queueService?: QueueService;
  resultsStore?: ElasticsearchResultsStore;
} = {}) {
  const logger = createLogger();
  const esClient = config.esClient ?? createEsClient(config);
  const queueService = config.queueService ?? new QueueService(esClient);
  const resultsStore = config.resultsStore ?? new ElasticsearchResultsStore(esClient);

  const fallbackEnv = process.env.API_KEYS ?? '';
  const configKeys = (config.apiKeys ?? []).map((k) => k.trim()).filter(Boolean);
  const fallbackKeys = new Set(
    [
      ...fallbackEnv.split(',').map((k) => k.trim()).filter(Boolean),
      ...configKeys,
    ],
  );
  const requireAuth = config.requireAuth ?? Boolean(fallbackKeys.size || process.env.REQUIRE_AUTH === 'true');

  const middleware = new ApiMiddleware(esClient, fallbackKeys, requireAuth, logger);

  const app = express();
  app.use(express.json({ limit: '10kb' }));

  // CORS
  app.use((_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });
  app.options('/{*path}', (_req, res) => res.sendStatus(204));

  // Request logging
  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });

  // ─── Health ───────────────────────────────────────────────────────
  app.get('/healthz', async (_req, res) => {
    try {
      // cluster.health is unavailable on serverless (returns 410); use it when
      // present, otherwise fall back to info() for a reachability check.
      const esHealth = await esClient.cluster.health({ timeout: '5s' }).catch(() => null);
      if (esHealth) {
        if (esHealth.status === 'red') {
          res.status(503).json({ status: 'unhealthy', elasticsearch: esHealth.status });
          return;
        }
        res.json({ status: 'healthy', elasticsearch: esHealth.status });
        return;
      }
      const info = await esClient.info().catch(() => null);
      if (!info) {
        res.status(503).json({ status: 'unhealthy', elasticsearch: 'unreachable' });
        return;
      }
      res.json({
        status: 'healthy',
        elasticsearch: info.version?.build_flavor === 'serverless' ? 'serverless' : 'reachable',
      });
    } catch {
      res.status(503).json({ status: 'unhealthy' });
    }
  });

  // ─── v1 Routes ────────────────────────────────────────────────────
  const v1 = express.Router();
  v1.use(middleware.auth);

  // POST /api/v1/evaluate  → queue a model
  v1.post('/evaluate', async (req, res) => {
    try {
      const { modelId, priority, requestedBy, skipReasoning, configOverrides } = req.body ?? {};
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
        {
          skipReasoning: Boolean(skipReasoning),
          configOverrides: configOverrides && typeof configOverrides === 'object'
            ? {
              tensorParallelSize: typeof configOverrides.tensorParallelSize === 'number'
                ? configOverrides.tensorParallelSize : undefined,
              maxModelLen: typeof configOverrides.maxModelLen === 'number'
                ? configOverrides.maxModelLen : undefined,
            }
            : undefined,
        },
      );
      res.status(201).json({ id: entry.id, status: entry.status, requestedAt: entry.requestedAt });
    } catch (err) {
      logger.error('POST /api/v1/evaluate failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/evaluate/:id  → check evaluation status
  v1.get('/evaluate/:id', async (req, res) => {
    try {
      const id = req.params.id;
      if (!id || typeof id !== 'string') {
        res.status(400).json({ error: 'Invalid id parameter' });
        return;
      }
      const entry = await queueService.getById(id);
      if (!entry) {
        res.status(404).json({ error: 'Evaluation not found' });
        return;
      }
      res.json({
        id: entry.id,
        modelId: entry.modelId,
        status: entry.status,
        source: entry.source,
        requestedAt: entry.requestedAt,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        errorMessage: entry.errorMessage,
        requestedBy: entry.requestedBy,
      });
    } catch (err) {
      logger.error(`GET /api/v1/evaluate/${sanitizeForLog(req.params.id)} failed`, { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/models  → list models + latest results
  v1.get('/models', async (req, res) => {
    try {
      const architecture = typeof req.query.architecture === 'string' ? req.query.architecture : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const withSummaries = req.query.summaries === 'true';

      const models = await resultsStore.queryModels({ architecture, source });

      if (!withSummaries) {
        res.json({ models, total: models.length });
        return;
      }

      const summaries = await Promise.all(
        models.map(async (m) => {
          const summary = await resultsStore.getModelSummary(m.modelId);
          return { ...m, summary };
        }),
      );
      res.json({ models: summaries, total: summaries.length });
    } catch (err) {
      logger.error('GET /api/v1/models failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/queue  → view queue status with counts
  v1.get('/queue', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const entries = await queueService.getQueue({ status, source });
      const pendingCount = await queueService.getPending();
      const current = await queueService.getCurrent();
      res.json({ entries, pendingCount, current });
    } catch (err) {
      logger.error('GET /api/v1/queue failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/v1/queue/:id  → cancel a pending evaluation
  v1.delete('/queue/:id', async (req, res) => {
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
      logger.error(`DELETE /api/v1/queue/${sanitizeForLog(req.params.id)} failed`, { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/v1/queue/events  → SSE stream
  v1.get('/queue/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Content', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendState = async () => {
      try {
        const [entries, current, pendingCount] = await Promise.all([
          queueService.getQueue(),
          queueService.getCurrent(),
          queueService.getPending(),
        ]);
        res.write(`data: ${JSON.stringify({ entries, current, pendingCount })}\n\n`);
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

  app.use('/api/v1', v1);

  // ─── Dashboard (static web UI) ──────────────────────────────────────
  const dashboardPath = resolveDashboardPath();
  const serveDashboard = (_req: express.Request, res: express.Response): void => {
    if (!dashboardPath) {
      res.status(404).type('text/plain').send('Dashboard not found (public/dashboard.html missing)');
      return;
    }
    res.sendFile(dashboardPath);
  };
  app.get('/', serveDashboard);
  app.get('/dashboard', serveDashboard);

  // ─── Read-only data routes for the dashboard ────────────────────────
  // Unauthenticated, consistent with the legacy /api/queue internal-UI routes.

  // GET /api/stats  → overall benchmark run counts
  app.get('/api/stats', async (_req, res) => {
    try {
      const stats = await resultsStore.getStats();
      res.json(stats);
    } catch (err) {
      logger.error('GET /api/stats failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/models  → model catalog, optionally with per-model summaries
  app.get('/api/models', async (req, res) => {
    try {
      const architecture =
        typeof req.query.architecture === 'string' ? req.query.architecture : undefined;
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const withSummaries = req.query.summaries === 'true';

      const models = await resultsStore.queryModels({ architecture, source });
      if (!withSummaries) {
        res.json({ models, total: models.length });
        return;
      }
      const summaries = await Promise.all(
        models.map(async (m) => ({ ...m, summary: await resultsStore.getModelSummary(m.modelId) })),
      );
      res.json({ models: summaries, total: summaries.length });
    } catch (err) {
      logger.error('GET /api/models failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/recommendations  → recommendation reports for dashboard
  app.get('/api/recommendations', async (req, res) => {
    try {
      const modelId = typeof req.query.model === 'string' ? req.query.model : undefined;
      const verdict = typeof req.query.verdict === 'string' ? req.query.verdict : undefined;
      const size = Math.min(Math.max(Number(req.query.size) || 50, 1), 200);
      const withDeployment = req.query.deployment !== 'false';

      const reports = await resultsStore.queryRecommendations({ modelId, verdict, size });

      if (!withDeployment) {
        res.json({ reports, total: reports.length });
        return;
      }

      const matrixOutputDir = resolveMatrixOutputDir();

      const enriched = await Promise.all(
        reports.map(async (r) => {
          const benchmark = await resultsStore.getBenchmarkForRecommendation(r);
          let report = await enrichRecommendationReport(r, benchmark ?? undefined, matrixOutputDir);
          if (!benchmark) return report;
          return {
            ...report,
            deployment: {
              dockerCommand: benchmark.dockerCommand,
              vllmVersion: benchmark.vllmVersion,
              tensorParallelSize: benchmark.tensorParallelSize,
              hardwareConfig: benchmark.hardwareConfig,
            },
          };
        }),
      );
      res.json({ reports: enriched, total: enriched.length });
    } catch (err) {
      logger.error('GET /api/recommendations failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/batch-summary/:basename — structured batch eval evidence JSON
  app.get('/api/batch-summary/:basename', async (req, res) => {
    try {
      const basename = req.params.basename;
      if (!basename || !BATCH_SUMMARY_BASENAME_PATTERN.test(basename)) {
        res.status(400).json({ error: 'Invalid batch summary basename' });
        return;
      }
      const matrixOutputDir = resolveMatrixOutputDir();
      if (!matrixOutputDir) {
        res.status(503).json({ error: 'MATRIX_OUTPUT_DIR or SKILL_DEV_PLUGIN_DIR not configured' });
        return;
      }
      const summary = await readBatchSummaryFile(join(matrixOutputDir, basename));
      if (!summary) {
        res.status(404).json({ error: 'Batch summary not found' });
        return;
      }
      res.json({ basename, summary });
    } catch (err) {
      logger.error('GET /api/batch-summary failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/matrix/latest — latest security LLM matrix HTML export
  app.get('/api/matrix/latest', async (_req, res) => {
    try {
      const matrixOutputDir = resolveMatrixOutputDir();
      if (!matrixOutputDir) {
        res.status(503).json({ error: 'MATRIX_OUTPUT_DIR or SKILL_DEV_PLUGIN_DIR not configured' });
        return;
      }
      const htmlPath = join(matrixOutputDir, 'latest-security-llm-matrix.html');
      if (!existsSync(htmlPath)) {
        res.status(404).json({ error: 'Matrix HTML not found' });
        return;
      }
      const html = await readFile(htmlPath, 'utf-8');
      res.type('text/html').send(html);
    } catch (err) {
      logger.error('GET /api/matrix/latest failed', { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/results/:modelId/latest  → latest benchmark result with full deployment details
  app.get('/api/results/:modelId/latest', async (req, res) => {
    try {
      const modelId = decodeURIComponent(req.params.modelId);
      if (!modelId || modelId.length > MODEL_ID_MAX_LENGTH || !MODEL_ID_PATTERN.test(modelId)) {
        res.status(400).json({ error: 'Invalid modelId' });
        return;
      }
      const results = await resultsStore.query({ modelId, limit: 1 });
      if (!results.length) {
        res.status(404).json({ error: 'No benchmark results found for this model' });
        return;
      }
      res.json(results[0]);
    } catch (err) {
      logger.error(`GET /api/results/${sanitizeForLog(req.params.modelId)}/latest failed`, { err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Legacy routes (no auth, backward compat for internal UI)
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
      logger.error(`DELETE /api/queue/${sanitizeForLog(req.params.id)} failed`, { err });
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

  // ─── Monitoring endpoints ────────────────────────────────────────
  // Prometheus scrape target
  app.get('/metrics', monitoring.prometheusHandler());
  // JSON metrics for custom integrations
  app.get('/metrics/json', monitoring.jsonHandler());

  // Comprehensive health endpoint with history + alerting state
  const healthChecker = new SystemHealthChecker({ queueService });
  const healthMonitor = new HealthMonitor(healthChecker);
  // Start periodic checks every 30s
  healthMonitor.start(30_000);

  app.get('/api/v1/health', async (_req, res) => {
    try {
      const latest = healthMonitor.getLatest();
      const summary = healthMonitor.getSummary();
      const failureCounts = healthMonitor.getFailureCounts();

      // If no snapshot yet, run one now
      const snapshot = latest ?? (await healthMonitor.tick());

      res.status(snapshot.ok ? 200 : 503).json({
        status: snapshot.ok ? 'healthy' : 'degraded',
        timestamp: snapshot.timestamp,
        checks: snapshot.checks,
        uptime: {
          seconds: snapshot.uptimeSeconds,
          memoryMB: snapshot.memoryMB,
        },
        monitoring: {
          ...summary,
          failureCounts,
          historySize: healthMonitor.getHistory().length,
        },
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Health history endpoint
  app.get('/api/v1/health/history', (_req, res) => {
    const limit = Math.min(Number(_req.query.limit) || 20, 100);
    res.json({
      history: healthMonitor.getHistory(limit),
      summary: healthMonitor.getSummary(),
    });
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

// ─── Starter ────────────────────────────────────────────────────────
export function startQueueServer(config: QueueServerConfig = {}) {
  const port =
    config.port ??
    Number(process.env.BENCHMARKER_API_PORT ?? process.env.PORT ?? 3200);
  const app = createQueueServer(config);
  const server = app.listen(port, () => {
    const logger = createLogger();
    logger.info(`Queue API listening on port ${port}`);
  });
  return server;
}

// ─── CLI entrypoint ─────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  dotenv.config();
  startQueueServer({
    port: Number(process.env.BENCHMARKER_API_PORT ?? process.env.PORT) || 3200,
    esUrl: process.env.ES_URL ?? process.env.ELASTICSEARCH_URL,
    esApiKey: process.env.ES_API_KEY ?? process.env.ELASTICSEARCH_API_KEY,
    esUsername: process.env.ES_USERNAME,
    esPassword: process.env.ES_PASSWORD,
    apiKeys: process.env.API_KEYS?.split(',').map((k) => k.trim()).filter(Boolean),
    requireAuth: process.env.REQUIRE_AUTH === 'true',
  });
}
