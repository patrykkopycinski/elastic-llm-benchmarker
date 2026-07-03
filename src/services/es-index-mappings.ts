import type { Client } from '@elastic/elasticsearch';

export const INDEX_NAMES = {
  BENCHMARKER_RESULTS: 'benchmarker-results',
  BENCHMARKER_EVAL_REPORTS: 'benchmarker-eval-reports',
  BENCHMARKER_QUEUE: 'benchmarker-queue',
  BENCHMARKER_CHECKPOINTS: 'benchmarker-checkpoints',
  BENCHMARKER_MODELS: 'benchmarker-models',
  BENCHMARKER_ERRORS: 'benchmarker-errors',
  BENCHMARKER_EVALUATIONS: 'benchmark-evaluations',
  BENCHMARKER_STAGE2: 'benchmark-stage2',
  BENCHMARKER_REASONING: 'benchmark-reasoning',
  RECOMMENDATION_REPORTS: 'recommendation-reports',
  BENCHMARKER_CI_EVALS: 'benchmarker-ci-evals',
} as const;

export const INDEX_MAPPINGS: Record<
  string,
  { mappings: { properties: Record<string, unknown> }; settings?: Record<string, unknown> }
> = {
  [INDEX_NAMES.BENCHMARKER_RESULTS]: {
    mappings: {
      properties: {
        '@timestamp': { type: 'date', fields: { keyword: { type: 'keyword' } } },
        model_id: { type: 'keyword' },
        timestamp: { type: 'keyword' },
        vllm_version: { type: 'keyword' },
        docker_command: { type: 'text' },
        hardware_config: {
          type: 'object',
          properties: {
            gpu_type: { type: 'keyword' },
            gpu_count: { type: 'integer' },
            ram_gb: { type: 'integer' },
            cpu_cores: { type: 'integer' },
            disk_gb: { type: 'integer' },
            machine_type: { type: 'keyword' },
            hardware_profile_id: { type: 'keyword' },
          },
        },
        benchmark_metrics: {
          type: 'nested',
          properties: {
            itl_ms: { type: 'float' },
            ttft_ms: { type: 'float' },
            throughput_tokens_per_sec: { type: 'float' },
            p99_latency_ms: { type: 'float' },
            concurrency_level: { type: 'integer' },
          },
        },
        tool_call_results: {
          type: 'object',
          properties: {
            supports_parallel_calls: { type: 'boolean' },
            max_concurrent_calls: { type: 'integer' },
            avg_tool_call_latency_ms: { type: 'float' },
            success_rate: { type: 'float' },
            total_tests: { type: 'integer' },
          },
        },
        passed: { type: 'boolean' },
        rejection_reasons: { type: 'keyword' },
        tensor_parallel_size: { type: 'integer' },
        tool_call_parser: { type: 'keyword' },
        raw_output: { type: 'text' },
        gpu_utilization: {
          type: 'object',
          properties: {
            vram_used_gb: { type: 'float' },
            vram_total_gb: { type: 'float' },
            total_vram_used_gb: { type: 'float' },
            total_vram_total_gb: { type: 'float' },
            vram_utilization_pct: { type: 'float' },
            gpu_utilization_pct: { type: 'float' },
          },
        },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_EVAL_REPORTS]: {
    mappings: {
      properties: {
        model_id: { type: 'keyword' },
        '@timestamp': { type: 'date' },
        classification: { type: 'keyword' },
        summary: { type: 'text' },
        passed_count: { type: 'integer' },
        total_count: { type: 'integer' },
        criteria_results: {
          type: 'nested',
          properties: {
            criterion: { type: 'keyword' },
            description: { type: 'text' },
            passed: { type: 'boolean' },
            severity: { type: 'keyword' },
            actual_value: { type: 'keyword' },
            required_value: { type: 'keyword' },
            message: { type: 'text' },
          },
        },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_QUEUE]: {
    mappings: {
      properties: {
        model_id: { type: 'keyword' },
        source: { type: 'keyword' },
        priority: { type: 'integer' },
        status: { type: 'keyword' },
        requested_at: { type: 'date' },
        started_at: { type: 'date' },
        completed_at: { type: 'date' },
        error_message: { type: 'text' },
        requested_by: { type: 'keyword' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
      refresh_interval: '5s',
    },
  },
  [INDEX_NAMES.BENCHMARKER_CHECKPOINTS]: {
    mappings: {
      properties: {
        '@timestamp': { type: 'date', fields: { keyword: { type: 'keyword' } } },
        model_id: { type: 'keyword' },
        event_type: { type: 'keyword' },
        engine_type: { type: 'keyword' },
        host: { type: 'keyword' },
        container_id: { type: 'keyword' },
        container_name: { type: 'keyword' },
        gpu_allocation: { type: 'keyword' },
        error: {
          type: 'object',
          properties: {
            message: { type: 'text' },
            category: { type: 'keyword' },
          },
        },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_MODELS]: {
    mappings: {
      properties: {
        model_id: { type: 'keyword' },
        name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        architecture: { type: 'keyword' },
        parameter_count: { type: 'long' },
        parameter_count_billions: { type: 'float' },
        context_window: { type: 'integer' },
        license: { type: 'keyword' },
        supports_tool_calling: { type: 'boolean' },
        quantizations: { type: 'keyword' },
        source: { type: 'keyword' },
        discovered_at: { type: 'date' },
        last_updated: { type: 'date' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_ERRORS]: {
    mappings: {
      properties: {
        '@timestamp': { type: 'date', fields: { keyword: { type: 'keyword' } } },
        model_id: { type: 'keyword' },
        error_category: { type: 'keyword' },
        error_message: { type: 'text' },
        recovery_action: { type: 'keyword' },
        attempt_number: { type: 'integer' },
        success: { type: 'boolean' },
        node_name: { type: 'keyword' },
        circuit_breaker_state: { type: 'keyword' },
        circuit_breaker_old_state: { type: 'keyword' },
        failure_count: { type: 'integer' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_EVALUATIONS]: {
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        model_id: { type: 'keyword' },
        run_id: { type: 'keyword' },
        endpoint_url: { type: 'keyword' },
        status: { type: 'keyword' },
        suite_results: {
          type: 'nested',
          properties: {
            suite: { type: 'keyword' },
            status: { type: 'keyword' },
            score: { type: 'float' },
            duration_ms: { type: 'integer' },
            error: { type: 'text', index: false },
            trace_id: { type: 'keyword' },
          },
        },
        scores: { type: 'object', enabled: false },
        started_at: { type: 'date' },
        completed_at: { type: 'date' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_STAGE2]: {
    mappings: {
      properties: {
        run_id: { type: 'keyword' },
        model_id: { type: 'keyword' },
        status: { type: 'keyword' },
        scores: {
          type: 'object',
          enabled: false,
        },
        suite_results: {
          type: 'nested',
          properties: {
            suite: { type: 'keyword' },
            status: { type: 'keyword' },
            score: { type: 'float' },
            duration_ms: { type: 'long' },
            error: { type: 'text' },
            trace_id: { type: 'keyword' },
          },
        },
        reason: { type: 'text' },
        started_at: { type: 'date' },
        completed_at: { type: 'date' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_REASONING]: {
    mappings: {
      properties: {
        run_id: { type: 'keyword' },
        model_id: { type: 'keyword' },
        status: { type: 'keyword' },
        suggestions: {
          type: 'nested',
          properties: {
            category: { type: 'keyword' },
            title: { type: 'text' },
            description: { type: 'text' },
            estimatedImpact: { type: 'keyword' },
          },
        },
        trace_summary: {
          properties: {
            totalSpans: { type: 'integer' },
            errorCount: { type: 'integer' },
            latencyPercentiles: {
              properties: {
                p50_ms: { type: 'float' },
                p95_ms: { type: 'float' },
                p99_ms: { type: 'float' },
              },
            },
          },
        },
        raw_response: { type: 'text', index: false },
        error: { type: 'text' },
        started_at: { type: 'date' },
        completed_at: { type: 'date' },
        '@timestamp': { type: 'date' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.RECOMMENDATION_REPORTS]: {
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        report_id: { type: 'keyword' },
        model_id: { type: 'keyword' },
        model_name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        verdict: { type: 'keyword' },
        confidence: { type: 'keyword' },
        hardware_profile: { type: 'keyword' },
        stage1_passed: { type: 'boolean' },
        stage2_passed: { type: 'boolean' },
        stage2_ran: { type: 'boolean' },
        stage3_ran: { type: 'boolean' },
        passing_evals: {
          type: 'nested',
          properties: {
            suite: { type: 'keyword' },
            score: { type: 'float' },
            threshold: { type: 'float' },
            passed: { type: 'boolean' },
          },
        },
        blocking_issues: {
          type: 'nested',
          properties: {
            severity: { type: 'keyword' },
            category: { type: 'keyword' },
            message: { type: 'text' },
          },
        },
        vllm_config_used: {
          type: 'object',
          properties: {
            context_length: { type: 'integer' },
            quantization: { type: 'keyword' },
            tool_call_parser: { type: 'keyword' },
            flags: { type: 'keyword' },
            source: { type: 'keyword' },
          },
        },
        suggestions: {
          type: 'nested',
          properties: {
            category: { type: 'keyword' },
            title: { type: 'text' },
            description: { type: 'text' },
            expected_impact: { type: 'text' },
            confidence: { type: 'keyword' },
          },
        },
        stage1_metrics: {
          type: 'object',
          properties: {
            itl: {
              properties: {
                p50: { type: 'float' },
                p99: { type: 'float' },
                mean: { type: 'float' },
              },
            },
            ttft: {
              properties: {
                p50: { type: 'float' },
                p99: { type: 'float' },
                mean: { type: 'float' },
              },
            },
            throughput_tps: { type: 'float' },
          },
        },
        stage2_results: {
          type: 'object',
          properties: {
            suites_run: { type: 'keyword' },
            suite_results: { type: 'object', enabled: false },
          },
        },
        reasoning_summary: { type: 'text' },
        run_id: { type: 'keyword' },
        version: { type: 'integer' },
        evaluated_at: { type: 'date' },
        evaluated_by: { type: 'keyword' },
        source: { type: 'keyword' },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
  [INDEX_NAMES.BENCHMARKER_CI_EVALS]: {
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        run_id: { type: 'keyword' },
        model_id: { type: 'keyword' },
        buildkite_build_url: { type: 'keyword' },
        buildkite_build_number: { type: 'integer' },
        pipeline_slug: { type: 'keyword' },
        status: { type: 'keyword' },
        buildkite_state: { type: 'keyword' },
        eval_suites: { type: 'keyword' },
        scores: { type: 'object', enabled: false },
        artifacts: { type: 'object', enabled: false },
        started_at: { type: 'date' },
        completed_at: { type: 'date' },
        retry_count: { type: 'integer' },
        connector_json: { type: 'text', index: false },
      },
    },
    settings: {
      number_of_shards: 1,
      number_of_replicas: 1,
    },
  },
};

export const benchmarkEvaluationsMapping = {
  '@timestamp': { type: 'date' },
  model_id: { type: 'keyword' },
  run_id: { type: 'keyword' },
  endpoint_url: { type: 'keyword' },
  status: { type: 'keyword' },
  suite_results: {
    type: 'nested',
    properties: {
      suite: { type: 'keyword' },
      status: { type: 'keyword' },
      score: { type: 'float' },
      duration_ms: { type: 'integer' },
      error: { type: 'text', index: false },
      trace_id: { type: 'keyword' },
    },
  },
  scores: { type: 'object', enabled: false },
  started_at: { type: 'date' },
  completed_at: { type: 'date' },
};

export const benchmarkStage2Mapping = {
  run_id: { type: 'keyword' },
  model_id: { type: 'keyword' },
  status: { type: 'keyword' },
  scores: { type: 'object', enabled: false },
  suite_results: {
    type: 'nested',
    properties: {
      suite: { type: 'keyword' },
      status: { type: 'keyword' },
      score: { type: 'float' },
      duration_ms: { type: 'long' },
      error: { type: 'text' },
      trace_id: { type: 'keyword' },
    },
  },
  reason: { type: 'text' },
  started_at: { type: 'date' },
  completed_at: { type: 'date' },
};

export const benchmarkReasoningMapping = {
  run_id: { type: 'keyword' },
  model_id: { type: 'keyword' },
  status: { type: 'keyword' },
  suggestions: {
    type: 'nested',
    properties: {
      category: { type: 'keyword' },
      title: { type: 'text' },
      description: { type: 'text' },
      estimatedImpact: { type: 'keyword' },
    },
  },
  trace_summary: {
    properties: {
      totalSpans: { type: 'integer' },
      errorCount: { type: 'integer' },
      latencyPercentiles: {
        properties: {
          p50_ms: { type: 'float' },
          p95_ms: { type: 'float' },
          p99_ms: { type: 'float' },
        },
      },
    },
  },
  raw_response: { type: 'text', index: false },
  error: { type: 'text' },
  started_at: { type: 'date' },
  completed_at: { type: 'date' },
  '@timestamp': { type: 'date' },
};

export async function ensureIndices(esClient: Client): Promise<void> {
  for (const [indexName, indexConfig] of Object.entries(INDEX_MAPPINGS)) {
    const exists = await esClient.indices.exists({ index: indexName });
    if (!exists) {
      await esClient.indices.create({
        index: indexName,
        mappings: indexConfig.mappings as Record<string, unknown>,
        settings: indexConfig.settings as Record<string, unknown>,
      });
    }
  }
}
