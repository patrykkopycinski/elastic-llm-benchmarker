import type { QueueService } from '../services/queue-service.js';
import type { PipelineProgress, PipelineStage } from '../types/pipeline-progress.js';

export function progressNow(
  stage: PipelineStage,
  detail: string,
  extra?: Partial<Omit<PipelineProgress, 'stage' | 'detail' | 'updatedAt'>>,
): PipelineProgress {
  return {
    stage,
    detail,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

/** Best-effort queue progress write — never throws. */
export async function reportQueueProgress(
  queueService: QueueService | undefined,
  queueEntryId: string | undefined,
  progress: PipelineProgress,
  leaseToken?: string,
): Promise<void> {
  if (!queueService || !queueEntryId) return;
  try {
    await queueService.updateProgress(queueEntryId, progress, leaseToken);
  } catch {
    // non-fatal dashboard bookkeeping
  }
}
