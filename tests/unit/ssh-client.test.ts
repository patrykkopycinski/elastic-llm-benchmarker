import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  SSHClientPool,
  SSHError,
  SSHConnectionError,
  SSHTimeoutError,
  SSHTransferError,
} from '../../src/services/ssh-client.js';
import type {
  CommandResult,
  ExecOptions,
  SSHClientPoolOptions,
  ConnectionStatus,
} from '../../src/services/ssh-client.js';
import type { SSHConfig } from '../../src/types/config.js';

// ─── Mock SSH2 ────────────────────────────────────────────────────────────────

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
  write = vi.fn();
}

class MockSFTPWrapper extends EventEmitter {
  fastPut = vi.fn();
  fastGet = vi.fn();
  createWriteStream = vi.fn();
  createReadStream = vi.fn();
}

class MockClient extends EventEmitter {
  private _readyCallback: (() => void) | null = null;
  private _shouldFailConnect = false;
  private _connectError: Error | null = null;
  private _execHandler: ((command: string, options: unknown, callback: Function) => void) | null =
    null;
  private _sftpHandler: ((callback: Function) => void) | null = null;

  connect = vi.fn().mockImplementation(() => {
    if (this._shouldFailConnect) {
      setTimeout(() => {
        this.emit('error', this._connectError ?? new Error('Connection refused'));
      }, 0);
    } else {
      setTimeout(() => {
        this.emit('ready');
      }, 0);
    }
  });

  end = vi.fn();

  exec = vi.fn().mockImplementation(
    (command: string, options: unknown, callback: (err: Error | null, stream: MockStream) => void) => {
      if (this._execHandler) {
        this._execHandler(command, options, callback);
        return;
      }

      const stream = new MockStream();
      callback(null, stream);

      // Default: emit successful completion
      setTimeout(() => {
        stream.emit('data', Buffer.from('mock output'));
        stream.emit('close', 0, null);
      }, 0);
    },
  );

  sftp = vi.fn().mockImplementation((callback: (err: Error | null, sftp: MockSFTPWrapper) => void) => {
    if (this._sftpHandler) {
      this._sftpHandler(callback);
      return;
    }
    const sftp = new MockSFTPWrapper();
    callback(null, sftp);
  });

  setFailConnect(error?: Error): void {
    this._shouldFailConnect = true;
    this._connectError = error ?? new Error('Connection refused');
  }

  setExecHandler(
    handler: (command: string, options: unknown, callback: Function) => void,
  ): void {
    this._execHandler = handler;
  }

  setSftpHandler(handler: (callback: Function) => void): void {
    this._sftpHandler = handler;
  }
}

// Mock the ssh2 module
vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => new MockClient()),
}));

