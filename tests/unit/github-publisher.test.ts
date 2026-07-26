// tests/unit/github-publisher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GitHubPublisher } from '../../src/services/github-publisher.js';
import { exec } from 'child_process';
import { promisify } from 'util';

vi.mock('child_process');
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
    },
  })),
}));

const execAsync = promisify(exec);

describe('GitHubPublisher', () => {
  it('should use gh CLI as primary method', async () => {
    vi.mocked(execAsync).mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' } as any);
    vi.mocked(execAsync).mockResolvedValueOnce({ stdout: 'Comment posted', stderr: '' } as any);

    const publisher = new GitHubPublisher({
      issueUrl: 'https://github.com/elastic/security-team/issues/15545',
    });

    const result = await publisher.publish('# Test Report');

    expect(result.success).toBe(true);
    expect(execAsync).toHaveBeenCalledWith(expect.stringContaining('gh issue comment'));
  });

  it('should fallback to API when gh CLI unavailable', async () => {
    vi.mocked(execAsync).mockRejectedValueOnce(new Error('gh not found'));

    const publisher = new GitHubPublisher({
      issueUrl: 'https://github.com/elastic/security-team/issues/15545',
      token: 'ghp_test',
    });

    const result = await publisher.publish('# Test Report');
    expect(result.success).toBe(true);
  });

  it('returns a failed ServiceResult when no auth is available', async () => {
    vi.mocked(execAsync).mockRejectedValue(new Error('gh not found'));

    const publisher = new GitHubPublisher({
      issueUrl: 'https://github.com/elastic/security-team/issues/15545',
    });

    const result = await publisher.publish('# Test Report');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No GitHub auth available');
    }
  }, 15000);
});
