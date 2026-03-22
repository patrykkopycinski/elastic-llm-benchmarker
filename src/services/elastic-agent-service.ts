import type { SSHClientPool } from './ssh-client.js';
import type { SSHConfig } from '../types/config.js';
import { createLogger } from '../utils/logger.js';

const INSTALL_TIMEOUT_MS = 120_000;
const ENROLL_TIMEOUT_MS = 60_000;

export class ElasticAgentService {
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private readonly sshPool: SSHClientPool,
    logLevel: string = 'info',
  ) {
    this.logger = createLogger(logLevel);
  }

  async checkInstalled(sshConfig: SSHConfig): Promise<boolean> {
    const result = await this.sshPool.exec(sshConfig, 'elastic-agent version', {
      timeout: 10_000,
    });
    return result.success;
  }

  async install(sshConfig: SSHConfig, version: string = '8.17.0'): Promise<boolean> {
    if (await this.checkInstalled(sshConfig)) {
      this.logger.info('Elastic Agent already installed', { host: sshConfig.host });
      return true;
    }

    const archive = `elastic-agent-${version}-linux-x86_64.tar.gz`;
    const dir = `elastic-agent-${version}-linux-x86_64`;
    const url = `https://artifacts.elastic.co/downloads/beats/elastic-agent/${archive}`;

    try {
      const downloadResult = await this.sshPool.exec(
        sshConfig,
        `cd /tmp && curl -L -O ${url}`,
        { timeout: INSTALL_TIMEOUT_MS },
      );
      if (!downloadResult.success) {
        this.logger.warn('Elastic Agent download failed', {
          host: sshConfig.host,
          stderr: downloadResult.stderr,
        });
        return false;
      }

      const extractResult = await this.sshPool.exec(
        sshConfig,
        `cd /tmp && tar xzf ${archive}`,
        { timeout: 30_000 },
      );
      if (!extractResult.success) {
        this.logger.warn('Elastic Agent extract failed', {
          host: sshConfig.host,
          stderr: extractResult.stderr,
        });
        return false;
      }

      const installResult = await this.sshPool.exec(
        sshConfig,
        `cd /tmp/${dir} && sudo ./elastic-agent install --non-interactive`,
        { timeout: INSTALL_TIMEOUT_MS, sudo: true },
      );
      if (!installResult.success) {
        this.logger.warn('Elastic Agent install failed', {
          host: sshConfig.host,
          stderr: installResult.stderr,
        });
        return false;
      }

      this.logger.info('Elastic Agent installed', {
        host: sshConfig.host,
        version,
      });
      return true;
    } catch (err) {
      this.logger.warn('Elastic Agent install error', {
        host: sshConfig.host,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async enroll(
    sshConfig: SSHConfig,
    fleetUrl: string,
    enrollmentToken: string,
  ): Promise<boolean> {
    const result = await this.sshPool.exec(
      sshConfig,
      `sudo elastic-agent enroll --url=${fleetUrl} --enrollment-token=${enrollmentToken} --non-interactive`,
      { timeout: ENROLL_TIMEOUT_MS, sudo: true },
    );
    return result.success;
  }

  async verifyHealth(sshConfig: SSHConfig): Promise<{
    healthy: boolean;
    status: string;
  }> {
    const result = await this.sshPool.exec(
      sshConfig,
      'sudo elastic-agent status',
      { timeout: 15_000, sudo: true },
    );
    const output = result.stdout + result.stderr;
    const healthy = result.success && /health:\s*healthy/i.test(output);
    const statusMatch = output.match(/health:\s*(\w+)/i);
    const status = statusMatch?.[1] ?? (result.success ? 'unknown' : 'failed');
    return { healthy, status };
  }

  async ensureRunning(
    sshConfig: SSHConfig,
    config: {
      fleetUrl?: string;
      enrollmentToken?: string;
      version?: string;
    } = {},
  ): Promise<boolean> {
    const { fleetUrl, enrollmentToken, version } = config;
    const agentVersion = version ?? '8.17.0';

    if (!(await this.checkInstalled(sshConfig))) {
      const installed = await this.install(sshConfig, agentVersion);
      if (!installed) return false;
    }

    const { healthy } = await this.verifyHealth(sshConfig);
    if (healthy) {
      return true;
    }

    if (fleetUrl && enrollmentToken) {
      const enrolled = await this.enroll(sshConfig, fleetUrl, enrollmentToken);
      if (!enrolled) {
        this.logger.warn('Elastic Agent enrollment failed', { host: sshConfig.host });
        return false;
      }
    }

    const final = await this.verifyHealth(sshConfig);
    return final.healthy;
  }
}