// Mock fs for file operations
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-private-key')),
    mkdirSync: vi.fn(),
  };
});

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function createMockSSHConfig(overrides: Partial<SSHConfig> = {}): SSHConfig {
  return {
    host: '10.0.0.1',
    port: 22,
    username: 'testuser',
    password: 'testpass',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SSHClientPool', () => {
  let pool: SSHClientPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new SSHClientPool(
      {
        maxRetries: 2,
        retryDelay: 10,
        connectTimeout: 5000,
        idleTimeout: 30000,
        keepAliveInterval: 5000,
      },
      'error',
    );
  });

  afterEach(async () => {
    await pool.close();
  });

  describe('constructor', () => {
    it('should create pool with default options', () => {
      const defaultPool = new SSHClientPool({}, 'error');
      expect(defaultPool).toBeInstanceOf(SSHClientPool);
      defaultPool.close();
    });

    it('should create pool with custom options', () => {
      const customPool = new SSHClientPool(
        {
          maxConnectionsPerHost: 10,
          idleTimeout: 60000,
          maxRetries: 5,
          retryDelay: 1000,
          connectTimeout: 15000,
          keepAliveInterval: 30000,
        },
        'error',
      );
      expect(customPool).toBeInstanceOf(SSHClientPool);
      customPool.close();
    });
  });

  describe('exec', () => {
    it('should execute a command and return result', async () => {
      const config = createMockSSHConfig();
      const result = await pool.exec(config, 'echo hello');

      expect(result).toBeDefined();
      expect(result.command).toBe('echo hello');
      expect(result.stdout).toBe('mock output');
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
      expect(result.durationMs).toBeTypeOf('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should return failure for non-zero exit code', async () => {
      const { Client } = await import('ssh2');
      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setExecHandler((_cmd, _opts, callback) => {
        const stream = new MockStream();
        (callback as Function)(null, stream);
        setTimeout(() => {
          stream.stderr.emit('data', Buffer.from('command not found'));
          stream.emit('close', 127, null);
        }, 0);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      // Close existing pool and create new one so it picks up the mock
      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      const result = await pool.exec(config, 'invalid_command');

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe('command not found');
    });

    it('should capture both stdout and stderr', async () => {
      const { Client } = await import('ssh2');
      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setExecHandler((_cmd, _opts, callback) => {
        const stream = new MockStream();
        (callback as Function)(null, stream);
        setTimeout(() => {
          stream.emit('data', Buffer.from('output line 1\n'));
          stream.emit('data', Buffer.from('output line 2\n'));
          stream.stderr.emit('data', Buffer.from('warning: something'));
          stream.emit('close', 0, null);
        }, 0);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      const result = await pool.exec(config, 'some-command');

      expect(result.stdout).toBe('output line 1\noutput line 2\n');
      expect(result.stderr).toBe('warning: something');
      expect(result.success).toBe(true);
    });

    it('should handle signal-killed process', async () => {
      const { Client } = await import('ssh2');
      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setExecHandler((_cmd, _opts, callback) => {
        const stream = new MockStream();
        (callback as Function)(null, stream);
        setTimeout(() => {
          stream.emit('close', null, 'SIGKILL');
        }, 0);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      const result = await pool.exec(config, 'long-running-process');

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe('SIGKILL');
      expect(result.success).toBe(false);
    });

    it('should build sudo command when sudo option is true', async () => {
      const { Client } = await import('ssh2');
      let executedCommand = '';
      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setExecHandler((cmd, _opts, callback) => {
        executedCommand = cmd as string;
        const stream = new MockStream();
        (callback as Function)(null, stream);
        setTimeout(() => {
          stream.emit('data', Buffer.from('root'));
          stream.emit('close', 0, null);
        }, 0);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig({ password: 'mypassword' });
      await pool.exec(config, 'whoami', { sudo: true });

      expect(executedCommand).toContain('sudo');
      expect(executedCommand).toContain('whoami');
    });

    it('should build command with working directory when cwd is specified', async () => {
      const { Client } = await import('ssh2');
      let executedCommand = '';
      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setExecHandler((cmd, _opts, callback) => {
        executedCommand = cmd as string;
        const stream = new MockStream();
        (callback as Function)(null, stream);
        setTimeout(() => {
          stream.emit('data', Buffer.from(''));
          stream.emit('close', 0, null);
        }, 0);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      await pool.exec(config, 'ls -la', { cwd: '/tmp/workdir' });

      expect(executedCommand).toContain('cd');
      expect(executedCommand).toContain('/tmp/workdir');
      expect(executedCommand).toContain('ls -la');
    });

    it('should respect timeout and throw SSHTimeoutError', async () => {
      const { Client } = await import('ssh2');
      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setExecHandler((_cmd, _opts, callback) => {
        const stream = new MockStream();
        (callback as Function)(null, stream);
        // Never emit close - simulating a hung command
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();

      await expect(pool.exec(config, 'sleep 999', { timeout: 50 })).rejects.toThrow(
        SSHTimeoutError,
      );
    });

    it('should use default timeout when not specified', async () => {
      const config = createMockSSHConfig();
      const result = await pool.exec(config, 'echo test');

      // Should complete without timeout since mock resolves immediately
      expect(result.success).toBe(true);
    });
  });

  describe('connection pooling', () => {
    it('should reuse existing connections', async () => {
      const { Client } = await import('ssh2');
      const config = createMockSSHConfig();

      await pool.exec(config, 'echo first');
      await pool.exec(config, 'echo second');

      // Client constructor should only be called once (connection reuse)
      expect(Client).toHaveBeenCalledTimes(1);
    });

    it('should create separate connections for different hosts', async () => {
      const { Client } = await import('ssh2');
      const config1 = createMockSSHConfig({ host: '10.0.0.1' });
      const config2 = createMockSSHConfig({ host: '10.0.0.2' });

      await pool.exec(config1, 'echo hello');
      await pool.exec(config2, 'echo hello');

      // Each host should get its own connection
      expect(Client).toHaveBeenCalledTimes(2);
    });

    it('should create separate connections for different users on same host', async () => {
      const { Client } = await import('ssh2');
      const config1 = createMockSSHConfig({ username: 'user1' });
      const config2 = createMockSSHConfig({ username: 'user2' });

      await pool.exec(config1, 'echo hello');
      await pool.exec(config2, 'echo hello');

      expect(Client).toHaveBeenCalledTimes(2);
    });
  });

  describe('isConnected', () => {
    it('should return false when no connection exists', () => {
      const config = createMockSSHConfig();
      expect(pool.isConnected(config)).toBe(false);
    });

    it('should return true after establishing a connection', async () => {
      const config = createMockSSHConfig();
      await pool.exec(config, 'echo test');

      expect(pool.isConnected(config)).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return empty array when no connections exist', () => {
      const status = pool.getStatus();
      expect(status).toEqual([]);
    });

    it('should return status for established connections', async () => {
      const config = createMockSSHConfig();
      await pool.exec(config, 'echo test');
      await pool.exec(config, 'echo test2');

      const status = pool.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0]!.key).toBe('10.0.0.1:22:testuser');
      expect(status[0]!.connected).toBe(true);
      expect(status[0]!.totalCommandsExecuted).toBe(2);
      expect(status[0]!.lastActivity).toBeTruthy();
    });
  });

  describe('disconnect', () => {
    it('should disconnect a specific host', async () => {
      const config = createMockSSHConfig();
      await pool.exec(config, 'echo test');

      expect(pool.isConnected(config)).toBe(true);

      await pool.disconnect(config);
      expect(pool.isConnected(config)).toBe(false);
    });

    it('should not throw when disconnecting non-existent connection', async () => {
      const config = createMockSSHConfig({ host: 'nonexistent' });
      await expect(pool.disconnect(config)).resolves.not.toThrow();
    });
  });

  describe('close', () => {
    it('should close all connections', async () => {
      const config1 = createMockSSHConfig({ host: '10.0.0.1' });
      const config2 = createMockSSHConfig({ host: '10.0.0.2' });

      await pool.exec(config1, 'echo test');
      await pool.exec(config2, 'echo test');

      expect(pool.getStatus()).toHaveLength(2);

      await pool.close();
      expect(pool.getStatus()).toHaveLength(0);
    });

    it('should reject new connections after close', async () => {
      await pool.close();
      const config = createMockSSHConfig();

      await expect(pool.exec(config, 'echo test')).rejects.toThrow(SSHError);
    });
  });

  describe('error classes', () => {
    it('should create SSHError with correct properties', () => {
      const cause = new Error('underlying error');
      const error = new SSHError('test message', '10.0.0.1', cause);

      expect(error.name).toBe('SSHError');
      expect(error.message).toBe('test message');
      expect(error.host).toBe('10.0.0.1');
      expect(error.cause).toBe(cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SSHError);
    });

    it('should create SSHConnectionError with retry info', () => {
      const cause = new Error('connection refused');
      const error = new SSHConnectionError('10.0.0.1', 3, 5, cause);

      expect(error.name).toBe('SSHConnectionError');
      expect(error.host).toBe('10.0.0.1');
      expect(error.attempt).toBe(3);
      expect(error.maxRetries).toBe(5);
      expect(error.message).toContain('attempt 3/5');
      expect(error.message).toContain('connection refused');
      expect(error).toBeInstanceOf(SSHError);
    });

    it('should create SSHTimeoutError with command and timeout info', () => {
      const error = new SSHTimeoutError('10.0.0.1', 'docker ps', 30000);

      expect(error.name).toBe('SSHTimeoutError');
      expect(error.host).toBe('10.0.0.1');
      expect(error.command).toBe('docker ps');
      expect(error.timeoutMs).toBe(30000);
      expect(error.message).toContain('30000ms');
      expect(error.message).toContain('docker ps');
      expect(error).toBeInstanceOf(SSHError);
    });

    it('should create SSHTransferError with transfer details', () => {
      const cause = new Error('no such file');
      const error = new SSHTransferError(
        '10.0.0.1',
        'upload',
        '/local/file.sh',
        '/remote/file.sh',
        cause,
      );

      expect(error.name).toBe('SSHTransferError');
      expect(error.host).toBe('10.0.0.1');
      expect(error.operation).toBe('upload');
      expect(error.localPath).toBe('/local/file.sh');
      expect(error.remotePath).toBe('/remote/file.sh');
      expect(error.message).toContain('upload');
      expect(error.message).toContain('/local/file.sh');
      expect(error.message).toContain('/remote/file.sh');
      expect(error).toBeInstanceOf(SSHError);
    });
  });

  describe('CommandResult interface', () => {
    it('should have all expected fields on success', async () => {
      const config = createMockSSHConfig();
      const result = await pool.exec(config, 'echo hello');

      // Verify CommandResult shape
      const keys = Object.keys(result);
      expect(keys).toContain('command');
      expect(keys).toContain('stdout');
      expect(keys).toContain('stderr');
      expect(keys).toContain('exitCode');
      expect(keys).toContain('signal');
      expect(keys).toContain('success');
      expect(keys).toContain('durationMs');
    });
  });

  describe('authentication', () => {
    it('should support password authentication', async () => {
      const config = createMockSSHConfig({ password: 'mypass' });
      const result = await pool.exec(config, 'echo test');
      expect(result.success).toBe(true);
    });

    it('should support private key authentication', async () => {
      const config = createMockSSHConfig({
        password: undefined,
        privateKeyPath: '/home/user/.ssh/id_rsa',
      });
      const result = await pool.exec(config, 'echo test');
      expect(result.success).toBe(true);
    });
  });

  describe('upload', () => {
    it('should throw SSHTransferError when local file does not exist', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);

      const config = createMockSSHConfig();
      await expect(
        pool.upload(config, '/nonexistent/file.txt', '/remote/file.txt'),
      ).rejects.toThrow(SSHTransferError);
    });

    it('should call sftp.fastPut for file upload', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      mockSftp.fastPut.mockImplementation(
        (_local: string, _remote: string, _opts: unknown, callback: (err: Error | null) => void) => {
          callback(null);
        },
      );

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      await pool.upload(config, '/local/file.txt', '/remote/file.txt');

      expect(mockSftp.fastPut).toHaveBeenCalled();
    });

    it('should throw SSHTransferError when sftp.fastPut fails', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      mockSftp.fastPut.mockImplementation(
        (_local: string, _remote: string, _opts: unknown, callback: (err: Error | null) => void) => {
          callback(new Error('Permission denied'));
        },
      );

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      await expect(
        pool.upload(config, '/local/file.txt', '/remote/file.txt'),
      ).rejects.toThrow(SSHTransferError);
    });
  });

  describe('download', () => {
    it('should call sftp.fastGet for file download', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      mockSftp.fastGet.mockImplementation(
        (_remote: string, _local: string, callback: (err: Error | null) => void) => {
          callback(null);
        },
      );

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      await pool.download(config, '/remote/file.txt', '/local/file.txt');

      expect(mockSftp.fastGet).toHaveBeenCalled();
    });

    it('should throw SSHTransferError when sftp.fastGet fails', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      mockSftp.fastGet.mockImplementation(
        (_remote: string, _local: string, callback: (err: Error | null) => void) => {
          callback(new Error('No such file'));
        },
      );

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      await expect(
        pool.download(config, '/remote/file.txt', '/local/file.txt'),
      ).rejects.toThrow(SSHTransferError);
    });
  });

  describe('uploadContent', () => {
    it('should upload string content via SFTP write stream', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      const mockWriteStream = new EventEmitter() as EventEmitter & { end?: Function };
      // Simulate a writable stream
      (mockWriteStream as unknown as { write: Function }).write = vi.fn();
      mockWriteStream.end = vi.fn();

      mockSftp.createWriteStream.mockReturnValue(mockWriteStream);

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      const uploadPromise = pool.uploadContent(config, 'file content here', '/remote/script.sh');

      // Simulate stream close after pipe completes
      setTimeout(() => {
        mockWriteStream.emit('close');
      }, 10);

      await uploadPromise;
      expect(mockSftp.createWriteStream).toHaveBeenCalledWith('/remote/script.sh', { mode: 0o644 });
    });
  });

  describe('downloadContent', () => {
    it('should download file content as string', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      const mockReadStream = new EventEmitter();

      mockSftp.createReadStream.mockReturnValue(mockReadStream);

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      const downloadPromise = pool.downloadContent(config, '/remote/output.log');

      // Simulate reading data
      setTimeout(() => {
        mockReadStream.emit('data', Buffer.from('line 1\n'));
        mockReadStream.emit('data', Buffer.from('line 2\n'));
        mockReadStream.emit('end');
      }, 10);

      const content = await downloadPromise;
      expect(content).toBe('line 1\nline 2\n');
    });

    it('should throw SSHTransferError when read stream errors', async () => {
      const { Client } = await import('ssh2');
      const mockSftp = new MockSFTPWrapper();
      const mockReadStream = new EventEmitter();

      mockSftp.createReadStream.mockReturnValue(mockReadStream);

      const mockClient = new (Client as unknown as typeof MockClient)() as unknown as MockClient;
      mockClient.setSftpHandler((callback) => {
        (callback as Function)(null, mockSftp);
      });

      vi.mocked(Client).mockImplementationOnce(() => mockClient as unknown as InstanceType<typeof Client>);

      await pool.close();
      pool = new SSHClientPool({ maxRetries: 1, retryDelay: 10, connectTimeout: 5000 }, 'error');

      const config = createMockSSHConfig();
      const downloadPromise = pool.downloadContent(config, '/remote/missing.log');

      setTimeout(() => {
        mockReadStream.emit('error', new Error('No such file'));
      }, 10);

      await expect(downloadPromise).rejects.toThrow(SSHTransferError);
    });
  });
});
