import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LockfileOptions {
  /** Absolute or relative path to the lockfile. Defaults to `.benchmarker-queue.lock`. */
  path?: string;
}

/**
 * Simple PID-based lockfile for graceful start/stop of the benchmarker-queue daemon.
 *
 * Writes the current process PID on acquire and removes the file on release.
 */
export class Lockfile {
  private readonly path: string;
  private acquired = false;

  constructor(options: LockfileOptions = {}) {
    this.path = resolve(options.path ?? '.benchmarker-queue.lock');
  }

  /**
   * Attempt to acquire the lock. Returns true if successful, false if already locked
   * by a live process. Stale locks from dead PIDs are removed automatically.
   */
  acquire(): boolean {
    if (existsSync(this.path)) {
      const pid = this.readPid();
      if (pid !== null && this.isProcessRunning(pid)) {
        return false;
      }
      this.forceRelease();
    }
    writeFileSync(this.path, String(process.pid), 'utf-8');
    this.acquired = true;
    return true;
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code !== 'ESRCH';
    }
  }

  /**
   * Release the lock by deleting the lockfile.
   * Returns true if the file was removed (or was already gone), false on error.
   */
  release(): boolean {
    if (!existsSync(this.path)) {
      this.acquired = false;
      return true;
    }
    try {
      unlinkSync(this.path);
      this.acquired = false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the PID stored in the lockfile, or null if none exists.
   */
  readPid(): number | null {
    if (!existsSync(this.path)) {
      return null;
    }
    try {
      const content = readFileSync(this.path, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Returns true if this process currently holds the lock.
   */
  isAcquired(): boolean {
    return this.acquired;
  }

  /**
   * Returns true if the lockfile currently exists.
   */
  isLocked(): boolean {
    return existsSync(this.path);
  }

  /**
   * Force-remove the lockfile regardless of who owns it.
   */
  forceRelease(): boolean {
    try {
      if (existsSync(this.path)) {
        unlinkSync(this.path);
      }
      this.acquired = false;
      return true;
    } catch {
      return false;
    }
  }
}
