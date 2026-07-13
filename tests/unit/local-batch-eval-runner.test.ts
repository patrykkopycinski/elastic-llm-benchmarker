import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { LocalBatchEvalRunner, type LocalBatchEvalOptions } from '../../src/services/local-batch-eval-runner.js';
import type { Stage2LocalConfig } from '../../src/types/config.js';

const execFileMock = vi.mocked(execFile);
const readFileMock = vi.mocked(readFile);

function mockExecFileSuccess(stdout: string, stderr: string = '') {
  execFileMock.mockImplementation((_file, _args, _options, _callback) => {
    let callback = _callback;
    if (typeof _options === 'function') {
      callback = _options;
    }
    if (callback) {
      process.nextTick(() => (callback as (e: unknown, o: string, se: string) => void)(null, stdout, stderr));
    }
    return null as unknown as ReturnType<typeof execFile>;
  });
}

function mockExecFileFailure(message: string, stdout: string = '', stderr: string = '', code: number | null = 1) {
  execFileMock.mockImplementation((_file, _args, _options, _callback) => {
    let callback = _callback;
    if (typeof _options === 'function') {
      callback = _options;
    }
    const err = new Error(message) as Error & { code: number | null };
    err.code = code;
    if (callback) {
      process.nextTick(() => (callback as (e: unknown, o: string, se: string) => void)(err, stdout, stderr));
    }
    return null as unknown as ReturnType<typeof execFile>;
  });
}

function createConfig(overrides?: Partial<Stage2LocalConfig>): Stage2LocalConfig {
  return {
    evalSuites: ['security-alert-triage', 'security-esql-generation-regression'],
    suiteTimeoutMs: 60_000,
    useBatchRunner: true,
    skillDevPluginDir: '/plugin',
    batchWorkers: 2,
    exportProfile: 'local',
    ...overrides,
  } as unknown as Stage2LocalConfig;
}

const baseOpts: LocalBatchEvalOptions = {
  vllmBaseUrl: 'http://10.0.0.5:8000/v1',
  modelId: 'my-org/my-model',
};

