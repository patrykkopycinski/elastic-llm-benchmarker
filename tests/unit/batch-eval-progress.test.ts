import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLiveBatchEvalProgress } from '../../src/services/batch-eval-progress.js';

describe('readLiveBatchEvalProgress', () => {
  let pluginDir: string;

  beforeEach(async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'batch-progress-'));
    const stateDir = join(pluginDir, 'matrix-output', '.batch-state');
    await mkdir(stateDir, { recursive: true });
    await mkdir(join(stateDir, 'suite-queue'), { recursive: true });
    await writeFile(
      join(stateDir, 'worker-0-results.jsonl'),
      JSON.stringify({
        suite: 'security-ai-rules',
        model: 'Qwen/Qwen3.6-35B-A3B',
        status: 'pass',
        duration_ms: 120000,
      }) + '\n',
    );
    await writeFile(join(stateDir, 'suite-queue', '002__security-multi-step'), '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns completed suites and queued current suite for model', async () => {
    const live = await readLiveBatchEvalProgress(pluginDir, 'Qwen/Qwen3.6-35B-A3B', [
      'security-ai-rules',
      'security-multi-step',
      'agent-builder',
    ]);
    expect(live.completedSuiteIds).toEqual(['security-ai-rules']);
    expect(live.evalCurrent).toBe('security-multi-step');
  });

  it('returns empty when state dir missing', async () => {
    const live = await readLiveBatchEvalProgress('/nonexistent/path', 'm');
    expect(live.completedSuiteIds).toEqual([]);
  });
});
