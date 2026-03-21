import { Client } from '@elastic/elasticsearch';
import type {
  BenchmarkResult,
  BenchmarkMetrics,
  ToolCallResult,
  ModelInfo,
  ModelEvaluationReport,
  CriterionEvaluation,
} from '../types/benchmark.js';
import { INDEX_NAMES, INDEX_MAPPINGS } from './es-index-mappings.js';
import { createLogger } from '../utils/logger.js';

export interface ResultsQueryOptions {
  modelId?: string;
  vllmVersion?: string;
  after?: string;
  before?: string;
  passed?: boolean;
  gpuType?: string;
  hardwareProfileId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'asc' | 'desc';
}

export interface ModelBenchmarkSummary {
  modelId: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  lastRunTimestamp: string;
  lastPassed: boolean;
  avgItlMs: number | null;
  avgThroughput: number | null;
  avgToolCallSuccessRate: number | null;
}

export interface CheckpointEvent {
  modelId: string;
  eventType:
  | 'deployment_started'
  | 'deployment_ready'
  | 'deployment_failed'
  | 'benchmark_started'
  | 'benchmark_completed'
  | 'teardown_started';
  engineType?: string;
  host?: string;
  containerId?: string;
  containerName?: string;
  gpuAllocation?: string;
  error?: { message: string; category: string };
}

export interface ModelCatalogEntry {
  modelId: string;
  name: string;
  architecture: string;
  parameterCount: number | null;
  contextWindow: number;
  license: string;
  supportsToolCalling: boolean;
  quantizations: string[];
  source: 'hf_discovery' | 'user';
}

export interface ErrorEvent {
  modelId: string;
  errorCategory: string;
  errorMessage: string;
  recoveryAction: string;
  attemptNumber: number;
  success: boolean;
  nodeName: string;
}

export interface CircuitBreakerEvent {
  modelId: string;
  oldState: string;
  newState: string;
  failureCount: number;
}

function resultToEs(result: BenchmarkResult): Record<string, unknown> {
  const hardwareConfig = result.hardwareConfig;
  const toolCall = result.toolCallResults;
  return {
    '@timestamp': result.timestamp,
    model_id: result.modelId,
    timestamp: result.timestamp,
    vllm_version: result.vllmVersion,
    docker_command: result.dockerCommand,
    hardware_config: {
      gpu_type: hardwareConfig.gpuType,
      gpu_count: hardwareConfig.gpuCount,
      ram_gb: hardwareConfig.ramGb,
      cpu_cores: hardwareConfig.cpuCores,
      disk_gb: hardwareConfig.diskGb,
      machine_type: hardwareConfig.machineType,
      hardware_profile_id: hardwareConfig.hardwareProfileId,
    },
    benchmark_metrics: result.benchmarkMetrics.map((m) => ({
      itl_ms: m.itlMs,
      ttft_ms: m.ttftMs,
      throughput_tokens_per_sec: m.throughputTokensPerSec,
      p99_latency_ms: m.p99LatencyMs,
      concurrency_level: m.concurrencyLevel,
    })),
    tool_call_results: toolCall
      ? {
        supports_parallel_calls: toolCall.supportsParallelCalls,
        max_concurrent_calls: toolCall.maxConcurrentCalls,
        avg_tool_call_latency_ms: toolCall.avgToolCallLatencyMs,
        success_rate: toolCall.successRate,
        total_tests: toolCall.totalTests,
      }
      : null,
    passed: result.passed,
    rejection_reasons: result.rejectionReasons,
    tensor_parallel_size: result.tensorParallelSize,
    tool_call_parser: result.toolCallParser,
    raw_output: result.rawOutput,
    gpu_utilization: result.gpuUtilization
      ? {
          vram_used_gb: result.gpuUtilization.vramUsedGb,
          vram_total_gb: result.gpuUtilization.vramTotalGb,
          total_vram_used_gb: result.gpuUtilization.totalVramUsedGb,
          total_vram_total_gb: result.gpuUtilization.totalVramTotalGb,
          vram_utilization_pct: result.gpuUtilization.vramUtilizationPct,
          gpu_utilization_pct: result.gpuUtilization.gpuUtilizationPct,
        }
      : null,
  };
}

