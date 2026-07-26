import { Command } from 'commander';
import { loadConfig } from '../config/index.js';
import { ElasticsearchResultsStore } from '../services/elasticsearch-results-store.js';
import { createEsClient } from './start-handler.js';
import { output, outputError } from './output.js';
import { printReport, printReportSummary } from './report-printer.js';

function loadAppConfig(options: { config?: string; json?: boolean }): ReturnType<typeof loadConfig> | null {
  try {
    return loadConfig(undefined, { configPath: options.config ? require('node:path').resolve(process.cwd(), options.config) : undefined });
  } catch (err) {
    if (!options.json) {
      console.error(`Error loading configuration: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

// ─── Recommend Handler ──────────────────────────────────────────────────────────

export async function recommendHandler(opts: Record<string, unknown>, deps: { program: Command }): Promise<void> {
  const program = deps.program;
    const globalOpts = program.opts();
    const jsonOutput = (globalOpts['json'] as boolean) || opts['format'] === 'json';
    const config = loadAppConfig({ config: globalOpts['config'] as string, json: jsonOutput });
    const esClient = createEsClient(config);
    if (!esClient) {
      outputError('Cannot connect to Elasticsearch. Check config.', jsonOutput);
      process.exit(1);
    }

    const store = new ElasticsearchResultsStore(esClient);
    await store.initialize();

    try {
      const modelId = opts['model'] as string | undefined;

      if (modelId) {
        const report = await store.getLatestRecommendation(modelId);
        if (!report) {
          outputError(`No recommendation found for ${modelId}`, jsonOutput);
          process.exit(1);
        }
        if (jsonOutput) {
          output(report, true);
        } else {
          printReport(report);
        }
      } else {
        const reports = await store.queryRecommendations({
          verdict: opts['verdict'] as string | undefined,
          limit: parseInt(opts['limit'] as string, 10),
        });

        if (reports.length === 0) {
          if (jsonOutput) {
            output({ total: 0, data: [] }, true);
          } else {
            console.error('No recommendation reports found.');
          }
          return;
        }

        if (jsonOutput) {
          output({ total: reports.length, data: reports }, true);
        } else {
          console.error(`Found ${reports.length} recommendation report(s):\n`);
          for (const r of reports) {
            printReportSummary(r);
          }
        }
      }
    } finally {
      await store.close();
    }
}
