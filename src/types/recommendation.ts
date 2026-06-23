export type Verdict = 'support' | 'investigate' | 'reject';
export type Confidence = 'high' | 'medium' | 'low';

export interface EvalScore {
  suite: string;
  score: number;
  threshold: number;
  passed: boolean;
}

export interface BlockingIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  message: string;
}

export interface VllmConfigUsed {
  contextLength?: number;
  quantization?: string;
  toolCallParser?: string;
  flags: string[];
  source: 'model_card' | 'manual_override' | 'hardware_profile_default';
}

export interface ReportSuggestion {
  category: string;
  title: string;
  description: string;
  expectedImpact: string;
  confidence: Confidence;
}

export interface Stage1Metrics {
  itl: { p50: number; p99: number; mean: number };
  ttft: { p50: number; p99: number; mean: number };
  throughputTps: number;
}

export interface Stage2Results {
  suitesRun: string[];
  suiteResults: Record<string, { score: number; passRate: number; durationSec: number }>;
}

export interface RecommendationReport {
  reportId: string;
  modelId: string;
  modelName: string;
  verdict: Verdict;
  confidence: Confidence;
  hardwareProfile: string;
  stage1Passed: boolean;
  stage2Passed: boolean | null;
  stage2Ran: boolean;
  stage3Ran: boolean;
  passingEvals: EvalScore[];
  blockingIssues: BlockingIssue[];
  vllmConfigUsed: VllmConfigUsed;
  suggestions: ReportSuggestion[];
  stage1Metrics: Stage1Metrics | null;
  stage2Results: Stage2Results | null;
  reasoningSummary: string | null;
  runId: string;
  version: number;
  evaluatedAt: string;
  evaluatedBy: string;
  source: 'discovery' | 'manual';
}