function esHitToResult(hit: Record<string, unknown>): BenchmarkResult {
  const hc = (hit.hardware_config ?? {}) as Record<string, unknown>;
  const bm = (hit.benchmark_metrics ?? []) as Record<string, unknown>[];
  const tcr = hit.tool_call_results as Record<string, unknown> | null;
  return {
    modelId: hit.model_id as string,
    timestamp: hit.timestamp as string,
    vllmVersion: hit.vllm_version as string,
    dockerCommand: hit.docker_command as string,
    hardwareConfig: {
      gpuType: hc.gpu_type as string,
      gpuCount: (hc.gpu_count as number) ?? 0,
      ramGb: (hc.ram_gb as number) ?? 0,
      cpuCores: (hc.cpu_cores as number) ?? 0,
      diskGb: (hc.disk_gb as number) ?? 0,
      machineType: (hc.machine_type as string) ?? '',
      hardwareProfileId: (hc.hardware_profile_id as string | null) ?? null,
    },
    benchmarkMetrics: bm.map(
      (m): BenchmarkMetrics => ({
        itlMs: m.itl_ms as number,
        ttftMs: m.ttft_ms as number,
        throughputTokensPerSec: m.throughput_tokens_per_sec as number,
        p99LatencyMs: m.p99_latency_ms as number,
        concurrencyLevel: m.concurrency_level as number,
      }),
    ),
    toolCallResults: tcr
      ? ({
        supportsParallelCalls: tcr.supports_parallel_calls as boolean,
        maxConcurrentCalls: tcr.max_concurrent_calls as number,
        avgToolCallLatencyMs: tcr.avg_tool_call_latency_ms as number,
        successRate: tcr.success_rate as number,
        totalTests: tcr.total_tests as number,
      } satisfies ToolCallResult)
      : null,
    passed: hit.passed as boolean,
    rejectionReasons: (hit.rejection_reasons as string[]) ?? [],
    tensorParallelSize: (hit.tensor_parallel_size as number) ?? 1,
    toolCallParser: (hit.tool_call_parser as string) ?? '',
    rawOutput: (hit.raw_output as string) ?? '',
    gpuUtilization: hit.gpu_utilization
      ? (() => {
          const gpu = hit.gpu_utilization as Record<string, unknown>;
          return {
            vramUsedGb: (gpu.vram_used_gb as number[]) ?? [],
            vramTotalGb: (gpu.vram_total_gb as number[]) ?? [],
            totalVramUsedGb: (gpu.total_vram_used_gb as number) ?? 0,
            totalVramTotalGb: (gpu.total_vram_total_gb as number) ?? 0,
            vramUtilizationPct: (gpu.vram_utilization_pct as number) ?? 0,
            gpuUtilizationPct: (gpu.gpu_utilization_pct as number[] | null) ?? null,
          };
        })()
      : null,
  };
}

function reportToEs(report: ModelEvaluationReport): Record<string, unknown> {
  const criteria = (report.criteriaResults ?? []).map((c): Record<string, unknown> => ({
    criterion: c.criterion,
    description: c.description,
    passed: c.passed,
    severity: c.severity,
    actual_value: c.actualValue,
    required_value: c.requiredValue,
    message: c.message,
  }));
  const doc: Record<string, unknown> = {
    model_id: report.modelId,
    '@timestamp': report.timestamp,
    classification: report.classification,
    summary: report.summary,
    passed_count: report.passedCount,
    total_count: report.totalCount,
    criteria_results: criteria,
  };
  if (report.benchmarkResult) {
    doc.benchmark_result = resultToEs(report.benchmarkResult);
  }
  if (report.modelInfo) {
    const mi = report.modelInfo;
    doc.model_info = {
      id: mi.id,
      name: mi.name,
      architecture: mi.architecture,
      context_window: mi.contextWindow,
      license: mi.license,
      parameter_count: mi.parameterCount,
      quantizations: mi.quantizations,
      supports_tool_calling: mi.supportsToolCalling,
    };
  }
  return doc;
}

