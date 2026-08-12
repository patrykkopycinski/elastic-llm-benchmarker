import { execFile, type ExecFileOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../types/config.js';
import { createLogger } from '../utils/logger.js';
import type winston from 'winston';
import { type ServiceResult, ok, fail } from '../types/service-result.js';

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

  async cloneOrPull(): Promise<ServiceResult<void>> {
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
        return fail(message, 'clone');
      }
      return ok(undefined);
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
        return ok(undefined);
      }

      // --depth 1 matches the initial clone() above. Without it, fetching a
      // branch on an already-shallow repo forces git to negotiate full
      // ancestry with the remote instead of staying shallow — turning a
      // ~5s fetch into a 120s+ timeout on large repos like kibana.
      await execFilePromise('git', ['fetch', 'origin', branch, '--depth', '1'], {
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
      return ok(undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message, 'checkout');
    }
  }

  async bootstrap(): Promise<ServiceResult<void>> {
    const repoPath = this.getRepoPath();
    const markerPath = path.join(repoPath, 'node_modules', '.bootstrap-complete');
    const packageJsonPath = path.join(repoPath, 'package.json');

    if (fs.existsSync(markerPath) && fs.existsSync(packageJsonPath)) {
      const markerStat = fs.statSync(markerPath);
      const packageStat = fs.statSync(packageJsonPath);
      if (packageStat.mtimeMs <= markerStat.mtimeMs) {
        this.logger.info('Bootstrap marker exists and package.json is unchanged, skipping bootstrap');
        // Still ensure Scout servers config exists — a skip used to leave a
        // fresh cache without `.scout/servers/local.json`, which made every
        // Stage 2 suite die on "Directory with servers configuration is missing".
        this.ensureScoutServersConfig(repoPath);
        return ok(undefined);
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
      return fail(message, 'bootstrap');
    }

    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString());
    this.ensureScoutServersConfig(repoPath);
    return ok(undefined);
  }

  /**
   * Copy a live Scout `local.json` into the Kibana cache so Playwright can
   * resolve hosts. Without this, Stage 2 dies with:
   *   Directory with servers configuration is missing or does not exist: …/.scout/servers
   * even when the connector id and env payload are correct.
   *
   * Preference order: `kibanaRepo.scoutServersSource` → `$HOME/Projects/kibana/.scout/servers/local.json`.
   * Best-effort: missing source leaves any prior copy intact and only warns.
   */
  ensureScoutServersConfig(repoPath: string = this.getRepoPath()): void {
    const destDir = path.join(repoPath, '.scout', 'servers');
    const dest = path.join(destDir, 'local.json');
    const candidates = [
      this.config.scoutServersSource,
      path.join(process.env.HOME ?? '', 'Projects', 'kibana', '.scout', 'servers', 'local.json'),
    ].filter((p): p is string => Boolean(p && p.trim()));

    const source = candidates.find((p) => fs.existsSync(p));
    if (!source) {
      if (!fs.existsSync(dest)) {
        this.logger.warn(
          'Scout servers config missing and no source found — Stage 2 will fail until local.json is provisioned',
          { tried: candidates, dest },
        );
      }
      return;
    }

    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(source, dest);
      this.logger.info('Provisioned Scout servers config for Stage 2', { source, dest });
    } catch (err: unknown) {
      this.logger.warn('Failed to provision Scout servers config', {
        source,
        dest,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
