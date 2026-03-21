// tests/unit/reasoning-benchmark.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ReasoningBenchmarkService } from '../../src/services/reasoning-benchmark.js';

describe('ReasoningBenchmarkService', () => {
  it('should run tests with and without reasoning', async () => {
    // Create async iterable mock for streaming response
    const createMockStream = (content: string) => {
      const chunks = content.split('').map(char => ({
        choices: [{ delta: { content: char } }],
      }));

      return {
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      };
    };

    const mockApi = {
      chat: {
        completions: {
          create: vi.fn()
            .mockImplementation(() => createMockStream('21')),
        },
      },
    };

    const service = new ReasoningBenchmarkService({
      baseUrl: 'http://localhost:8000',
      model: 'test-model',
      apiClient: mockApi as any,
    });

    const result = await service.run();

    // 15 test cases run twice (with and without reasoning)
    expect(result.resultsWithoutReasoning).toHaveLength(15);
    expect(result.resultsWithReasoning).toHaveLength(15);
    expect(mockApi.chat.completions.create).toHaveBeenCalledTimes(30);
  });
});
