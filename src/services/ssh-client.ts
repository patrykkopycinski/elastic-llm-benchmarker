import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { SSHConfig } from '../types/config.js';
import { createLogger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Result of executing a command over SSH */
export interface CommandResult {
  /** The command that was executed */
  command: string;
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
  /** Exit code from the remote process (null if signal-killed) */
  exitCode: number | null;
  /** Signal name if the process was killed by a signal */
  signal: string | null;
  /** Whether the command completed successfully (exit code 0) */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/** Options for command execution */
export interface ExecOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Whether to run the command with sudo (default: false) */
  sudo?: boolean;
  /** Password for sudo authentication (uses SSH password if not provided) */
  sudoPassword?: string;
  /** Environment variables to set for the command */
  env?: Record<string, string>;
  /** Working directory for the command */
  cwd?: string;
}

/** Options for file transfer operations */
export interface TransferOptions {
  /** File permissions mode (default: 0o644) */
  mode?: number;
  /** Timeout in milliseconds for the transfer (default: 60000) */
  timeout?: number;
}

/** Options for SSH client pool configuration */
export interface SSHClientPoolOptions {
  /** Maximum number of concurrent connections per host (default: 5) */
  maxConnectionsPerHost?: number;
  /** Connection idle timeout in milliseconds before automatic cleanup (default: 300000 = 5 min) */
  idleTimeout?: number;
  /** Maximum number of retry attempts for failed connections (default: 3) */
  maxRetries?: number;
  /** Delay between retry attempts in milliseconds (default: 2000) */
  retryDelay?: number;
  /** SSH connection timeout in milliseconds (default: 10000) */
  connectTimeout?: number;
  /** Keep-alive interval in milliseconds (default: 15000) */
  keepAliveInterval?: number;
}

/** Connection health status */
export interface ConnectionStatus {
  /** Unique connection key (host:port:username) */
  key: string;
  /** Whether the connection is currently active */
  connected: boolean;
  /** Number of active connections for this host */
  activeConnections: number;
  /** Timestamp of the last activity */
  lastActivity: string;
  /** Total commands executed on this connection */
  totalCommandsExecuted: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_EXEC_TIMEOUT = 30_000;
const DEFAULT_TRANSFER_TIMEOUT = 60_000;
const DEFAULT_MAX_CONNECTIONS_PER_HOST = 5;
const DEFAULT_IDLE_TIMEOUT = 300_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 2_000;
const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_KEEP_ALIVE_INTERVAL = 15_000;

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error class for SSH operations */
export class SSHError extends Error {
  constructor(
    message: string,
    public readonly host: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'SSHError';
  }
}

/** Error thrown when SSH connection fails */
export class SSHConnectionError extends SSHError {
  constructor(
    host: string,
    public readonly attempt: number,
    public readonly maxRetries: number,
    cause?: Error,
  ) {
    super(
      `SSH connection to ${host} failed (attempt ${attempt}/${maxRetries}): ${cause?.message ?? 'unknown error'}`,
      host,
      cause,
    );
    this.name = 'SSHConnectionError';
  }
}

/** Error thrown when a command execution times out */
export class SSHTimeoutError extends SSHError {
  constructor(
    host: string,
    public readonly command: string,
    public readonly timeoutMs: number,
  ) {
    super(`Command timed out after ${timeoutMs}ms on ${host}: ${command}`, host);
    this.name = 'SSHTimeoutError';
  }
}

/** Error thrown when a file transfer fails */
export class SSHTransferError extends SSHError {
  constructor(
    host: string,
    public readonly operation: 'upload' | 'download',
    public readonly localPath: string,
    public readonly remotePath: string,
    cause?: Error,
  ) {
    super(
      `File ${operation} failed on ${host}: ${localPath} <-> ${remotePath}: ${cause?.message ?? 'unknown error'}`,
      host,
      cause,
    );
    this.name = 'SSHTransferError';
  }
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface PooledConnection {
  client: Client;
  key: string;
  config: SSHConfig;
  connected: boolean;
  lastActivity: Date;
  totalCommandsExecuted: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── SSH Client Service ───────────────────────────────────────────────────────

/**
 * SSH client service with connection pooling for VM communication.
 *
 * Provides reliable SSH connectivity with:
 * - Connection pooling and reuse
 * - Automatic reconnection on failure
 * - Command execution with configurable timeouts
 * - Sudo command support
 * - SFTP file upload and download
 * - Keep-alive heartbeats
 * - Graceful connection lifecycle management
 *
 * @example
 * ```typescript
 * const pool = new SSHClientPool({ maxRetries: 3 });
 * const config: SSHConfig = { host: '10.0.0.1', port: 22, username: 'user', privateKeyPath: '~/.ssh/id_rsa' };
 *
 * const result = await pool.exec(config, 'docker ps');
 * console.log(result.stdout);
 *
 * await pool.upload(config, './local-file.sh', '/home/user/script.sh');
 * await pool.close();
 * ```
 */
export class SSHClientPool {
  private readonly logger;
  private readonly connections: Map<string, PooledConnection> = new Map();
  private readonly options: Required<SSHClientPoolOptions>;
  private closed = false;

  /**
   * Creates a new SSHClientPool instance.
   *
   * @param poolOptions - Pool configuration options
   * @param logLevel - Winston log level (default: 'info')
   */
  constructor(poolOptions: SSHClientPoolOptions = {}, logLevel: string = 'info') {
    this.logger = createLogger(logLevel);
    this.options = {
      maxConnectionsPerHost: poolOptions.maxConnectionsPerHost ?? DEFAULT_MAX_CONNECTIONS_PER_HOST,
      idleTimeout: poolOptions.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
      maxRetries: poolOptions.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelay: poolOptions.retryDelay ?? DEFAULT_RETRY_DELAY,
      connectTimeout: poolOptions.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
      keepAliveInterval: poolOptions.keepAliveInterval ?? DEFAULT_KEEP_ALIVE_INTERVAL,
    };

    this.logger.info('SSHClientPool initialized', {
      maxConnectionsPerHost: this.options.maxConnectionsPerHost,
      idleTimeout: this.options.idleTimeout,
      maxRetries: this.options.maxRetries,
    });
  }

  /**
   * Executes a command on a remote host over SSH.
   *
   * Automatically manages connection pooling, reconnection, and timeouts.
   * Commands can be run with sudo by setting `options.sudo = true`.
   *
   * @param config - SSH connection configuration
   * @param command - The shell command to execute
   * @param options - Execution options (timeout, sudo, env, cwd)
   * @returns The command execution result
   * @throws {SSHConnectionError} If the connection cannot be established
   * @throws {SSHTimeoutError} If the command exceeds the timeout
   * @throws {SSHError} For other SSH-related failures
   */
  async exec(config: SSHConfig, command: string, options: ExecOptions = {}): Promise<CommandResult> {
    const timeout = options.timeout ?? DEFAULT_EXEC_TIMEOUT;
    const startTime = Date.now();

    const connection = await this.getConnection(config);
    const actualCommand = this.buildCommand(command, config, options);

    this.logger.debug(`Executing command on ${config.host}`, {
      command: actualCommand,
      timeout,
      sudo: options.sudo ?? false,
    });

    // Clear idle timer during command execution to prevent the connection
    // from being closed while a long-running command (like benchmarks) is active.
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = null;
    }

    try {
      const result = await this.executeCommand(connection, actualCommand, timeout, options);
      connection.totalCommandsExecuted++;
      connection.lastActivity = new Date();
      this.resetIdleTimer(connection);

      const durationMs = Date.now() - startTime;
      const commandResult: CommandResult = {
        command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
        success: result.exitCode === 0,
        durationMs,
      };

      this.logger.debug(`Command completed on ${config.host}`, {
        exitCode: commandResult.exitCode,
        durationMs,
        success: commandResult.success,
      });

      return commandResult;
    } catch (err) {
      this.resetIdleTimer(connection);

      if (err instanceof SSHTimeoutError || err instanceof SSHError) {
        throw err;
      }

      // Connection may have dropped; try to reconnect once
      if (this.isConnectionError(err)) {
        this.logger.warn(`Connection lost to ${config.host}, attempting reconnect...`);
        this.removeConnection(connection.key);

        const newConnection = await this.getConnection(config);
        const retryResult = await this.executeCommand(newConnection, actualCommand, timeout, options);
        newConnection.totalCommandsExecuted++;
        newConnection.lastActivity = new Date();
        this.resetIdleTimer(newConnection);

        const durationMs = Date.now() - startTime;
        return {
          command,
          stdout: retryResult.stdout,
          stderr: retryResult.stderr,
          exitCode: retryResult.exitCode,
          signal: retryResult.signal,
          success: retryResult.exitCode === 0,
          durationMs,
        };
      }

      throw new SSHError(
        `Command execution failed on ${config.host}: ${err instanceof Error ? err.message : String(err)}`,
        config.host,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Uploads a local file to a remote host via SFTP.
   *
   * @param config - SSH connection configuration
   * @param localPath - Path to the local file
   * @param remotePath - Destination path on the remote host
   * @param options - Transfer options (mode, timeout)
   * @throws {SSHTransferError} If the upload fails
   * @throws {SSHConnectionError} If the connection cannot be established
   */
  async upload(
    config: SSHConfig,
    localPath: string,
    remotePath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TRANSFER_TIMEOUT;
    const mode = options.mode ?? 0o644;

    this.logger.info(`Uploading file to ${config.host}`, { localPath, remotePath });

    if (!fs.existsSync(localPath)) {
      throw new SSHTransferError(
        config.host,
        'upload',
        localPath,
        remotePath,
        new Error(`Local file not found: ${localPath}`),
      );
    }

    const connection = await this.getConnection(config);

    try {
      const sftp = await this.getSftp(connection);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new SSHTransferError(
              config.host,
              'upload',
              localPath,
              remotePath,
              new Error(`Upload timed out after ${timeout}ms`),
            ),
          );
        }, timeout);

        sftp.fastPut(localPath, remotePath, { mode }, (err) => {
          clearTimeout(timer);
          if (err) {
            reject(
              new SSHTransferError(config.host, 'upload', localPath, remotePath, err),
            );
          } else {
            resolve();
          }
        });
      });

      connection.lastActivity = new Date();
      this.resetIdleTimer(connection);
      this.logger.info(`Upload completed to ${config.host}:${remotePath}`);
    } catch (err) {
      if (err instanceof SSHTransferError) {
        throw err;
      }
      throw new SSHTransferError(
        config.host,
        'upload',
        localPath,
        remotePath,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Uploads string content as a file to a remote host via SFTP.
   *
   * @param config - SSH connection configuration
   * @param content - The string content to upload
   * @param remotePath - Destination path on the remote host
   * @param options - Transfer options (mode, timeout)
   * @throws {SSHTransferError} If the upload fails
   */
  async uploadContent(
    config: SSHConfig,
    content: string,
    remotePath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TRANSFER_TIMEOUT;
    const mode = options.mode ?? 0o644;

    this.logger.info(`Uploading content to ${config.host}:${remotePath}`, {
      contentLength: content.length,
    });

    const connection = await this.getConnection(config);

    try {
      const sftp = await this.getSftp(connection);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new SSHTransferError(
              config.host,
              'upload',
              '<content>',
              remotePath,
              new Error(`Upload timed out after ${timeout}ms`),
            ),
          );
        }, timeout);

        const writeStream = sftp.createWriteStream(remotePath, { mode });
        const readStream = Readable.from([content]);

        writeStream.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(
            new SSHTransferError(config.host, 'upload', '<content>', remotePath, err),
          );
        });

        writeStream.on('close', () => {
          clearTimeout(timer);
          resolve();
        });

        readStream.pipe(writeStream);
      });

      connection.lastActivity = new Date();
      this.resetIdleTimer(connection);
      this.logger.info(`Content upload completed to ${config.host}:${remotePath}`);
    } catch (err) {
      if (err instanceof SSHTransferError) {
        throw err;
      }
      throw new SSHTransferError(
        config.host,
        'upload',
        '<content>',
        remotePath,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Downloads a file from a remote host via SFTP.
   *
   * @param config - SSH connection configuration
   * @param remotePath - Path to the remote file
   * @param localPath - Destination path on the local machine
   * @param options - Transfer options (timeout)
   * @throws {SSHTransferError} If the download fails
   * @throws {SSHConnectionError} If the connection cannot be established
   */
  async download(
    config: SSHConfig,
    remotePath: string,
    localPath: string,
    options: TransferOptions = {},
  ): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_TRANSFER_TIMEOUT;

    this.logger.info(`Downloading file from ${config.host}`, { remotePath, localPath });

    // Ensure local directory exists
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const connection = await this.getConnection(config);

    try {
      const sftp = await this.getSftp(connection);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new SSHTransferError(
              config.host,
              'download',
              localPath,
              remotePath,
              new Error(`Download timed out after ${timeout}ms`),
            ),
          );
        }, timeout);

        sftp.fastGet(remotePath, localPath, (err) => {
          clearTimeout(timer);
          if (err) {
            reject(
              new SSHTransferError(config.host, 'download', localPath, remotePath, err),
            );
          } else {
            resolve();
          }
        });
      });

      connection.lastActivity = new Date();
      this.resetIdleTimer(connection);
      this.logger.info(`Download completed from ${config.host}:${remotePath}`);
    } catch (err) {
      if (err instanceof SSHTransferError) {
        throw err;
      }
      throw new SSHTransferError(
        config.host,
        'download',
        localPath,
        remotePath,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Downloads a file from a remote host and returns its content as a string.
   *
   * @param config - SSH connection configuration
   * @param remotePath - Path to the remote file
   * @param options - Transfer options (timeout)
   * @returns The file content as a string
   * @throws {SSHTransferError} If the download fails
   */
  async downloadContent(
    config: SSHConfig,
    remotePath: string,
    options: TransferOptions = {},
  ): Promise<string> {
    const timeout = options.timeout ?? DEFAULT_TRANSFER_TIMEOUT;

    this.logger.debug(`Downloading content from ${config.host}:${remotePath}`);

    const connection = await this.getConnection(config);

    try {
      const sftp = await this.getSftp(connection);

      const content = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new SSHTransferError(
              config.host,
              'download',
              '<content>',
              remotePath,
              new Error(`Download timed out after ${timeout}ms`),
            ),
          );
        }, timeout);

        const chunks: Buffer[] = [];
        const readStream = sftp.createReadStream(remotePath);

        readStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        readStream.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(
            new SSHTransferError(config.host, 'download', '<content>', remotePath, err),
          );
        });

        readStream.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });

      connection.lastActivity = new Date();
      this.resetIdleTimer(connection);
      return content;
    } catch (err) {
      if (err instanceof SSHTransferError) {
        throw err;
      }
      throw new SSHTransferError(
        config.host,
        'download',
        '<content>',
        remotePath,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Returns the connection status for all pooled connections.
   *
   * @returns Array of connection status objects
   */
  getStatus(): ConnectionStatus[] {
    return [...this.connections.values()].map((conn) => ({
      key: conn.key,
      connected: conn.connected,
      activeConnections: 1,
      lastActivity: conn.lastActivity.toISOString(),
      totalCommandsExecuted: conn.totalCommandsExecuted,
    }));
  }

  /**
   * Checks whether a connection exists and is active for the given config.
   *
   * @param config - SSH connection configuration
   * @returns true if a healthy connection exists
   */
  isConnected(config: SSHConfig): boolean {
    const key = this.getConnectionKey(config);
    const connection = this.connections.get(key);
    return connection?.connected === true;
  }

  /**
   * Disconnects a specific host connection and removes it from the pool.
   *
   * @param config - SSH connection configuration
   */
  async disconnect(config: SSHConfig): Promise<void> {
    const key = this.getConnectionKey(config);
    this.removeConnection(key);
    this.logger.info(`Disconnected from ${config.host}`);
  }

  /**
   * Closes all pooled connections and prevents new connections.
   * Should be called when the service is no longer needed.
   */
  async close(): Promise<void> {
    this.closed = true;
    const keys = [...this.connections.keys()];

    for (const key of keys) {
      this.removeConnection(key);
    }

    this.logger.info(`SSHClientPool closed (${keys.length} connections terminated)`);
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Gets or creates a pooled SSH connection for the given config.
   */
  private async getConnection(config: SSHConfig): Promise<PooledConnection> {
    if (this.closed) {
      throw new SSHError('SSHClientPool is closed', config.host);
    }

    const key = this.getConnectionKey(config);
    const existing = this.connections.get(key);

    if (existing?.connected) {
      existing.lastActivity = new Date();
      return existing;
    }

    // Remove stale connection if it exists
    if (existing) {
      this.removeConnection(key);
    }

    return this.createConnection(config, key);
  }

  /**
   * Creates a new SSH connection with retry logic.
   */
  private async createConnection(config: SSHConfig, key: string): Promise<PooledConnection> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        this.logger.debug(`Connecting to ${config.host}:${config.port} (attempt ${attempt}/${this.options.maxRetries})`);

        const client = await this.connect(config);

        const connection: PooledConnection = {
          client,
          key,
          config,
          connected: true,
          lastActivity: new Date(),
          totalCommandsExecuted: 0,
          idleTimer: null,
        };

        // Set up event handlers
        client.on('error', (err: Error) => {
          this.logger.warn(`SSH connection error on ${config.host}: ${err.message}`);
          connection.connected = false;
        });

        client.on('end', () => {
          this.logger.debug(`SSH connection ended: ${config.host}`);
          connection.connected = false;
        });

        client.on('close', () => {
          this.logger.debug(`SSH connection closed: ${config.host}`);
          connection.connected = false;
        });

        this.connections.set(key, connection);
        this.resetIdleTimer(connection);

        this.logger.info(`SSH connection established to ${config.host}:${config.port}`, {
          attempt,
        });

        return connection;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `SSH connection attempt ${attempt}/${this.options.maxRetries} failed for ${config.host}: ${lastError.message}`,
        );

        if (attempt < this.options.maxRetries) {
          await this.sleep(this.options.retryDelay * attempt);
        }
      }
    }

    throw new SSHConnectionError(config.host, this.options.maxRetries, this.options.maxRetries, lastError);
  }

  /**
   * Establishes a raw SSH connection.
   */
  private connect(config: SSHConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: this.options.connectTimeout,
        keepaliveInterval: this.options.keepAliveInterval,
        keepaliveCountMax: 3,
      };

      // Authentication: prefer private key, fall back to password
      if (config.privateKeyPath) {
        try {
          connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
        } catch (err) {
          reject(
            new SSHError(
              `Failed to read private key: ${config.privateKeyPath}: ${err instanceof Error ? err.message : String(err)}`,
              config.host,
              err instanceof Error ? err : undefined,
            ),
          );
          return;
        }
      } else if (config.password) {
        connectConfig.password = config.password;
      }

      const timer = setTimeout(() => {
        client.end();
        reject(
          new SSHConnectionError(
            config.host,
            1,
            1,
            new Error(`Connection timed out after ${this.options.connectTimeout}ms`),
          ),
        );
      }, this.options.connectTimeout + 1000);

      client.on('ready', () => {
        clearTimeout(timer);
        resolve(client);
      });

      client.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      client.connect(connectConfig);
    });
  }

  /**
   * Executes a command on an established connection.
   */
  private executeCommand(
    connection: PooledConnection,
    command: string,
    timeout: number,
    options: ExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SSHTimeoutError(connection.config.host, command, timeout));
      }, timeout);

      // Build environment options
      const execOptions: Record<string, unknown> = {};
      if (options.env) {
        execOptions['env'] = options.env;
      }

      connection.client.exec(command, execOptions, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(
            new SSHError(
              `Failed to execute command: ${err.message}`,
              connection.config.host,
              err,
            ),
          );
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number | null, signal: string | null) => {
          clearTimeout(timer);
          resolve({
            stdout,
            stderr,
            exitCode: code,
            signal: signal ?? null,
          });
        });

        stream.on('error', (streamErr: Error) => {
          clearTimeout(timer);
          reject(
            new SSHError(
              `Stream error: ${streamErr.message}`,
              connection.config.host,
              streamErr,
            ),
          );
        });

        // Handle sudo password prompt
        if (options.sudo) {
          const sudoPassword = options.sudoPassword ?? connection.config.password;
          if (sudoPassword) {
            stream.stderr.once('data', (data: Buffer) => {
              const output = data.toString();
              if (output.includes('[sudo]') || output.includes('password')) {
                stream.write(`${sudoPassword}\n`);
              }
            });
          }
        }
      });
    });
  }

  /**
   * Builds the actual command string with sudo and cwd wrapping.
   */
  private buildCommand(command: string, config: SSHConfig, options: ExecOptions): string {
    let actualCommand = command;

    // Wrap with working directory if specified
    if (options.cwd) {
      actualCommand = `cd ${this.shellEscape(options.cwd)} && ${actualCommand}`;
    }

    // Wrap with sudo if requested
    if (options.sudo) {
      const sudoPassword = options.sudoPassword ?? config.password;
      if (sudoPassword) {
        // Use stdin for password to avoid it appearing in process list
        actualCommand = `echo ${this.shellEscape(sudoPassword)} | sudo -S -p '' ${actualCommand}`;
      } else {
        // Passwordless sudo (e.g., NOPASSWD in sudoers)
        actualCommand = `sudo ${actualCommand}`;
      }
    }

    return actualCommand;
  }

  /**
   * Gets an SFTP subsystem from a connection.
   */
  private getSftp(connection: PooledConnection): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      connection.client.sftp((err, sftp) => {
        if (err) {
          reject(
            new SSHError(
              `Failed to create SFTP session: ${err.message}`,
              connection.config.host,
              err,
            ),
          );
        } else {
          resolve(sftp);
        }
      });
    });
  }

  /**
   * Generates a unique connection key for pooling.
   */
  private getConnectionKey(config: SSHConfig): string {
    return `${config.host}:${config.port}:${config.username}`;
  }

  /**
   * Resets the idle timeout timer for a connection.
   */
  private resetIdleTimer(connection: PooledConnection): void {
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
    }

    connection.idleTimer = setTimeout(() => {
      this.logger.debug(`Idle timeout reached for ${connection.key}, closing connection`);
      this.removeConnection(connection.key);
    }, this.options.idleTimeout);
  }

  /**
   * Removes and cleans up a connection from the pool.
   */
  private removeConnection(key: string): void {
    const connection = this.connections.get(key);
    if (!connection) {
      return;
    }

    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = null;
    }

    try {
      connection.client.end();
    } catch {
      // Ignore errors during cleanup
    }

    connection.connected = false;
    this.connections.delete(key);
    this.logger.debug(`Connection removed from pool: ${key}`);
  }

  /**
   * Checks whether an error is likely a connection-level failure.
   */
  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) {
      return false;
    }

    const connectionErrors = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'Not connected',
      'Channel open failure',
      'Connection lost',
    ];

    return connectionErrors.some(
      (pattern) => err.message.includes(pattern) || (err as NodeJS.ErrnoException).code === pattern,
    );
  }

  /**
   * Escapes a string for safe use in shell commands.
   */
  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Utility to create a promise-based sleep.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
