import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig } from '../../src/types/config.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
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
import * as fs from 'node:fs';
import { KibanaRepoService, KibanaRepoError } from '../../src/services/kibana-repo-service.js';

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(fs.existsSync);
const statSyncMock = vi.mocked(fs.statSync);
const mkdirSyncMock = vi.mocked(fs.mkdirSync);
const writeFileSyncMock = vi.mocked(fs.writeFileSync);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createConfig(overrides: Partial<AppConfig['kibanaRepo']> = {}): AppConfig['kibanaRepo'] {
  return {
    url: 'https://github.com/elastic/kibana.git',
    clonePath: '/tmp/kibana-cache',
    branch: 'main',
    bootstrapTimeoutMs: 1_800_000,
    autoPull: true,
    ...overrides,
  };
}

function mockExecFileSuccess() {
  execFileMock.mockImplementation((_file, _args, _options, _callback) => {
    let callback = _callback;
    if (typeof _options === 'function') {
      callback = _options;
    }
    if (callback) {
      process.nextTick(() => callback(null, 'stdout', 'stderr'));
    }
    return undefined as ReturnType<typeof execFile>;
  });
}

function mockExecFileFailure(message: string) {
  execFileMock.mockImplementation((_file, _args, _options, _callback) => {
    let callback = _callback;
    if (typeof _options === 'function') {
      callback = _options;
    }
    if (callback) {
      process.nextTick(() => callback(new Error(message), '', ''));
    }
    return undefined as ReturnType<typeof execFile>;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KibanaRepoService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRepoPath', () => {
    it('returns cacheDir when provided', () => {
      const service = new KibanaRepoService({
        config: { kibanaRepo: createConfig({ cacheDir: '/custom/cache' }) },
      });
      expect(service.getRepoPath()).toBe('/custom/cache');
    });

    it('falls back to clonePath when cacheDir is missing', () => {
      const service = new KibanaRepoService({
        config: { kibanaRepo: createConfig({ clonePath: '/fallback/path' }) },
      });
      expect(service.getRepoPath()).toBe('/fallback/path');
    });
  });

  describe('cloneOrPull', () => {
    it('clones when directory does not exist', async () => {
      existsSyncMock.mockReturnValue(false);
      mockExecFileSuccess();

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      await service.cloneOrPull();

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/elastic/kibana.git', '/tmp/kibana-cache', '--depth', '1', '--branch', 'main'],
        undefined,
        expect.any(Function),
      );
    });

    it('pulls when directory exists', async () => {
      existsSyncMock.mockReturnValue(true);
      mockExecFileSuccess();

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      await service.cloneOrPull();

      expect(execFileMock).toHaveBeenCalledTimes(3);
      expect(execFileMock).toHaveBeenNthCalledWith(
        1,
        'git',
        ['fetch', 'origin'],
        { cwd: '/tmp/kibana-cache' },
        expect.any(Function),
      );
      expect(execFileMock).toHaveBeenNthCalledWith(
        2,
        'git',
        ['checkout', 'main'],
        { cwd: '/tmp/kibana-cache' },
        expect.any(Function),
      );
      expect(execFileMock).toHaveBeenNthCalledWith(
        3,
        'git',
        ['pull', 'origin', 'main'],
        { cwd: '/tmp/kibana-cache' },
        expect.any(Function),
      );
    });

    it('throws KibanaRepoError when clone fails', async () => {
      existsSyncMock.mockReturnValue(false);
      mockExecFileFailure('network error');

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      await expect(service.cloneOrPull()).rejects.toThrow(KibanaRepoError);
      await expect(service.cloneOrPull()).rejects.toThrow('network error');
    });

    it('throws KibanaRepoError with type clone on clone failure', async () => {
      existsSyncMock.mockReturnValue(false);
      mockExecFileFailure('network error');

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      try {
        await service.cloneOrPull();
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(KibanaRepoError);
        expect((err as KibanaRepoError).type).toBe('clone');
      }
    });

    it('throws KibanaRepoError with type checkout on pull failure', async () => {
      existsSyncMock.mockReturnValue(true);
      mockExecFileFailure('merge conflict');

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      try {
        await service.cloneOrPull();
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(KibanaRepoError);
        expect((err as KibanaRepoError).type).toBe('checkout');
      }
    });
  });

  describe('bootstrap', () => {
    it('runs bootstrap when marker does not exist', async () => {
      existsSyncMock.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.bootstrap-complete')) return false;
        return true;
      });
      mockExecFileSuccess();

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      await service.bootstrap();

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock).toHaveBeenCalledWith(
        'yarn',
        ['kbn', 'bootstrap'],
        { cwd: '/tmp/kibana-cache', timeout: 1_800_000 },
        expect.any(Function),
      );
      expect(mkdirSyncMock).toHaveBeenCalled();
      expect(writeFileSyncMock).toHaveBeenCalled();
    });

    it('skips bootstrap when marker exists and package.json is unchanged', async () => {
      existsSyncMock.mockReturnValue(true);
      statSyncMock.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.bootstrap-complete')) {
          return { mtimeMs: 2000 } as fs.Stats;
        }
        return { mtimeMs: 1000 } as fs.Stats;
      });

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      await service.bootstrap();

      expect(execFileMock).not.toHaveBeenCalled();
      expect(writeFileSyncMock).not.toHaveBeenCalled();
    });

    it('runs bootstrap when marker exists but package.json is newer', async () => {
      existsSyncMock.mockReturnValue(true);
      statSyncMock.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.bootstrap-complete')) {
          return { mtimeMs: 1000 } as fs.Stats;
        }
        return { mtimeMs: 2000 } as fs.Stats;
      });
      mockExecFileSuccess();

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      await service.bootstrap();

      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(writeFileSyncMock).toHaveBeenCalled();
    });

    it('throws KibanaRepoError with type bootstrap on bootstrap failure', async () => {
      existsSyncMock.mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.bootstrap-complete')) return false;
        return true;
      });
      mockExecFileFailure('bootstrap timeout');

      const service = new KibanaRepoService({ config: { kibanaRepo: createConfig() } });
      try {
        await service.bootstrap();
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(KibanaRepoError);
        expect((err as KibanaRepoError).type).toBe('bootstrap');
      }
    });
  });
});
