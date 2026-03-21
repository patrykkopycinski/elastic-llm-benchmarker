// src/agent/interactive-orchestrator.ts
import type { QueueService, QueueEntry } from '../services/queue-service.js';
import type { ConfigResearcherService } from '../services/config-researcher.js';
import { POLLING_CONFIG } from './discovery-constants.js';

export interface BenchmarkOptions {
  wait?: boolean;
  progressCallback?: (msg: string) => void;
  configOverrides?: {
    tensorParallelSize?: number;
    maxModelLen?: number;
  };
  skipReasoning?: boolean;
}

export class InteractiveOrchestrator {
  constructor(
    private queueService: QueueService,
    private configResearcher: ConfigResearcherService
  ) {}

  async benchmarkModel(modelId: string, options: BenchmarkOptions = {}): Promise<QueueEntry> {
    options.progressCallback?.('Researching optimal config...');
    const config = await this.configResearcher.research(modelId);

    // TODO: Config overrides are currently not persisted to queue
    // The QueueService needs to support metadata/config storage for this to work
    // For now, overrides are validated but not applied to the actual benchmark run
    if (options.configOverrides) {
      Object.assign(config, options.configOverrides);

      // Log warning that overrides won't be applied
      console.warn(
        'Config overrides requested but not yet supported in queue persistence. ' +
        'Overrides will not be applied to benchmark run. ' +
        'Track: https://github.com/elastic/elastic-llm-benchmarker/issues/XXX'
      );
    }

    options.progressCallback?.('Adding to priority queue...');
    const queueEntry = await this.queueService.enqueue(
      modelId,
      'user',
      100,
      'interactive-user'
    );

    if (options.wait) {
      await this.pollUntilComplete(queueEntry.id, options.progressCallback);
    }

    return queueEntry;
  }

  private async pollUntilComplete(queueId: string, callback?: (msg: string) => void) {
    const startTime = Date.now();
    let lastStatus: string | null = null; // Track status changes to reduce spam

    while (true) {
      if (Date.now() - startTime > POLLING_CONFIG.MAX_WAIT_MS) {
        throw new Error('Benchmark timeout after 1 hour');
      }

      // Get specific queue entry (efficient - direct ES get by ID)
      const entry = await this.queueService.getById(queueId);

      if (!entry) {
        throw new Error(`Queue entry ${queueId} not found`);
      }

      // Report status only on change (reduce callback spam)
      if (entry.status !== lastStatus) {
        if (entry.status === 'deploying') {
          callback?.('🚀 Deploying model...');
        } else if (entry.status === 'benchmarking') {
          callback?.('📊 Running benchmarks...');
        }
        lastStatus = entry.status;
      }

      if (entry.status === 'completed') {
        callback?.('✅ Benchmark complete!');
        break;
      }
      if (entry.status === 'failed') {
        throw new Error(`Benchmark failed: ${entry.errorMessage || 'Unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, POLLING_CONFIG.POLL_INTERVAL_MS));
    }
  }
}
