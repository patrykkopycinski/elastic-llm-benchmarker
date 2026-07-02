import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BuildkiteEvalTriggerImpl,
  isRetriableInfraState,
} from '../../src/services/buildkite-eval-trigger.js';

describe('BuildkiteEvalTriggerImpl', () => {
  const baseConfig = {
    apiToken: 'bk_test_token',
    orgSlug: 'elastic',
    onDemandPipelineSlug: 'kibana-evals-on-demand-llm-evals',
    weeklyPipelineSlug: 'kibana-evals-weekly-llm-evals',
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
    kibanaBranch: 'fix/weekly-evals-matrix',
    adoptRunningBuild: true,
    waitForPipelineIdle: true,
    pipelineIdlePollMs: 10,
    pipelineIdleWaitMs: 200,
  };

  const triggerOptions = {
    connectorJson: Buffer.from(JSON.stringify({ 'vllm-qwen-qwen2.5-1.5b-instruct': {} })).toString(
      'base64',
    ),
    connectorId: 'vllm-qwen-qwen2.5-1.5b-instruct',
    evalSuiteIds: ['security-alert-triage'],
    modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
  };

  const matchingEnv = {
    EVAL_SUITE_ID: 'security-alert-triage',
    EVAL_PROJECT: 'vllm-qwen-qwen2.5-1.5b-instruct',
    EVALUATION_CONNECTOR_ID: 'vllm-qwen-qwen2.5-1.5b-instruct',
    BENCHMARK_MODEL_ID: 'Qwen/Qwen2.5-1.5B-Instruct',
    EVAL_MODEL_GROUPS: 'Qwen/Qwen2.5-1.5B-Instruct',
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('builds?state=running')) {
          return { ok: true, json: async () => [] } as Response;
        }
        if (init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              number: 42,
              web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
              state: 'running',
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            number: 42,
            web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
            state: 'passed',
          }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createOnDemandBuild posts to Buildkite without polling', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: false },
      'error',
    );
    const build = await trigger.createOnDemandBuild(triggerOptions);

    expect(build.buildNumber).toBe(42);
    expect(build.adopted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      '/pipelines/kibana-evals-on-demand-llm-evals/builds',
    );
    const body = JSON.parse(
      String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body),
    ) as { env: Record<string, string> };
    expect(body.env.EVAL_SUITE_ID).toBe('security-alert-triage');
    expect(body.env.EVAL_PROJECT).toBe('vllm-qwen-qwen2.5-1.5b-instruct');
    expect(body.env.EVAL_MODEL_GROUPS).toBe('Qwen/Qwen2.5-1.5B-Instruct');
    expect(body.env.EVALUATION_CONNECTOR_ID).toBe('vllm-qwen-qwen2.5-1.5b-instruct');
    expect(body.env.BENCHMARK_MODEL_ID).toBe('Qwen/Qwen2.5-1.5B-Instruct');
    expect(body.env.LLM_EVAL_SUITES).toBeUndefined();
  });

  it('createOnDemandBuildOrAdopt adopts matching running build without POST', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('builds?state=running')) {
        return {
          ok: true,
          json: async () => [
            {
              number: 99,
              web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/99',
              state: 'running',
              message: 'Benchmarker: Qwen/Qwen2.5-1.5B-Instruct on-demand eval',
            },
          ],
        } as Response;
      }
      if (url.includes('/builds/99')) {
        return {
          ok: true,
          json: async () => ({
            number: 99,
            web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/99',
            state: 'running',
            message: 'Benchmarker: Qwen/Qwen2.5-1.5B-Instruct on-demand eval',
            env: matchingEnv,
          }),
        } as Response;
      }
      if (init?.method === 'POST') {
        throw new Error('POST should not run when adopting');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: false },
      'error',
    );
    const build = await trigger.createOnDemandBuildOrAdopt(triggerOptions);

    expect(build.buildNumber).toBe(99);
    expect(build.adopted).toBe(true);
  });

  it('createOnDemandBuildOrAdopt waits for foreign running build then creates', async () => {
    let listCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('builds?state=scheduled')) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.includes('builds?state=running')) {
        listCalls += 1;
        if (listCalls === 1) {
          return {
            ok: true,
            json: async () => [
              {
                number: 110,
                web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/110',
                state: 'running',
                message: 'fix(kbn-evals): manual run',
              },
            ],
          } as Response;
        }
        return { ok: true, json: async () => [] } as Response;
      }
      if (init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            number: 42,
            web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
            state: 'running',
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const trigger = new BuildkiteEvalTriggerImpl(baseConfig, 'error');
    const build = await trigger.createOnDemandBuildOrAdopt(triggerOptions);

    expect(build.buildNumber).toBe(42);
    expect(build.adopted).toBe(false);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it('createOnDemandBuildOrAdopt waits for a scheduled (queued) build to clear before POSTing', async () => {
    // Reproduces the skip_queued_branch_builds hazard: a still-`scheduled` build occupies the
    // branch. The old idle check only looked at `running` and would POST immediately, causing
    // Buildkite to skip the older queued build. The fix must also wait on `scheduled`.
    let scheduledCalls = 0;
    let postCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('builds?state=running')) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.includes('builds?state=scheduled')) {
        scheduledCalls += 1;
        if (scheduledCalls === 1) {
          return {
            ok: true,
            json: async () => [
              {
                number: 173,
                web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/173',
                state: 'scheduled',
                message: 'Benchmarker: other-model on-demand eval',
              },
            ],
          } as Response;
        }
        return { ok: true, json: async () => [] } as Response;
      }
      if (init?.method === 'POST') {
        postCalls += 1;
        return {
          ok: true,
          json: async () => ({
            number: 42,
            web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
            state: 'scheduled',
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, adoptRunningBuild: false, pipelineIdlePollMs: 5, pipelineIdleWaitMs: 200 },
      'error',
    );
    const build = await trigger.createOnDemandBuildOrAdopt(triggerOptions);

    expect(build.buildNumber).toBe(42);
    // POST must only fire after the scheduled build cleared (2nd scheduled poll).
    expect(scheduledCalls).toBeGreaterThanOrEqual(2);
    expect(postCalls).toBe(1);
  });

  it('waitForBuild surfaces the raw terminalState on the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          number: 99,
          web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/99',
          state: 'skipped',
        }),
      }),
    );

    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: false, pollIntervalMs: 5 },
      'error',
    );
    const result = await trigger.waitForBuild(
      'kibana-evals-on-demand-llm-evals',
      99,
      'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/99',
    );

    expect(result.status).toBe('failed');
    expect(result.terminalState).toBe('skipped');
  });

  it('isRetriableInfraState flags skipped/canceled/not_run but not passed/failed', () => {
    expect(isRetriableInfraState('skipped')).toBe(true);
    expect(isRetriableInfraState('canceled')).toBe(true);
    expect(isRetriableInfraState('not_run')).toBe(true);
    expect(isRetriableInfraState('failed')).toBe(false);
    expect(isRetriableInfraState('passed')).toBe(false);
    expect(isRetriableInfraState(undefined)).toBe(false);
  });

  it('triggerOnDemandEval returns running immediately when detachPoll is enabled', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, detachPoll: true, waitForPipelineIdle: false },
      'error',
    );

    const result = await trigger.triggerOnDemandEval(triggerOptions);

    expect(result.status).toBe('running');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('waitForBuild polls until build passes', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: false },
      'error',
    );
    const result = await trigger.waitForBuild(
      'kibana-evals-on-demand-llm-evals',
      42,
      'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
    );

    expect(result.status).toBe('passed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('waitForBuild returns failed when build is skipped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          number: 99,
          web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/99',
          state: 'skipped',
        }),
      }),
    );

    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: false, pollIntervalMs: 5 },
      'error',
    );
    const result = await trigger.waitForBuild(
      'kibana-evals-on-demand-llm-evals',
      99,
      'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/99',
    );

    expect(result.status).toBe('failed');
    expect(fetch).toHaveBeenCalled();
  });

  it('createWeeklyMatrixBuild posts to weekly pipeline with all suites as LLM_EVAL_SUITES', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: false },
      'error',
    );
    const build = await trigger.createWeeklyMatrixBuild({
      connectorJson: Buffer.from(JSON.stringify({ 'vllm-qwen-qwen2.5-1.5b-instruct': {} })).toString('base64'),
      connectorId: 'vllm-qwen-qwen2.5-1.5b-instruct',
      evalSuiteIds: ['security-alert-triage', 'security-alerts-rag-regression', 'security-esql-generation-regression'],
      modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
    });

    expect(build.buildNumber).toBe(42);
    expect(build.adopted).toBe(false);
    expect(build.pipelineSlug).toBe('kibana-evals-weekly-llm-evals');

    const postCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[1]?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(String(postCall![0])).toContain('/pipelines/kibana-evals-weekly-llm-evals/builds');

    const body = JSON.parse(String(postCall![1]?.body)) as { env: Record<string, string>; message: string };
    expect(body.env.LLM_EVAL_SUITES).toBe(
      'security-alert-triage,security-alerts-rag-regression,security-esql-generation-regression',
    );
    expect(body.env.BENCHMARK_MODEL_ID).toBe('Qwen/Qwen2.5-1.5B-Instruct');
    expect(body.env.EVAL_PROJECT).toBe('vllm-qwen-qwen2.5-1.5b-instruct');
    expect(body.env.EVALUATION_CONNECTOR_ID).toBe('vllm-qwen-qwen2.5-1.5b-instruct');
    expect(body.env.EVAL_MODEL_GROUPS).toBe('Qwen/Qwen2.5-1.5B-Instruct');
    expect(body.env.KIBANA_BRANCH).toBe('fix/weekly-evals-matrix');
    expect(body.message).toContain('Benchmarker:');
    expect(body.message).toContain('weekly matrix eval');
  });

  it('createWeeklyMatrixBuild waits for weekly pipeline idle when configured', async () => {
    let listCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('kibana-evals-weekly-llm-evals/builds?state=running')) {
        listCalls++;
        if (listCalls === 1) {
          return {
            ok: true,
            json: async () => [
              { number: 200, web_url: 'https://buildkite.com/elastic/weekly/200', state: 'running', message: 'weekly run' },
            ],
          } as Response;
        }
        return { ok: true, json: async () => [] } as Response;
      }
      if (init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            number: 55,
            web_url: 'https://buildkite.com/elastic/kibana-evals-weekly-llm-evals/builds/55',
            state: 'running',
          }),
        } as Response;
      }
      return { ok: true, json: async () => [] } as Response;
    });

    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, waitForPipelineIdle: true, pipelineIdlePollMs: 5, pipelineIdleWaitMs: 200 },
      'error',
    );
    const build = await trigger.createWeeklyMatrixBuild({
      connectorJson: 'Y29ubmVjdG9y',
      connectorId: 'test-connector',
      evalSuiteIds: ['security-alert-triage'],
      modelId: 'test/model',
    });

    expect(build.buildNumber).toBe(55);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});
