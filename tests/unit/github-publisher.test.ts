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

    await publisher.publish('# Test Report');

    expect(execAsync).toHaveBeenCalledWith(expect.stringContaining('gh issue comment'));
  });

  it('should fallback to API when gh CLI unavailable', async () => {
    vi.mocked(execAsync).mockRejectedValueOnce(new Error('gh not found'));

    const publisher = new GitHubPublisher({
      issueUrl: 'https://github.com/elastic/security-team/issues/15545',
      token: 'ghp_test',
    });

    await publisher.publish('# Test Report');
    // Should not throw
  });
});
