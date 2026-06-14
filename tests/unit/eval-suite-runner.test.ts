import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
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

// Keep the real OTelSpanRecorder so we can inspect its file writes in integration tests
vi.mock('../../src/utils/otel-span-recorder.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/otel-span-recorder.js')>('../../src/utils/otel-span-recorder.js');
  return {
    ...actual,
    OTelSpanRecorder: vi.fn().mockImplementation(() => {
      let traceCounter = 0;
      return {
        startSpan: vi.fn((_name: string, _attrs: Record<string, unknown>) => {
          traceCounter++;
          return {
            span: { traceId: `trace-${traceCounter}` },
            end: vi.fn(),
          };
        }),
      };
    }),
  };
});

import { execFile } from 'node:child_process';
import { EvalSuiteRunner, EvalSuiteError, type EvalRunOptions } from '../../src/services/eval-suite-runner.js';
import { ElasticsearchResultsStore } from '../../src/services/elasticsearch-results-store.js';
import { OTelSpanRecorder } from '../../src/utils/otel-span-recorder.js';

const execFileMock = vi.mocked(execFile);

function createMockEsStore(): ElasticsearchResultsStore {
  return {
    saveEvalResult: vi.fn().mockResolvedValue(undefined),
  } as unknown as ElasticsearchResultsStore;
}

function createMockSpanRecorder() {
  let traceCounter = 0;
  return {
    startSpan: vi.fn((_name: string, _attrs: Record<string, unknown>) => {
      traceCounter++;
      return {
        span: { traceId: `trace-${traceCounter}` },
        end: vi.fn(),
      };
    }),
  };
}

