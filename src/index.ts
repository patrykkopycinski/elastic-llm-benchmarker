/**
 * elastic-llm-benchmarker
 *
 * Automated LLM discovery, deployment, and benchmarking agent
 * powered by LangGraph.js
 */

export { createLogger } from './utils/logger.js';
export { loadConfig, loadConfigFile, formatValidationErrors } from './config/index.js';
export { ElasticsearchResultsStore } from './services/elasticsearch-results-store.js';
export type {
  ResultsQueryOptions,
  ModelBenchmarkSummary,
  CheckpointEvent,
  ModelCatalogEntry,
  ErrorEvent,
  CircuitBreakerEvent,
} from './services/elasticsearch-results-store.js';
export { QueueService } from './services/queue-service.js';
export type { QueueEntry } from './services/queue-service.js';
export { ElasticAgentService } from './services/elastic-agent-service.js';
export { INDEX_NAMES, INDEX_MAPPINGS } from './services/es-index-mappings.js';
export { ModelDiscoveryService } from './services/model-discovery.js';
export type { ModelDiscoveryOptions, DiscoveryResult } from './services/model-discovery.js';
export { ModelCandidateFilter } from './services/model-candidate-filter.js';
export type {
  FilterRejection,
  FilterCriterion,
  FilterResult,
  BatchFilterResult,
  CandidateFilterOptions,
} from './services/model-candidate-filter.js';
export {
  SSHClientPool,
  SSHError,
  SSHConnectionError,
  SSHTimeoutError,
  SSHTransferError,
} from './services/ssh-client.js';
export type {
  CommandResult,
  ExecOptions,
  TransferOptions,
  SSHClientPoolOptions,
  ConnectionStatus,
} from './services/ssh-client.js';
export {
  VllmDeploymentService,
  VllmDeploymentError,
  ContainerError,
  HealthCheckError,
} from './services/vllm-deployment.js';
export type {
  VllmDeploymentOptions,
  DeploymentResult,
  ContainerStatus,
} from './services/vllm-deployment.js';
export { HealthCheckService, HealthCheckServiceError } from './services/health-check.js';
export type {
  HealthCheckOptions,
  HealthCheckResult,
  HealthCheckPollResult,
  HealthCheckErrorCategory,
  HealthCheckErrorClassification,
  VllmModelResponse,
} from './services/health-check.js';
export type { LoadConfigOptions } from './config/index.js';
export type { AppConfig, VMHardwareProfile, DaemonConfig, ScheduleWindow, TunnelConfig, TunnelProvider, EngineConfig, EngineTypeConfig, KibanaConnectorConfig, KibanaEvalConfig, NotificationConfig, ConsoleChannelConfig, FileChannelConfig, WebhookChannelConfig, EmailChannelConfig } from './types/config.js';
export type { AgentState, AgentStateKey } from './types/agent.js';
export type {
  BenchmarkResult,
  ModelInfo,
  EvaluationClassification,
  CriterionSeverity,
  CriterionEvaluation,
  ModelEvaluationReport,
} from './types/benchmark.js';
export {
  HardwareProfileRegistry,
  defaultHardwareProfileRegistry,
} from './services/hardware-profiles.js';
export type { HardwareProfileDefinition } from './services/hardware-profiles.js';

// Tool call benchmark exports
export {
  ToolCallBenchmarkService,
  GET_WEATHER_TOOL,
  GET_STOCK_PRICE_TOOL,
  TEST_SCENARIOS,
} from './services/tool-call-benchmark.js';
export type {
  ToolDefinition,
  ParsedToolCall,
  ParallelToolCallTestResult,
  ToolCallBenchmarkReport,
  ToolCallBenchmarkOptions,
  TestScenario,
} from './services/tool-call-benchmark.js';

// Circuit breaker and error recovery exports
export { CircuitBreaker } from './services/circuit-breaker.js';
export type {
  CircuitBreakerOptions,
  CircuitState,
  ModelFailureRecord,
  CircuitCheckResult,
  CircuitBreakerSnapshot,
} from './services/circuit-breaker.js';
export { ErrorRecoveryService } from './services/error-recovery.js';
export type {
  ErrorCategory,
  RecoveryAction,
  ErrorRecoveryDecision,
  ErrorRecoveryOptions,
  RecoveryContext,
  RecoveryResult,
} from './services/error-recovery.js';