function esHitToReport(hit: Record<string, unknown>): ModelEvaluationReport {
  const crit = (hit.criteria_results ?? []) as Record<string, unknown>[];
  const criteriaResults: CriterionEvaluation[] = crit.map((c) => ({
    criterion: c.criterion as string,
    description: c.description as string,
    passed: c.passed as boolean,
    severity: c.severity as 'HARD' | 'PREFERRED',
    actualValue: c.actual_value as string,
    requiredValue: c.required_value as string,
    message: c.message as string,
  }));
  const failedCriteria = criteriaResults.filter((c) => !c.passed);
  let benchmarkResult: BenchmarkResult | undefined;
  const br = hit.benchmark_result as Record<string, unknown> | undefined;
  if (br) {
    benchmarkResult = esHitToResult(br);
  }
  let modelInfo: ModelInfo | null = null;
  const mi = hit.model_info as Record<string, unknown> | undefined;
  if (mi) {
    modelInfo = {
      id: mi.id as string,
      name: mi.name as string,
      architecture: mi.architecture as string,
      contextWindow: mi.context_window as number,
      license: mi.license as string,
      parameterCount: (mi.parameter_count as number | null) ?? null,
      quantizations: (mi.quantizations as string[]) ?? [],
      supportsToolCalling: (mi.supports_tool_calling as boolean) ?? false,
    };
  }
  return {
    modelId: hit.model_id as string,
    timestamp: (hit['@timestamp'] ?? hit.timestamp) as string,
    classification: hit.classification as 'APPROVED' | 'CONDITIONAL' | 'REJECTED',
    summary: hit.summary as string,
    criteriaResults,
    failedCriteria,
    passedCount: hit.passed_count as number,
    totalCount: hit.total_count as number,
    benchmarkResult: benchmarkResult ?? null,
    modelInfo,
  };
}

export class ElasticsearchResultsStore {
  private readonly esClient: Client;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(client: Client, logLevel: string = 'info') {
    this.esClient = client;
    this.logger = createLogger(logLevel);
  }

  get client(): Client {
    return this.esClient;
  }

  async initialize(): Promise<void> {
    for (const [indexName, config] of Object.entries(INDEX_MAPPINGS)) {
      const exists = await this.esClient.indices.exists({ index: indexName });
      if (!exists) {
        await this.esClient.indices.create({
          index: indexName,
          mappings: config.mappings as any,
          settings: config.settings,
        });
        this.logger.info(`Created index: ${indexName}`);
      }
    }
  }

  async save(result: BenchmarkResult): Promise<string> {
    const id = Buffer.from(`${result.modelId}:${result.timestamp}`).toString('base64url');
    const doc = resultToEs(result);
    await this.esClient.index({
      index: INDEX_NAMES.BENCHMARKER_RESULTS,
      id,
      document: doc,
    });
    this.logger.info('Stored benchmark result', { modelId: result.modelId, id });
    return id;
  }