describe('LocalBatchEvalRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when skillDevPluginDir is not configured', async () => {
    const runner = new LocalBatchEvalRunner(createConfig({ skillDevPluginDir: undefined }));
    await expect(runner.run(baseOpts)).rejects.toThrow('skillDevPluginDir');
  });

  it('parses real per-suite results and log paths from the summary JSON', async () => {
    mockExecFileSuccess('[batch 10:00:00] >>> Summary: /tmp/matrix-output/batch-summary-1.json\n');
    readFileMock.mockResolvedValue(
      JSON.stringify({
        run_id: 'batch-1',
        timestamp: '1',
        overall_exit: 0,
        log_dir: '/tmp/matrix-output/batch-logs',
        results: [
          {
            suite: 'security-alert-triage',
            model: 'my-org/my-model',
            status: 'pass',
            duration_ms: 12345,
            log_file: '/tmp/matrix-output/batch-logs/worker-0-security-alert-triage.log',
            worker: 0,
          },
          {
            suite: 'security-esql-generation-regression',
            model: 'my-org/my-model',
            status: 'fail',
            duration_ms: 6789,
            log_file: '/tmp/matrix-output/batch-logs/worker-1-security-esql-generation-regression.log',
            worker: 1,
          },
        ],
      }),
    );

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('partial');
    expect(result.summaryPath).toBe('/tmp/matrix-output/batch-summary-1.json');
    expect(result.suites).toEqual([
      {
        suite: 'security-alert-triage',
        status: 'pass',
        durationMs: 12345,
        logPath: '/tmp/matrix-output/batch-logs/worker-0-security-alert-triage.log',
      },
      {
        suite: 'security-esql-generation-regression',
        status: 'fail',
        durationMs: 6789,
        logPath: '/tmp/matrix-output/batch-logs/worker-1-security-esql-generation-regression.log',
      },
    ]);
  });

  it('reports success only when every requested suite passed and exit code is 0', async () => {
    mockExecFileSuccess('[batch 10:00:00] >>> Summary: /tmp/matrix-output/batch-summary-2.json\n');
    readFileMock.mockResolvedValue(
      JSON.stringify({
        run_id: 'batch-2',
        timestamp: '2',
        overall_exit: 0,
        log_dir: '/tmp/matrix-output/batch-logs',
        results: [
          { suite: 'security-alert-triage', model: 'my-org/my-model', status: 'pass', duration_ms: 100, log_file: 'a.log', worker: 0 },
          { suite: 'security-esql-generation-regression', model: 'my-org/my-model', status: 'pass', duration_ms: 200, log_file: 'b.log', worker: 1 },
        ],
      }),
    );

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('success');
  });

  it('falls back to per-suite fail entries when no "Summary:" line is present in stdout', async () => {
    mockExecFileSuccess('nothing useful here\n');

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('failed');
    expect(result.summaryPath).toBeUndefined();
    expect(result.suites).toEqual([
      { suite: 'security-alert-triage', status: 'fail', durationMs: 0 },
      { suite: 'security-esql-generation-regression', status: 'fail', durationMs: 0 },
    ]);
  });

  it('falls back to per-suite fail entries when the summary file cannot be read', async () => {
    mockExecFileSuccess('[batch 10:00:00] >>> Summary: /tmp/missing.json\n');
    readFileMock.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('failed');
    expect(result.suites.every((s) => s.status === 'fail' && s.durationMs === 0)).toBe(true);
  });

  it('reports a suite missing from the summary results as failed rather than omitting it', async () => {
    mockExecFileSuccess('[batch 10:00:00] >>> Summary: /tmp/matrix-output/batch-summary-3.json\n');
    readFileMock.mockResolvedValue(
      JSON.stringify({
        run_id: 'batch-3',
        timestamp: '3',
        overall_exit: 1,
        log_dir: '/tmp/matrix-output/batch-logs',
        results: [
          { suite: 'security-alert-triage', model: 'my-org/my-model', status: 'pass', duration_ms: 100, log_file: 'a.log', worker: 0 },
        ],
      }),
    );

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.suites).toEqual([
      { suite: 'security-alert-triage', status: 'pass', durationMs: 100, logPath: 'a.log' },
      { suite: 'security-esql-generation-regression', status: 'fail', durationMs: 0 },
    ]);
    expect(result.status).toBe('partial');
  });

  it('passes stability env vars to the batch runner', async () => {
    mockExecFileSuccess('[batch 10:00:00] >>> Summary: /tmp/summary.json\n');
    readFileMock.mockResolvedValue(
      JSON.stringify({
        run_id: 'batch-env',
        timestamp: '1',
        overall_exit: 0,
        log_dir: '/tmp/logs',
        results: [],
      }),
    );

    const runner = new LocalBatchEvalRunner(
      createConfig({
        pauseAlwaysOnStack: true,
        teardownBatchStack: true,
        cleanupStalePorts: true,
      } as Partial<Stage2LocalConfig>),
    );
    await runner.run({
      ...baseOpts,
      suites: [
        'security-esql-generation-regression',
        'security-alert-triage',
        'security-alerts-rag-regression',
      ],
    });

    expect(execFileMock).toHaveBeenCalled();
    const call = execFileMock.mock.calls[0];
    const options = call[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.BATCH_PAUSE_ALWAYS_ON_STACK).toBe('true');
    expect(options.env?.BATCH_TEARDOWN_ON_EXIT).toBe('true');
    expect(options.env?.BATCH_CLEANUP_STALE_PORTS).toBe('true');
    expect(options.env?.BATCH_SUITE_ORDER).toBe('benchmarker');
    expect(options.env?.BATCH_SUITES).toBe(
      'security-alert-triage,security-alerts-rag-regression,security-esql-generation-regression',
    );
  });

  it('reports failed status and logs a warning when execFile itself errors with no exit code', async () => {
    mockExecFileFailure('spawn ENOENT', '', 'bash: not found', null);

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('failed');
    expect(result.suites.every((s) => s.status === 'fail')).toBe(true);
  });
});
