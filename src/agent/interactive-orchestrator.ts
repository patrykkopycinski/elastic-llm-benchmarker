// src/agent/interactive-orchestrator.ts
import type { QueueService, QueueEntry } from '../services/queue-service.js';
import type { ConfigResearcherService } from '../services/config-researcher.js';

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

    if (options.configOverrides) {
      Object.assign(config, options.configOverrides);
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
    const POLL_INTERVAL_MS = 5000;
    const MAX_WAIT_MS = 3600000;
    const startTime = Date.now();

    while (true) {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        throw new Error('Benchmark timeout after 1 hour');
      }

      // Get queue entries and find the one we're waiting for
      const allEntries = await this.queueService.getQueue();
      const entry = allEntries.find(e => e.id === queueId);

      if (!entry) {
        throw new Error(`Queue entry ${queueId} not found`);
      }

      // Report status
      if (entry.status === 'deploying') {
        callback?.('🚀 Deploying model...');
      } else if (entry.status === 'benchmarking') {
        callback?.('📊 Running benchmarks...');
      }

      if (entry.status === 'completed') {
        callback?.('✅ Benchmark complete!');
        break;
      }
      if (entry.status === 'failed') {
        throw new Error(`Benchmark failed: ${entry.errorMessage || 'Unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