  async query(options: ResultsQueryOptions = {}): Promise<BenchmarkResult[]> {
    const must: Record<string, unknown>[] = [];
    if (options.modelId) must.push({ term: { model_id: options.modelId } });
    if (options.vllmVersion) must.push({ term: { vllm_version: options.vllmVersion } });
    if (options.after) must.push({ range: { timestamp: { gte: options.after } } });
    if (options.before) must.push({ range: { timestamp: { lte: options.before } } });
    if (options.passed !== undefined) must.push({ term: { passed: options.passed } });
    if (options.gpuType)
      must.push({ term: { 'hardware_config.gpu_type': options.gpuType } });
    if (options.hardwareProfileId)
      must.push({
        term: { 'hardware_config.hardware_profile_id': options.hardwareProfileId },
      });

    const sort: Record<string, { order: 'asc' | 'desc' }>[] = [
      { timestamp: { order: options.orderBy === 'asc' ? 'asc' : 'desc' } },
    ];
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_RESULTS,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      sort,
      from: offset,
      size: limit,
    });

    const hits = (resp.hits.hits ?? []).map((h) => h._source).filter(Boolean) as Record<
      string,
      unknown
    >[];
    return hits.map((hit) => esHitToResult(hit));
  }

  async getEvaluatedModelIds(): Promise<string[]> {
    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_RESULTS,
      size: 0,
      aggs: {
        models: { terms: { field: 'model_id', size: 10_000 } },
      },
    });
    const buckets =
      (resp.aggregations?.models as { buckets: { key: string }[] })?.buckets ?? [];
    return buckets.map((b) => b.key).sort();
  }

  async getModelSummary(modelId: string): Promise<ModelBenchmarkSummary | null> {
    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_RESULTS,
      size: 0,
      query: { term: { model_id: modelId } },
      aggs: {
        total: { value_count: { field: 'model_id' } },
        passed_count: {
          filter: { term: { passed: true } },
          aggs: { count: { value_count: { field: 'model_id' } } },
        },
        failed_count: {
          filter: { term: { passed: false } },
          aggs: { count: { value_count: { field: 'model_id' } } },
        },
        last_run: {
          max: { field: 'timestamp' },
        },
        latest_passed: {
          top_hits: {
            size: 1,
            sort: [{ timestamp: { order: 'desc' } }],
            _source: ['passed'],
          },
        },
        nested_metrics: {
          nested: { path: 'benchmark_metrics' },
          aggs: {
            avg_itl: { avg: { field: 'benchmark_metrics.itl_ms' } },
            avg_throughput: { avg: { field: 'benchmark_metrics.throughput_tokens_per_sec' } },
          },
        },
        avg_tool_success: { avg: { field: 'tool_call_results.success_rate' } },
      },
    });

    const total = (resp.aggregations?.total as { value: number })?.value ?? 0;
    if (total === 0) return null;

    const passedVal =
      (resp.aggregations?.passed_count as { count: { value: number } })?.count?.value ?? 0;
    const failedVal =
      (resp.aggregations?.failed_count as { count: { value: number } })?.count?.value ?? 0;
    const lastRun =
      (resp.aggregations?.last_run as { value: string | null })?.value ?? null;
    const latestHits =
      (resp.aggregations?.latest_passed as { hits: { hits: { _source?: { passed: boolean } }[] } })
        ?.hits?.hits ?? [];
    const lastPassed = latestHits[0]?._source?.passed ?? false;
    const nestedMetrics = resp.aggregations?.nested_metrics as {
      avg_itl: { value: number | null };
      avg_throughput: { value: number | null };
    } | undefined;
    const avgItl = nestedMetrics?.avg_itl?.value ?? null;
    const avgThroughput = nestedMetrics?.avg_throughput?.value ?? null;
    const avgToolSuccess =
      (resp.aggregations?.avg_tool_success as { value: number | null })?.value ?? null;

    return {
      modelId,
      totalRuns: total,
      passedRuns: passedVal,
      failedRuns: failedVal,
      lastRunTimestamp: lastRun ?? '',
      lastPassed,
      avgItlMs: avgItl,
      avgThroughput,
      avgToolCallSuccessRate: avgToolSuccess,
    };
  }

  async getStats(): Promise<{ total: number; passed: number; failed: number }> {
    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_RESULTS,
      size: 0,
      query: { match_all: {} },
      aggs: {
        total: { value_count: { field: 'model_id' } },
        passed: {
          filter: { term: { passed: true } },
          aggs: { c: { value_count: { field: 'model_id' } } },
        },
        failed: {
          filter: { term: { passed: false } },
          aggs: { c: { value_count: { field: 'model_id' } } },
        },
      },
    });
    const total = (resp.aggregations?.total as { value: number })?.value ?? 0;
    const passed =
      (resp.aggregations?.passed as { c: { value: number } })?.c?.value ?? 0;
    const failed =
      (resp.aggregations?.failed as { c: { value: number } })?.c?.value ?? 0;
    return { total, passed, failed };
  }

  async saveCheckpoint(event: CheckpointEvent): Promise<void> {
    const doc: Record<string, unknown> = {
      '@timestamp': new Date().toISOString(),
      model_id: event.modelId,
      event_type: event.eventType,
      engine_type: event.engineType,
      host: event.host,
      container_id: event.containerId,
      container_name: event.containerName,
      gpu_allocation: event.gpuAllocation,
      error: event.error,
    };
    await this.esClient.index({
      index: INDEX_NAMES.BENCHMARKER_CHECKPOINTS,
      document: doc,
    });
  }

  async getCheckpoints(
    modelId: string,
  ): Promise<Array<CheckpointEvent & { timestamp: string }>> {
    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_CHECKPOINTS,
      query: { term: { model_id: modelId } },
      sort: [{ '@timestamp': { order: 'asc' } }],
      size: 1000,
    });
    const hits = (resp.hits.hits ?? []) as Array<{
      _source?: Record<string, unknown>;
    }>;
    return hits.map((h) => {
      const s = h._source ?? {};
      const ts = (s['@timestamp'] as string) ?? '';
      return {
        modelId: s.model_id as string,
        eventType: s.event_type as CheckpointEvent['eventType'],
        engineType: s.engine_type as string | undefined,
        host: s.host as string | undefined,
        containerId: s.container_id as string | undefined,
        containerName: s.container_name as string | undefined,
        gpuAllocation: s.gpu_allocation as string | undefined,
        error: s.error as { message: string; category: string } | undefined,
        timestamp: ts,
      };
    });
  }

  async saveEvalReport(report: ModelEvaluationReport): Promise<void> {
    const doc = reportToEs(report);
    await this.esClient.index({
      index: INDEX_NAMES.BENCHMARKER_EVAL_REPORTS,
      document: doc,
    });
  }

  async queryEvalReports(
    filters?: { modelId?: string; classification?: string },
  ): Promise<ModelEvaluationReport[]> {
    const must: Record<string, unknown>[] = [];
    if (filters?.modelId) must.push({ term: { model_id: filters.modelId } });
    if (filters?.classification)
      must.push({ term: { classification: filters.classification } });

    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_EVAL_REPORTS,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      sort: [{ '@timestamp': { order: 'desc' } }],
      size: 500,
    });
    const hits = (resp.hits.hits ?? []).map((h) => h._source).filter(Boolean) as Record<
      string,
      unknown
    >[];
    return hits.map((hit) => esHitToReport(hit));
  }

  async saveModel(entry: ModelCatalogEntry): Promise<void> {
    const now = new Date().toISOString();
    const doc: Record<string, unknown> = {
      model_id: entry.modelId,
      name: entry.name,
      architecture: entry.architecture,
      parameter_count: entry.parameterCount,
      context_window: entry.contextWindow,
      license: entry.license,
      supports_tool_calling: entry.supportsToolCalling,
      quantizations: entry.quantizations,
      source: entry.source,
      last_updated: now,
    };
    const exists = await this.esClient.exists({
      index: INDEX_NAMES.BENCHMARKER_MODELS,
      id: entry.modelId,
    });
    if (!exists) {
      doc.discovered_at = now;
    }
    await this.esClient.index({
      index: INDEX_NAMES.BENCHMARKER_MODELS,
      id: entry.modelId,
      document: doc,
      refresh: true,
    });
  }

  async queryModels(
    filters?: {
      architecture?: string;
      supportsToolCalling?: boolean;
      source?: string;
    },
  ): Promise<ModelCatalogEntry[]> {
    const must: Record<string, unknown>[] = [];
    if (filters?.architecture) must.push({ term: { architecture: filters.architecture } });
    if (filters?.supportsToolCalling !== undefined)
      must.push({ term: { supports_tool_calling: filters.supportsToolCalling } });
    if (filters?.source) must.push({ term: { source: filters.source } });

    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_MODELS,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      size: 1000,
    });
    const hits = (resp.hits.hits ?? []).map((h) => h._source).filter(Boolean) as Record<
      string,
      unknown
    >[];
    return hits.map((h) => ({
      modelId: h.model_id as string,
      name: h.name as string,
      architecture: h.architecture as string,
      parameterCount: (h.parameter_count as number | null) ?? null,
      contextWindow: h.context_window as number,
      license: h.license as string,
      supportsToolCalling: (h.supports_tool_calling as boolean) ?? false,
      quantizations: (h.quantizations as string[]) ?? [],
      source: h.source as 'hf_discovery' | 'user',
    }));
  }

  async getModel(modelId: string): Promise<ModelCatalogEntry | null> {
    const resp = await this.esClient.get({
      index: INDEX_NAMES.BENCHMARKER_MODELS,
      id: modelId,
    });
    if (!resp.found) return null;
    const h = resp._source as Record<string, unknown>;
    return {
      modelId: h.model_id as string,
      name: h.name as string,
      architecture: h.architecture as string,
      parameterCount: (h.parameter_count as number | null) ?? null,
      contextWindow: h.context_window as number,
      license: h.license as string,
      supportsToolCalling: (h.supports_tool_calling as boolean) ?? false,
      quantizations: (h.quantizations as string[]) ?? [],
      source: h.source as 'hf_discovery' | 'user',
    };
  }

  async saveError(event: ErrorEvent): Promise<void> {
    const doc: Record<string, unknown> = {
      '@timestamp': new Date().toISOString(),
      model_id: event.modelId,
      error_category: event.errorCategory,
      error_message: event.errorMessage,
      recovery_action: event.recoveryAction,
      attempt_number: event.attemptNumber,
      success: event.success,
      node_name: event.nodeName,
    };
    await this.esClient.index({
      index: INDEX_NAMES.BENCHMARKER_ERRORS,
      document: doc,
    });
  }

  async saveCircuitBreakerChange(event: CircuitBreakerEvent): Promise<void> {
    const doc: Record<string, unknown> = {
      '@timestamp': new Date().toISOString(),
      model_id: event.modelId,
      circuit_breaker_old_state: event.oldState,
      circuit_breaker_state: event.newState,
      failure_count: event.failureCount,
    };
    await this.esClient.index({
      index: INDEX_NAMES.BENCHMARKER_ERRORS,
      document: doc,
    });
  }

  async queryErrors(
    filters?: { modelId?: string; errorCategory?: string; limit?: number },
  ): Promise<ErrorEvent[]> {
    const must: Record<string, unknown>[] = [];
    if (filters?.modelId) must.push({ term: { model_id: filters.modelId } });
    if (filters?.errorCategory)
      must.push({ term: { error_category: filters.errorCategory } });

    const resp = await this.esClient.search({
      index: INDEX_NAMES.BENCHMARKER_ERRORS,
      query:
        must.length > 0
          ? { bool: { must, must_not: [{ exists: { field: 'circuit_breaker_state' } }] } }
          : { bool: { must_not: [{ exists: { field: 'circuit_breaker_state' } }] } },
      sort: [{ '@timestamp': { order: 'desc' } }],
      size: filters?.limit ?? 100,
    });
    const hits = (resp.hits.hits ?? []).map((h) => h._source).filter(Boolean) as Record<
      string,
      unknown
    >[];
    return hits.map((h) => ({
      modelId: h.model_id as string,
      errorCategory: h.error_category as string,
      errorMessage: h.error_message as string,
      recoveryAction: h.recovery_action as string,
      attemptNumber: h.attempt_number as number,
      success: h.success as boolean,
      nodeName: h.node_name as string,
    }));
  }

  async close(): Promise<void> {
    await this.esClient.close();
    this.logger.info('ElasticsearchResultsStore closed');
  }
}