function mockExecFileSuccess(stdout: string, stderr: string = '') {
  execFileMock.mockImplementation((_file, _args, _options, _callback) => {
    let callback = _callback;
    if (typeof _options === 'function') {
      callback = _options;
    }
    if (callback) {
      process.nextTick(() => callback(null, stdout, stderr));
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
    const err = new Error(message) as Error & { code: number | null; stdout: string; stderr: string };
    err.code = code;
    err.stdout = stdout;
    err.stderr = stderr;
    if (callback) {
      process.nextTick(() => callback(err, stdout, stderr));
    }
    return null as unknown as ReturnType<typeof execFile>;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvalSuiteRunner', () => {
  let runner: EvalSuiteRunner;
  let store: ElasticsearchResultsStore;
  let mockSpanRecorder: ReturnType<typeof createMockSpanRecorder>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockEsStore();
    mockSpanRecorder = createMockSpanRecorder();
    runner = new EvalSuiteRunner({ esStore: store, spanRecorder: mockSpanRecorder as OTelSpanRecorder });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('run', () => {
    const baseOpts: EvalRunOptions = {
      repoPath: '/tmp/kibana',
      endpointUrl: 'http://localhost:9200',
      modelId: 'meta-llama/Llama-3-8B',
    };

    it('runs all suites and returns success when all pass', async () => {
      mockExecFileSuccess(JSON.stringify({ type: 'result', score: 0.95 }));

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls', 'latency'] });

      expect(result.status).toBe('success');
      expect(result.suiteResults).toHaveLength(2);
      expect(result.suiteResults[0]!.status).toBe('pass');
      expect(result.suiteResults[0]!.score).toBe(0.95);
      expect(result.suiteResults[1]!.status).toBe('pass');
      expect(result.suiteResults[1]!.score).toBe(0.95);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(store.saveEvalResult).toHaveBeenCalledOnce();
    });

    it('uses default suites when not specified', async () => {
      mockExecFileSuccess(JSON.stringify({ type: 'result', score: 0.8 }));

      const result = await runner.run(baseOpts);

      expect(result.suiteResults).toHaveLength(2);
      expect(result.suiteResults.map((r) => r.suite)).toEqual(['tool_calls', 'latency']);
    });

    it('parses score from JSON lines fallback (non-last line)', async () => {
      const stdout = [
        'Running eval...',
        JSON.stringify({ type: 'result', score: 0.82 }),
        'Done.',
      ].join('\n');
      mockExecFileSuccess(stdout);

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(result.suiteResults[0]!.score).toBe(0.82);
    });

    it('returns partial status when one suite fails and one passes', async () => {
      let callIndex = 0;
      execFileMock.mockImplementation((_file, _args, _options, _callback) => {
        let callback = _callback;
        if (typeof _options === 'function') {
          callback = _options;
        }
        callIndex++;
        if (callIndex === 1) {
          if (callback) process.nextTick(() => callback(null, JSON.stringify({ type: 'result', score: 0.9 }), ''));
        } else {
          const err = new Error('timeout') as Error & { code: number | null; stdout: string; stderr: string };
          err.code = 1;
          err.stdout = '';
          err.stderr = '';
          if (callback) process.nextTick(() => callback(err, '', ''));
        }
        return null as unknown as ReturnType<typeof execFile>;
      });

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls', 'latency'] });

      expect(result.status).toBe('partial');
      expect(result.suiteResults[0]!.status).toBe('pass');
      expect(result.suiteResults[1]!.status).toBe('error');
    });

    it('returns failed status when all suites error', async () => {
      mockExecFileFailure('command not found');

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(result.status).toBe('failed');
      expect(result.suiteResults[0]!.status).toBe('error');
    });

    it('handles timeout / kill from execFile', async () => {
      mockExecFileFailure('timeout', '', '', null);

      const result = await runner.run({ ...baseOpts, suites: ['latency'] });

      expect(result.suiteResults[0]!.status).toBe('error');
      expect(result.suiteResults[0]!.error).toBe('timeout');
    });

    it('captures raw stdout in error when parsing fails', async () => {
      mockExecFileSuccess('garbage output without json');

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(result.suiteResults[0]!.status).toBe('fail');
      expect(result.suiteResults[0]!.error).toContain('Unable to parse eval output');
      expect(result.suiteResults[0]!.error).toContain('garbage output');
    });

    it('passes through suite result error field when present in JSON', async () => {
      mockExecFileSuccess(JSON.stringify({ type: 'result', score: 0, error: 'some eval error' }));

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(result.suiteResults[0]!.status).toBe('fail');
      expect(result.suiteResults[0]!.error).toBe('some eval error');
    });

    it('saves to ES even when suites fail', async () => {
      mockExecFileFailure('crash');

      await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(store.saveEvalResult).toHaveBeenCalledOnce();
      const saved = vi.mocked(store.saveEvalResult).mock.calls[0]![0];
      expect(saved.status).toBe('failed');
    });

    it('does not throw when ES save fails', async () => {
      vi.mocked(store.saveEvalResult).mockRejectedValue(new Error('ES down'));
      mockExecFileSuccess(JSON.stringify({ type: 'result', score: 1 }));

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(result.status).toBe('success');
    });

    it('emits OTel spans for each suite', async () => {
      const endSpy = vi.fn();
      mockSpanRecorder.startSpan.mockReturnValue({
        span: { traceId: 'suite-trace-1' } as any,
        end: endSpy,
      });

      mockExecFileSuccess(JSON.stringify({ type: 'result', score: 0.7 }));

      const result = await runner.run({ ...baseOpts, suites: ['tool_calls'] });

      expect(mockSpanRecorder.startSpan).toHaveBeenCalled();
      expect(endSpy).toHaveBeenCalled();
      expect(result.suiteResults[0]!.traceId).toBe('suite-trace-1');
    });

    it('forwards correct command arguments to execFile', async () => {
      mockExecFileSuccess(JSON.stringify({ type: 'result', score: 0.5 }));

      await runner.run({
        ...baseOpts,
        modelId: 'mistral/Mistral-7B',
        endpointUrl: 'http://host:8080',
        suites: ['latency'],
        timeoutMs: 120_000,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        'node',
        ['scripts/evals.js', 'run', '--suite', 'latency', '--endpoint', 'http://host:8080', '--model', 'mistral/Mistral-7B'],
        { cwd: '/tmp/kibana', timeout: 120_000 },
        expect.any(Function),
      );
    });
  });

  describe('EvalSuiteError', () => {
    it('holds suite, exitCode and stderr', () => {
      const err = new EvalSuiteError('boom', 'tool_calls', 127, 'stderr msg');
      expect(err.name).toBe('EvalSuiteError');
      expect(err.suite).toBe('tool_calls');
      expect(err.exitCode).toBe(127);
      expect(err.stderr).toBe('stderr msg');
    });
  });
});
