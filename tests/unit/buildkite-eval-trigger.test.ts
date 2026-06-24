import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BuildkiteEvalTriggerImpl } from '../../src/services/buildkite-eval-trigger.js';

describe('BuildkiteEvalTriggerImpl', () => {
  const baseConfig = {
    apiToken: 'bk_test_token',
    orgSlug: 'elastic',
    onDemandPipelineSlug: 'kibana-evals-on-demand-llm-evals',
    weeklyPipelineSlug: 'kibana-evals-weekly-llm-evals',
    pollIntervalMs: 10,
    pollTimeoutMs: 100,
    kibanaBranch: 'fix/weekly-evals-matrix',
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          number: 42,
          web_url: 'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
          state: 'passed',
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createOnDemandBuild posts to Buildkite without polling', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(baseConfig, 'error');
    const build = await trigger.createOnDemandBuild({
      connectorJson: Buffer.from(JSON.stringify({ 'vllm-qwen-qwen2.5-1.5b-instruct': {} })).toString(
        'base64',
      ),
      connectorId: 'vllm-qwen-qwen2.5-1.5b-instruct',
      evalSuiteIds: ['security-alert-triage'],
      modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
    });

    expect(build.buildNumber).toBe(42);
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

  it('triggerOnDemandEval returns running immediately when detachPoll is enabled', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(
      { ...baseConfig, detachPoll: true },
      'error',
    );

    const result = await trigger.triggerOnDemandEval({
      connectorJson: '{}',
      connectorId: 'vllm-qwen-qwen2.5-1.5b-instruct',
      evalSuiteIds: ['security-alert-triage'],
      modelId: 'Qwen/Qwen2.5-1.5B-Instruct',
    });

    expect(result.status).toBe('running');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waitForBuild polls until build passes', async () => {
    const trigger = new BuildkiteEvalTriggerImpl(baseConfig, 'error');
    const result = await trigger.waitForBuild(
      'kibana-evals-on-demand-llm-evals',
      42,
      'https://buildkite.com/elastic/kibana-evals-on-demand-llm-evals/builds/42',
    );

    expect(result.status).toBe('passed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
