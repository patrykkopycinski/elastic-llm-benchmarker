// src/services/github-publisher.ts
import { Octokit } from '@octokit/rest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { createLogger } from '../utils/logger.js';

const execAsync = promisify(exec);

interface GitHubPublisherOptions {
  issueUrl: string;
  token?: string;
  logLevel?: string;
}

export class GitHubPublisher {
  private logger;
  private issueUrl: string;
  private token?: string;
  private octokit?: Octokit;

  constructor(options: GitHubPublisherOptions) {
    this.logger = createLogger(options.logLevel || 'info');
    this.issueUrl = options.issueUrl;
    this.token = options.token;

    if (this.token) {
      this.octokit = new Octokit({ auth: this.token });
    }
  }

  async publish(markdown: string): Promise<void> {
    if (await this.isGhCliAvailable()) {
      await this.publishViaGhCli(markdown);
      return;
    }

    if (this.token) {
      await this.publishViaApi(markdown);
      return;
    }

    throw new Error('No GitHub auth available (gh CLI or GITHUB_TOKEN)');
  }

  private async isGhCliAvailable(): Promise<boolean> {
    try {
      await execAsync('gh --version');
      return true;
    } catch {
      return false;
    }
  }

  private async publishViaGhCli(markdown: string): Promise<void> {
    const issueNumber = this.issueUrl.split('/').pop();
    const tempFile = `/tmp/benchmark-report-${Date.now()}.md`;

    await writeFile(tempFile, markdown);

    try {
      await execAsync(
        `gh issue comment ${issueNumber} ` +
        `--repo elastic/security-team ` +
        `--body-file ${tempFile}`
      );
      this.logger.info('Posted via gh CLI', { issueNumber });
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  }

  private async publishViaApi(markdown: string): Promise<void> {
    const [owner, repo, _, issueNumber] = new URL(this.issueUrl).pathname.split('/').filter(Boolean);

    await this.octokit!.rest.issues.createComment({
      owner,
      repo,
      issue_number: parseInt(issueNumber),
      body: markdown,
    });

    this.logger.info('Posted via API', { issueNumber });
  }
}
