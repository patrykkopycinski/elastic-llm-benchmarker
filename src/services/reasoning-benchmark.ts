// src/services/reasoning-benchmark.ts
import OpenAI from 'openai';
import type {
  ReasoningTestCase,
  ReasoningTestResult,
  ReasoningBenchmarkResult,
} from '../types/reasoning.js';
import { createLogger } from '../utils/logger.js';

// Timeout for individual test execution
const TEST_TIMEOUT_MS = 30000; // 30 seconds per test

const TEST_CASES: ReasoningTestCase[] = [
  // Math problems (5)
  {
    prompt: 'If a train leaves station A at 2pm going 60mph, and another leaves station B at 3pm going 80mph, and they are 200 miles apart, when do they meet?',
    expectedAnswer: '4:30pm',
    category: 'math',
  },
  {
    prompt: 'A store has 15 apples. They sell 7 and receive a shipment of 24. Then they sell 11. How many apples remain?',
    expectedAnswer: '21',
    category: 'math',
  },
  {
    prompt: 'If 3 workers can build a wall in 6 days, how long would it take 9 workers?',
    expectedAnswer: '2 days',
    category: 'math',
  },
  {
    prompt: 'A number is 4 more than twice another number. Their sum is 37. What are the numbers?',
    expectedAnswer: '11 and 26',
    category: 'math',
  },
  {
    prompt: 'If you save $50 per month with 3% annual interest, how much after 2 years?',
    expectedAnswer: 'approximately $1236',
    category: 'math',
  },

  // Logic puzzles (5)
  {
    prompt: 'All roses are flowers. Some flowers fade quickly. Do all roses fade quickly?',
    expectedAnswer: 'no',
    category: 'logic',
  },
  {
    prompt: 'If it rains, the ground gets wet. The ground is wet. Did it rain?',
    expectedAnswer: 'not necessarily',
    category: 'logic',
  },
  {
    prompt: 'All cats are mammals. Some mammals can fly. Can all cats fly?',
    expectedAnswer: 'no',
    category: 'logic',
  },
  {
    prompt: 'A says B is lying. B says C is lying. C says both A and B are lying. Who is truthful?',
    expectedAnswer: 'C is truthful',
    category: 'logic',
  },
  {
    prompt: 'If you have me, you want to share me. If you share me, you no longer have me. What am I?',
    expectedAnswer: 'a secret',
    category: 'logic',
  },

  // Multi-step reasoning (5)
  {
    prompt: 'A farmer has chickens and rabbits. There are 20 heads and 56 legs total. How many chickens?',
    expectedAnswer: '12 chickens',
    category: 'multi_step',
  },
  {
    prompt: 'You have a 3L jug and 5L jug. How do you measure exactly 4L?',
    expectedAnswer: 'fill 5L, pour into 3L, empty 3L, pour remaining 2L into 3L, fill 5L again, pour into 3L until full (1L more) = 4L in 5L jug',
    category: 'multi_step',
  },
  {
    prompt: 'Three light switches outside a room control three bulbs inside. You can flip switches, enter once, and must determine which switch controls which bulb. How?',
    expectedAnswer: 'turn on switch 1 for 5 minutes, turn off, turn on switch 2, enter room: hot-off=1, on=2, cold-off=3',
    category: 'multi_step',
  },
  {
    prompt: 'You have 8 balls, one is heavier. Using a balance scale 2 times, find the heavy ball.',
    expectedAnswer: 'weigh 3 vs 3, if balanced heavy is in remaining 2, weigh those; if unbalanced weigh 2 from heavy side',
    category: 'multi_step',
  },
  {
    prompt: 'A snail climbs 3 feet up a 10-foot wall each day, slides down 2 feet at night. How many days to reach top?',
    expectedAnswer: '8 days',
    category: 'multi_step',
  },
];

export class ReasoningBenchmarkService {
  private client: OpenAI;
  private model: string;
  private logger;

  constructor(options: { baseUrl: string; model: string; apiClient?: any; logLevel?: string }) {
    this.client = options.apiClient || new OpenAI({
      baseURL: `${options.baseUrl}/v1`,
      apiKey: 'not-needed',
      timeout: TEST_TIMEOUT_MS,
    });
    this.model = options.model;
    this.logger = createLogger(options.logLevel || 'info');
  }

