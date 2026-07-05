import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { SSHConfig } from '../types/config.js';
import type { Logger } from 'winston';

/**
 * Local port the GPU VM's vLLM API (remote port 8000) is forwarded to.
 * The VM's port 8000 is firewalled externally (GCP), so any daemon-side HTTP
 * client (e.g. the tool-call benchmark) reaches it through this SSH tunnel.
 *
 * Fixed rather than dynamic because the pipeline benchmarks exactly one model
 * at a time (scheduler `maxConcurrentRuns` = 1), so there is never a second
 * concurrent tunnel to collide with.
 */
export const TUNNEL_LOCAL_PORT = 18000;

/** Base URL a daemon-side HTTP client uses to reach the tunneled vLLM API. */
export const TUNNEL_BASE_URL = `http://127.0.0.1:${TUNNEL_LOCAL_PORT}`;

/**
 * Spawns a background `ssh -N -L` port-forward from {@link TUNNEL_LOCAL_PORT}
 * to the VM's vLLM API. Caller owns the returned process and MUST kill it when
 * done (in a `finally`). Never throws — spawn failures surface on the process
 * `error`/`exit` events, which {@link waitForTunnel} observes as a timeout.
 */
export function startSSHTunnel(sshConfig: SSHConfig, logger?: Logger): ChildProcess {
  const args = [
    '-N',
    '-L',
    `${TUNNEL_LOCAL_PORT}:localhost:8000`,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ExitOnForwardFailure=yes',
    '-p',
    String(sshConfig.port),
  ];
  if (sshConfig.privateKeyPath) {
    args.push('-i', sshConfig.privateKeyPath);
  }
  args.push(`${sshConfig.username}@${sshConfig.host}`);

  const proc = spawn('ssh', args, { stdio: 'pipe' });
  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) logger?.debug(`SSH tunnel stderr: ${msg}`);
  });
  return proc;
}

/**
 * Polls {@link TUNNEL_LOCAL_PORT} until a TCP connection succeeds or the
 * timeout elapses. Returns `true` once the tunnel accepts connections.
 */
export async function waitForTunnel(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(TUNNEL_LOCAL_PORT, '127.0.0.1', () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
        sock.setTimeout(1000, () => {
          sock.destroy();
          reject(new Error('timeout'));
        });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}
