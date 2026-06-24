import { execFile, type ExecFileOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../types/config.js';
import { createLogger } from '../utils/logger.js';
import type winston from 'winston';

// ─── Errors ───────────────────────────────────────────────────────────────────

export class KibanaRepoError extends Error {
  constructor(
    readonly type: 'clone' | 'checkout' | 'bootstrap',
    message: string,
  ) {
    super(message);
    this.name = 'KibanaRepoError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KibanaRepoServiceOptions {
  config: Pick<AppConfig, 'kibanaRepo'>;
  logger?: winston.Logger;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function execFilePromise(
  file: string,
  args: string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
  });
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class KibanaRepoService {
  private readonly config: AppConfig['kibanaRepo'];
  private readonly logger: winston.Logger;

  constructor({ config, logger }: KibanaRepoServiceOptions) {
    this.config = config.kibanaRepo;
    this.logger = logger ?? createLogger('info');
  }

  getRepoPath(): string {
    return this.config.cacheDir ?? this.config.clonePath;
  }

  async cloneOrPull(): Promise<void> {
    const repoPath = this.getRepoPath();
    const branch = this.config.branch;

    if (!fs.existsSync(repoPath)) {
      this.logger.info(`Cloning Kibana repo to ${repoPath}`);
      try {
        await execFilePromise('git', [
          'clone',
          this.config.url,
          repoPath,
          '--depth',
          '1',
          '--branch',
          branch,
        ]);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new KibanaRepoError('clone', message);
      }
      return;
    }

    this.logger.info(`Pulling latest changes for Kibana repo at ${repoPath}`, { branch });
    try {
      // Fast path: skip network fetch when already on the target branch and up to date.
      const localHead = (
        await execFilePromise('git', ['rev-parse', 'HEAD'], { cwd: repoPath })
      ).stdout.trim();
      let remoteHead: string | null = null;
      try {
        remoteHead = (
          await execFilePromise('git', ['rev-parse', `origin/${branch}`], { cwd: repoPath })
        ).stdout.trim();
      } catch {
        remoteHead = null;
      }
      if (remoteHead && localHead === remoteHead) {
        this.logger.info('Kibana repo already up to date — skipping fetch', { branch, commit: localHead.slice(0, 8) });
        return;
      }

      await execFilePromise('git', ['fetch', 'origin', branch], {
        cwd: repoPath,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      await execFilePromise('git', ['checkout', branch], { cwd: repoPath });
      await execFilePromise('git', ['pull', '--ff-only', 'origin', branch], {
        cwd: repoPath,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KibanaRepoError('checkout', message);
    }
  }

  async bootstrap(): Promise<void> {
    const repoPath = this.getRepoPath();
    const markerPath = path.join(repoPath, 'node_modules', '.bootstrap-complete');
    const packageJsonPath = path.join(repoPath, 'package.json');

    if (fs.existsSync(markerPath) && fs.existsSync(packageJsonPath)) {
      const markerStat = fs.statSync(markerPath);
      const packageStat = fs.statSync(packageJsonPath);
      if (packageStat.mtimeMs <= markerStat.mtimeMs) {
        this.logger.info('Bootstrap marker exists and package.json is unchanged, skipping bootstrap');
        return;
      }
    }

    this.logger.info(`Running yarn kbn bootstrap in ${repoPath}`);
    try {
      await execFilePromise('yarn', ['kbn', 'bootstrap'], {
        cwd: repoPath,
        timeout: this.config.bootstrapTimeoutMs,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KibanaRepoError('bootstrap', message);
    }

    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString());
  }
}
