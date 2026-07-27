import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
    readdir: vi.fn(),
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

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import {
  LocalBatchEvalRunner,
  resolveBatchTimeoutMs,
  ESQL_MIN_SUITE_TIMEOUT_MS,
  BATCH_RUNNER_MAX_BUFFER_BYTES,
  type LocalBatchEvalOptions,
} from '../../src/services/local-batch-eval-runner.js';
import type { Stage2LocalConfig } from '../../src/types/config.js';

const spawnMock = vi.mocked(spawn);
const readFileMock = vi.mocked(readFile);
const readdirMock = vi.mocked(readdir);

/** Minimal fake ChildProcess: stdout/stderr are EventEmitters, close/error propagate. */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 12345;
}

function mockExecFileSuccess(stdout: string, stderr: string = '') {
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess();
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

function mockExecFileFailure(message: string, stdout: string = '', stderr: string = '', code: number | null = 1) {
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess();
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      // A spawn-level failure (e.g. ENOENT) emits 'error' instead of 'close'.
      if (code === null) {
        child.emit('error', new Error(message));
      } else {
        child.emit('close', code);
      }
    });
    return child as unknown as ReturnType<typeof spawn>;
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

describe('resolveBatchTimeoutMs', () => {
  it('gives ESQL at least 2h even when base per-suite is 1h', () => {
    expect(
      resolveBatchTimeoutMs(['security-esql-generation-regression'], 3_600_000),
    ).toBe(ESQL_MIN_SUITE_TIMEOUT_MS);
  });

  it('sums non-ESQL suites at base rate and bumps only ESQL', () => {
    expect(
      resolveBatchTimeoutMs(
        [
          'security-alert-triage',
          'security-alerts-rag-regression',
          'security-esql-generation-regression',
        ],
        3_600_000,
      ),
    ).toBe(3_600_000 + 3_600_000 + ESQL_MIN_SUITE_TIMEOUT_MS);
  });
});

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

  it('derives specPassRate from the suite log for a fail-status suite so partial Playwright passes are not scored 0', async () => {
    mockExecFileSuccess('[batch 10:00:00] >>> Summary: /tmp/matrix-output/batch-summary-3.json\n');
    readFileMock.mockImplementation(async (path) => {
      const p = String(path);
      if (p.endsWith('batch-summary-3.json')) {
        return JSON.stringify({
          run_id: 'batch-3',
          timestamp: '3',
          overall_exit: 1,
          log_dir: '/tmp/matrix-output/batch-logs',
          results: [
            {
              suite: 'security-alert-triage',
              model: 'my-org/my-model',
              status: 'pass',
              duration_ms: 100,
              log_file: '/tmp/matrix-output/batch-logs/worker-1-security-alert-triage.log',
              worker: 1,
            },
            {
              suite: 'security-esql-generation-regression',
              model: 'my-org/my-model',
              status: 'fail',
              duration_ms: 4200000,
              log_file: '/tmp/matrix-output/batch-logs/worker-0-agent-builder.log',
              worker: 0,
            },
          ],
        });
      }
      if (p.endsWith('worker-0-agent-builder.log')) {
        return '5 failed\n1 skipped\n24 passed (1.2h)\n';
      }
      throw new Error(`unexpected readFile path: ${p}`);
    });

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.suites).toEqual([
      {
        suite: 'security-alert-triage',
        status: 'pass',
        durationMs: 100,
        logPath: '/tmp/matrix-output/batch-logs/worker-1-security-alert-triage.log',
      },
      {
        suite: 'security-esql-generation-regression',
        status: 'fail',
        durationMs: 4200000,
        logPath: '/tmp/matrix-output/batch-logs/worker-0-agent-builder.log',
        // parsePlaywrightSpecPassRate sums passed+failed+flaky (24+5+0=29) — "skipped"
        // specs aren't counted in the denominator, so this is 24/29, not 24/30.
        specPassRate: 24 / 29,
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
    readdirMock.mockRejectedValue(new Error('ENOENT'));

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('failed');
    expect(result.summaryPath).toBeUndefined();
    expect(result.suites).toEqual([
      { suite: 'security-alert-triage', status: 'fail', durationMs: 0 },
      { suite: 'security-esql-generation-regression', status: 'fail', durationMs: 0 },
    ]);
  });

  it('uses incremental worker JSONL when summary line is missing but state has passes', async () => {
    mockExecFileSuccess('nothing useful here\n');
    readdirMock.mockResolvedValue(['worker-0-results.jsonl']);
    readFileMock.mockImplementation(async (path) => {
      const p = String(path);
      if (p.endsWith('worker-0-results.jsonl')) {
        return JSON.stringify({
          suite: 'security-alert-triage',
          model: 'my-org/my-model',
          status: 'pass',
          duration_ms: 999,
          log_file: '/tmp/a.log',
        }) + '\n';
      }
      throw new Error(`ENOENT ${p}`);
    });

    const runner = new LocalBatchEvalRunner(createConfig());
    const result = await runner.run(baseOpts);

    expect(result.status).toBe('partial');
    expect(result.suites[0]).toEqual({
      suite: 'security-alert-triage',
      status: 'pass',
      durationMs: 999,
      logPath: '/tmp/a.log',
    });
    expect(result.suites[1]?.status).toBe('fail');
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
        bootPollAttempts: 1800,
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

    expect(spawnMock).toHaveBeenCalled();
    const call = spawnMock.mock.calls[0];
    const args = call[1] as string[];
    expect(args).not.toContain('--smoke');
    const options = call[2] as { env?: NodeJS.ProcessEnv; cwd?: string };
    expect(options.env?.BATCH_PAUSE_ALWAYS_ON_STACK).toBe('true');
    expect(options.env?.BATCH_TEARDOWN_ON_EXIT).toBe('true');
    expect(options.env?.BATCH_CLEANUP_STALE_PORTS).toBe('true');
    expect(options.env?.BOOT_POLL_ATTEMPTS).toBe('1800');
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

  it('exposes activePid while a run is in flight and clears it after completion (regression: scheduler shutdown-drain-timeout kill path needs a live PID to target)', async () => {
    let capturedPidDuringRun: number | undefined;
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess();
      process.nextTick(() => {
        // By now onSpawn() has fired synchronously after spawn() returned,
        // so activePid should reflect the in-flight run's PID.
        capturedPidDuringRun = runner.activePid;
        child.stdout.emit(
          'data',
          Buffer.from('[batch 10:00:00] >>> Summary: /plugin/matrix-output/summary.json'),
        );
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({
        run_id: 'r',
        timestamp: 't',
        overall_exit: 0,
        log_dir: '/plugin/matrix-output/batch-logs',
        results: [],
      }),
    );

    const runner = new LocalBatchEvalRunner(createConfig());
    expect(runner.activePid).toBeUndefined();

    await runner.run(baseOpts);

    expect(capturedPidDuringRun).toBe(12345);
    expect(runner.activePid).toBeUndefined();
  });

  it('killActive() sends SIGKILL to the negative (process-group) PID, not the raw child PID', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess();
      return child as unknown as ReturnType<typeof spawn>;
    });

    const runner = new LocalBatchEvalRunner(createConfig());
    // No run in flight — killActive() should be a safe no-op.
    runner.killActive();
    expect(killSpy).not.toHaveBeenCalled();

    // Simulate an in-flight run by triggering run() but not awaiting/resolving it.
    spawnMock.mockImplementation(() => {
      const child = new FakeChildProcess();
      // Never emits 'close' — simulates a hung process.
      return child as unknown as ReturnType<typeof spawn>;
    });
    void runner.run(baseOpts);

    // Let the spawn callback (onSpawn) fire before asserting.
    return new Promise<void>((resolve) => {
      process.nextTick(() => {
        expect(runner.activePid).toBe(12345);
        runner.killActive();
        expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
        killSpy.mockRestore();
        resolve();
      });
    });
  });

  it('kills the process group via SIGTERM when combined stdout+stderr exceeds BATCH_RUNNER_MAX_BUFFER_BYTES (regression: spawn()-based execFilePromise reimplements execFile\'s maxBuffer enforcement manually since spawn has no built-in cap)', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let child!: FakeChildProcess;
    spawnMock.mockImplementation(() => {
      child = new FakeChildProcess();
      return child as unknown as ReturnType<typeof spawn>;
    });

    const runner = new LocalBatchEvalRunner(createConfig());
    const runPromise = runner.run(baseOpts);

    await new Promise((r) => process.nextTick(r));
    expect(runner.activePid).toBe(12345);

    // Emit a chunk larger than the buffer cap — should trigger a SIGTERM kill.
    child.stdout.emit('data', Buffer.alloc(BATCH_RUNNER_MAX_BUFFER_BYTES + 1, 'x'));

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    // Let the (now-killed) child actually close so run() can resolve and the
    // test doesn't leave a dangling promise.
    child.emit('close', null);
    await runPromise;
    killSpy.mockRestore();
  });
});