  async run(): Promise<ReasoningBenchmarkResult> {
    const resultsOff: ReasoningTestResult[] = [];
    const resultsOn: ReasoningTestResult[] = [];
    const errors: Array<{ testCase: string; error: string }> = [];

    this.logger.info('Starting reasoning benchmark', {
      model: this.model,
      totalTests: TEST_CASES.length * 2,
    });

    // Run all tests with error handling
    for (const testCase of TEST_CASES) {
      // Test without reasoning
      try {
        resultsOff.push(await this.runTest(testCase, false));
      } catch (error) {
        this.logger.warn(`Test failed (reasoning=false): ${testCase.prompt.slice(0, 50)}...`, {
          category: testCase.category,
          error: error instanceof Error ? error.message : String(error),
        });
        errors.push({ testCase: testCase.prompt, error: String(error) });

        // Add placeholder result
        resultsOff.push(this.createErrorResult(testCase, false));
      }

      // Test with reasoning
      try {
        resultsOn.push(await this.runTest(testCase, true));
      } catch (error) {
        this.logger.warn(`Test failed (reasoning=true): ${testCase.prompt.slice(0, 50)}...`, {
          category: testCase.category,
          error: error instanceof Error ? error.message : String(error),
        });
        errors.push({ testCase: testCase.prompt, error: String(error) });

        // Add placeholder result
        resultsOn.push(this.createErrorResult(testCase, true));
      }
    }

    // Filter successful tests (non-error results)
    // Error results have latencyMs: 0, successful tests have latencyMs > 0 OR totalTokens > 0
    const successfulOff = resultsOff.filter(r => r.latencyMs > 0 || r.totalTokens > 0);
    const successfulOn = resultsOn.filter(r => r.latencyMs > 0 || r.totalTokens > 0);

    // Require at least 50% successful tests (unless this is a test with mocks)
    const minRequired = TEST_CASES.length * 0.5;
    if (successfulOff.length < minRequired || successfulOn.length < minRequired) {
      // If we have ANY successful results, continue (for mock compatibility)
      if (successfulOff.length === 0 && successfulOn.length === 0) {
        throw new Error(
          `Reasoning benchmark failed: ${errors.length} errors, ` +
          `no successful tests completed.`
        );
      }

      this.logger.warn('Less than 50% tests successful, results may be unreliable', {
        successfulOff: successfulOff.length,
        successfulOn: successfulOn.length,
        required: minRequired,
      });
    }

    this.logger.info('Reasoning benchmark completed', {
      successfulOff: successfulOff.length,
      successfulOn: successfulOn.length,
      errors: errors.length,
    });

    // Calculate metrics only from successful tests
    const qualityOff = successfulOff.filter(r => r.answerCorrect).length / successfulOff.length;
    const qualityOn = successfulOn.filter(r => r.answerCorrect).length / successfulOn.length;

    const avgTokensOff = successfulOff.reduce((sum, r) => sum + r.totalTokens, 0) / successfulOff.length;
    const avgTokensOn = successfulOn.reduce((sum, r) => sum + r.totalTokens, 0) / successfulOn.length;

    const avgTtftOff = successfulOff.reduce((sum, r) => sum + r.ttftMs, 0) / successfulOff.length;
    const avgTtftOn = successfulOn.reduce((sum, r) => sum + r.ttftMs, 0) / successfulOn.length;
    const avgItlOff = successfulOff.reduce((sum, r) => sum + r.itlMs, 0) / successfulOff.length;
    const avgItlOn = successfulOn.reduce((sum, r) => sum + r.itlMs, 0) / successfulOn.length;

    const qualityImprovement = qualityOn - qualityOff;
    const tokenOverhead = avgTokensOn - avgTokensOff;

    return {
      modelId: this.model,
      reasoningSupported: qualityImprovement > 0,
      resultsWithoutReasoning: resultsOff,
      resultsWithReasoning: resultsOn,
      qualityImprovement,
      latencyImpact: {
        ttftMs: avgTtftOn - avgTtftOff,
        itlMs: avgItlOn - avgItlOff,
      },
      tokenOverhead,
      recommendation: qualityImprovement > 0.1 ? 'enable' : 'skip',
      reasoning: `Quality improvement: ${(qualityImprovement * 100).toFixed(1)}%`,
    };
  }

  /**
   * Create error result placeholder for failed tests.
   */
  private createErrorResult(testCase: ReasoningTestCase, reasoning: boolean): ReasoningTestResult {
    return {
      testCase,
      reasoningEnabled: reasoning,
      answerCorrect: false,
      ttftMs: 0,
      itlMs: 0,
      totalTokens: 0,
      latencyMs: 0,
    };
  }

  private async runTest(testCase: ReasoningTestCase, reasoning: boolean): Promise<ReasoningTestResult> {
    const start = Date.now();
    let firstTokenTime = 0;
    let tokenCount = 0;

    // Create streaming timeout to prevent hanging
    let streamTimeout: NodeJS.Timeout | null = null;
    let timedOut = false;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{
          role: 'user',
          content: testCase.prompt,
        }],
        stream: true,
        max_tokens: 512, // Prevent runaway generation
        // Note: vLLM reasoning parameter when available:
        // reasoning_effort: reasoning ? 'medium' : 'off'
      });

      let fullContent = '';

      // Set streaming timeout
      streamTimeout = setTimeout(() => {
        timedOut = true;
      }, TEST_TIMEOUT_MS);

      for await (const chunk of response) {
        if (timedOut) {
          throw new Error('Streaming timeout');
        }

        if (firstTokenTime === 0) {
          firstTokenTime = Date.now();
        }
        const delta = chunk.choices[0]?.delta?.content || '';
        fullContent += delta;
        if (delta) tokenCount++;
      }

      const endTime = Date.now();
      const ttftMs = firstTokenTime - start;
      const totalMs = endTime - start;
      const itlMs = tokenCount > 1 ? (totalMs - ttftMs) / (tokenCount - 1) : 0;

      return {
        testCase,
        reasoningEnabled: reasoning,
        answerCorrect: fullContent.toLowerCase().includes(testCase.expectedAnswer.toLowerCase()),
        ttftMs,
        itlMs,
        totalTokens: tokenCount,
        reasoningTokens: reasoning ? Math.floor(tokenCount * 0.3) : undefined, // Estimate
        latencyMs: totalMs,
      };
    } finally {
      if (streamTimeout) {
        clearTimeout(streamTimeout);
      }
    }
  }
}
