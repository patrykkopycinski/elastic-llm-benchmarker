import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getPassedSuitesFromJsonl,
  resolveSkipLocalBatchSuites,
} from '../../src/services/local-batch-resume.js';

describe('local-batch-resume', () => {
  let pluginDir: string;

  beforeEach(async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'batch-resume-'));
    const stateDir = join(pluginDir, 'matrix-output', '.batch-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'worker-0-results.jsonl'),
      [
        JSON.stringify({
          suite: 'security-alert-triage',
          model: 'org/model-a',
          status: 'pass',
          duration_ms: 1000,
        }),
        JSON.stringify({
          suite: 'agent-builder',
          model: 'org/model-a',
          status: 'fail',
          duration_ms: 500,
        }),
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns only passed suites from jsonl', async () => {
    const passed = await getPassedSuitesFromJsonl(pluginDir, 'org/model-a');
    expect(passed).toEqual(['security-alert-triage']);
  });

  it('resolveSkipLocalBatchSuites filters to requested evalSuites', async () => {
    const skip = await resolveSkipLocalBatchSuites({
      pluginDir,
      modelId: 'org/model-a',
      queueEntryId: 'entry-1',
      evalSuites: ['security-alert-triage', 'agent-builder'],
    });
    expect(skip).toEqual(['security-alert-triage']);
  });
});
