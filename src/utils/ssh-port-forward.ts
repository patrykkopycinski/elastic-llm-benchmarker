import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { SSHConfig } from '../types/config.js';
import { createLogger } from './logger.js';
import type { Logger } from 'winston';

export interface SshPortForwardOptions {
  ssh: SSHConfig;
  /** Local bind port (127.0.0.1) */
  localPort: number;
  /** Remote port on the VM (typically vLLM 8000) */
  remotePort: number;
  /** Remote host as seen from the VM. Defaults to localhost. */
  remoteHost?: string;
  /** Max wait for the local forward to accept connections */
  waitTimeoutMs?: number;
  logLevel?: string;
}

/**
 * Manages a local SSH `-L` port forward to a remote host:port on the GPU VM.
 */
export class SshPortForward {
  private readonly options: Required<
    Pick<SshPortForwardOptions, 'remoteHost' | 'waitTimeoutMs'>
  > &
    SshPortForwardOptions;
  private readonly logger: Logger;
  private proc: ChildProcess | null = null;

  constructor(options: SshPortForwardOptions) {
    this.options = {
      remoteHost: 'localhost',
      waitTimeoutMs: 15_000,
      ...options,
    };
    this.logger = createLogger(options.logLevel ?? 'info');
  }

  /** Whether the forward process is running. */
  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /**
   * Starts `ssh -N -L localPort:remoteHost:remotePort user@host`.
   * Does not throw — callers should use {@link waitUntilReady}.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    const { ssh, localPort, remotePort, remoteHost } = this.options;
    const args = [
      '-N',
      '-L',
      `${localPort}:${remoteHost}:${remotePort}`,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-p',
      String(ssh.port),
    ];

    if (ssh.privateKeyPath) {
      args.push('-i', ssh.privateKeyPath);
    }

    args.push(`${ssh.username}@${ssh.host}`);

    this.logger.info('Starting SSH port forward', {
      localPort,
      remote: `${remoteHost}:${remotePort}`,
      host: ssh.host,
    });

    this.proc = spawn('ssh', args, { stdio: 'pipe' });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        this.logger.debug('SSH port forward stderr', { message: msg });
      }
    });
    this.proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.logger.warn('SSH port forward exited unexpectedly', { code, localPort });
      } else {
        this.logger.debug('SSH port forward exited', { code });
      }
      this.proc = null;
    });
  }

  /**
   * Polls until localhost:localPort accepts TCP connections or timeout.
   */
  async waitUntilReady(): Promise<boolean> {
    const { localPort, waitTimeoutMs } = this.options;
    const start = Date.now();

    while (Date.now() - start < waitTimeoutMs) {
      if (this.proc?.killed) {
        return false;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const sock = net.connect(localPort, '127.0.0.1', () => {
            sock.destroy();
            resolve();
          });
          sock.on('error', reject);
          sock.setTimeout(1000, () => {
            sock.destroy();
            reject(new Error('timeout'));
          });
        });
        this.logger.info('SSH port forward ready', { localPort });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.logger.warn('SSH port forward not ready before timeout', {
      localPort,
      waitTimeoutMs,
    });
    return false;
  }

  /** Stops the forward process if running. */
  stop(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
      this.logger.info('SSH port forward stopped');
    }
    this.proc = null;
  }
}
