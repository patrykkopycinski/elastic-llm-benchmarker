export const INDEX_NAMES = {
  BENCHMARKER_RESULTS: 'benchmarker-results',
  BENCHMARKER_EVAL_REPORTS: 'benchmarker-eval-reports',
  BENCHMARKER_QUEUE: 'benchmarker-queue',
  BENCHMARKER_CHECKPOINTS: 'benchmarker-checkpoints',
  BENCHMARKER_MODELS: 'benchmarker-models',
  BENCHMARKER_ERRORS: 'benchmarker-errors',
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
};