// Benchmark runner exports
export {
  BenchmarkRunnerService,
  BenchmarkRunnerError,
} from './services/benchmark-runner.js';
export type {
  BenchmarkRunnerOptions,
  BenchmarkRunResult,
  FullBenchmarkResult,
} from './services/benchmark-runner.js';
export { parseBenchmarkOutput } from './services/benchmark-output-parser.js';
export type { BenchmarkOutputParseResult } from './services/benchmark-output-parser.js';
export { ModelEvaluationEngine } from './services/model-evaluation-engine.js';
export type { ModelEvaluationOptions } from './services/model-evaluation-engine.js';

// Tunnel service exports
export {
  TunnelService,
  TunnelError,
  TunnelCreationError,
  TunnelProviderNotAvailableError,
} from './services/tunnel-service.js';
export type {
  TunnelInfo,
  TunnelResult,
  TunnelServiceOptions,
  TunnelStatus,
} from './services/tunnel-service.js';

// Kibana connector service exports
export {
  KibanaConnectorService,
  KibanaConnectorError,
  KibanaConnectorCreationError,
  KibanaConnectorConfigError,
} from './services/kibana-connector.js';
export type {
  KibanaConnectorInfo,
  KibanaConnectorResult,
  CreateConnectorOptions,
  KibanaConnectorServiceOptions,
  KibanaConnectorStatus,
} from './services/kibana-connector.js';

// Ollama service exports
export {
  OllamaDeploymentService,
  OllamaDeploymentError,
  OllamaModelPullError,
  OllamaServiceError,
} from './services/ollama-deployment.js';
export type {
  OllamaDeploymentOptions,
  OllamaDeploymentResult,
} from './services/ollama-deployment.js';
export {
  OllamaBenchmarkRunnerService,
  OllamaBenchmarkRunnerError,
} from './services/ollama-benchmark-runner.js';
export type {
  OllamaBenchmarkRunnerOptions,
  OllamaBenchmarkRunResult,
  OllamaFullBenchmarkResult,
} from './services/ollama-benchmark-runner.js';

// Engine abstraction layer exports
export {
  EngineFactory,
  UnsupportedEngineError,
  createEngine,
} from './engines/engine-factory.js';
export { VllmEngine } from './engines/vllm-engine.js';
export type { VllmEngineOptions } from './engines/vllm-engine.js';
export { OllamaEngine } from './engines/ollama-engine.js';
export type { OllamaEngineOptions } from './engines/ollama-engine.js';
export type {
  EngineType,
  InferenceEngine,
  EngineDeploymentResult,
  EngineBenchmarkRunResult,
  EngineFullBenchmarkResult,
  EngineFactoryOptions,
} from './engines/engine-types.js';

// Agent exports
export { graph, createConfigurable, destroyConfigurable } from './agent/index.js';
export type { BenchmarkConfigurable } from './agent/index.js';
export { AgentAnnotation } from './agent/state.js';
export type { GraphState, GraphStateUpdate, RecoveryRecord } from './agent/state.js';

// Kibana evaluation runner exports
export { KibanaEvalRunner, KIBANA_EVAL_TASKS } from './services/kibana-eval-runner.js';
export type { KibanaEvalRunnerOptions } from './services/kibana-eval-runner.js';
export { KibanaEvalStore } from './services/kibana-eval-store.js';
export type {
  KibanaEvalQueryOptions,
  KibanaEvalSummary,
  BenchmarkEvalLink,
} from './services/kibana-eval-store.js';
export {
  SEVERITY_WEIGHTS,
  DEFAULT_KIBANA_EVAL_CONFIG,
} from './types/kibana-eval.js';
export type {
  KibanaEvalTaskCategory,
  KibanaEvalTaskSeverity,
  KibanaEvalTaskOutcome,
  KibanaEvalTaskDefinition,
  KibanaEvalTaskResult,
  KibanaEvalClassification,
  KibanaEvalScoring,
  KibanaEvalReport,
  KibanaEvalRunnerConfig,
} from './types/kibana-eval.js';
