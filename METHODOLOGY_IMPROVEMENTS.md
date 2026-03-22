# Methodology Improvements

> A living document proposing enhancements to the elastic-llm-benchmarker evaluation approach.
> Last updated: 2025-02-19

---

## Table of Contents

- [1. Current Methodology Overview](#1-current-methodology-overview)
- [2. Additional Benchmark Scenarios](#2-additional-benchmark-scenarios)
- [3. Quality Metrics Beyond Speed](#3-quality-metrics-beyond-speed)
- [4. Reasoning Capability Tests](#4-reasoning-capability-tests)
- [5. Multi-Turn Conversation Evaluation](#5-multi-turn-conversation-evaluation)
- [6. Code Generation Benchmarks](#6-code-generation-benchmarks)
- [7. Comparison with Industry Benchmarks](#7-comparison-with-industry-benchmarks)
- [8. Implementation Roadmap](#8-implementation-roadmap)

---

## 1. Current Methodology Overview

The elastic-llm-benchmarker currently evaluates open-source LLMs through a three-stage pipeline:

### Pre-Deployment Filtering

Hard filters applied before any GPU resources are used:

| Filter | Threshold | Rationale |
|--------|-----------|-----------|
| Context window | ≥ 128K tokens | Required for large-document agentic workflows |
| Model size | Fits in 2× A100 80 GB (160 GB VRAM) | Hardware constraint |
| Architecture | vLLM-supported | Deployment compatibility |
| Tool calling | Supported (Qwen / Mistral / Llama families) | Core product requirement |

### Performance Benchmarking

Metrics collected via `vllm bench serve` at concurrency levels 1, 4, and 16:

- **ITL** (Inter-Token Latency) — ms between tokens
- **TTFT** (Time To First Token) — first-token response time
- **Throughput** — tokens per second
- **P99 Latency** — 99th-percentile latency
- **Tool Call Latency** — average tool-call round-trip time
- **Tool Call Success Rate** — percentage of valid tool-call responses
- **Parallel Call Support** — concurrent tool-call capability

### Classification

| Tier | Condition |
|------|-----------|
| **APPROVED** | All hard + preferred criteria pass |
| **CONDITIONAL** | All hard criteria pass; ≥ 1 preferred criterion fails |
| **REJECTED** | ≥ 1 hard criterion fails |

**Hard requirements:** context window ≥ 128 K tokens, parallel tool calling = 100 % success.
**Preferred criteria:** ITL < 20 ms, tool-call latency < 1 000 ms.

### Gaps Identified

1. No quality or accuracy assessment — a fast but hallucinating model can still be APPROVED.
2. No reasoning evaluation — critical for agentic multi-step workflows.
3. Single-turn only — no measurement of context coherence over long conversations.
4. No code-generation benchmarks — relevant for developer-facing tool-use scenarios.
5. No cross-referencing with industry leaderboards (LMSYS, OpenRouter).
6. Limited stress-testing — concurrency levels cap at 16.

---

## 2. Additional Benchmark Scenarios

### 2.1 High-Concurrency Stress Testing

**Problem:** Current concurrency levels (1, 4, 16) do not reflect production traffic patterns where dozens to hundreds of users may be active simultaneously.

**Proposal:**

| Scenario | Concurrency | Purpose |
|----------|-------------|---------|
| Idle baseline | 1 | Current — best-case latency |
| Light load | 4 | Current — small team |
| Moderate load | 16 | Current — standard workload |
| **Heavy load** | 64 | **New** — simulate realistic production traffic |
| **Peak load** | 128 | **New** — capacity planning and degradation analysis |
| **Burst load** | 256 (short burst) | **New** — thundering-herd resilience |

**New metrics to capture under high concurrency:**

- Throughput degradation curve (tokens/s vs. concurrency)
- Latency percentiles: P50, P90, P95, P99, P99.9
- Request failure rate at each concurrency level
- GPU memory utilization under load

**Implementation notes:**

```typescript
// Extend BenchmarkThresholds in src/types/config.ts
concurrencyLevels: [1, 4, 16, 64, 128], // configurable
burstConcurrency: 256,
burstDurationSeconds: 30,
```

### 2.2 Long-Context Benchmarks

**Problem:** The 128 K context-window requirement is verified but never stress-tested with actual long inputs. A model may claim 128 K support but degrade severely beyond 32 K tokens.

**Proposal:**

| Input Length | Purpose |
|-------------|---------|
| 4 K tokens | Baseline (current `sonnetInputLen: 256` is very short) |
| 16 K tokens | Standard document size |
| 32 K tokens | Long-form analysis |
| 64 K tokens | Large codebase / multi-document |
| 128 K tokens | Full context utilization |

**Metrics per length tier:**

- TTFT scaling (should be sublinear, not exponential)
- ITL stability (should remain constant regardless of prompt length)
- Answer accuracy on information retrieval tasks (needle-in-a-haystack)
- Memory utilization and OOM thresholds

### 2.3 Heterogeneous Workload Simulation

**Problem:** Real production workloads mix short and long requests, tool calls, and pure generation. Uniform benchmarks miss interference effects.

**Proposal:** Create a mixed workload generator that simultaneously issues:

- 50 % short-generation requests (< 1 K tokens)
- 30 % medium-generation requests (1 K – 8 K tokens)
- 15 % tool-calling requests (parallel function calls)
- 5 % long-context requests (> 32 K tokens)

Measure aggregate throughput and per-request-type latency distributions.

### 2.4 Cold-Start and Warm-Up Benchmarks

**Problem:** First-request latency after model loading is ignored. Production deploys need to know warm-up time.

**Proposal:**

- Measure TTFT for the first 10 requests after container start (cold cache)
- Measure TTFT for requests 100–110 (warm cache)
- Report the warm-up curve: number of requests until latency stabilizes

---

## 3. Quality Metrics Beyond Speed

### 3.1 Output Accuracy and Faithfulness

**Problem:** A model that answers quickly but incorrectly provides negative value. The current methodology has zero quality gates.

**Proposal: Factual Accuracy Test Suite**

| Test Category | Description | Scoring |
|--------------|-------------|---------|
| Factual QA | 50 questions with verified answers (SQuAD-style) | Exact match / F1 |
| Summarization | 10 long documents with reference summaries | ROUGE-L, BERTScore |
| Instruction following | 20 precise formatting instructions | Pass/fail per constraint |
| Hallucination detection | 10 prompts designed to elicit fabrication | Human-labeled or LLM-as-judge |

**Proposed thresholds:**

- Factual QA F1 ≥ 0.80 (preferred)
- Summarization ROUGE-L ≥ 0.35 (preferred)
- Instruction following ≥ 90 % (hard requirement)
- Hallucination rate ≤ 10 % (hard requirement)

### 3.2 Output Consistency

**Problem:** Nondeterministic models may produce wildly different answers for the same prompt at `temperature=0`.

**Proposal:**

- Run 5 identical prompts × 20 test cases at `temperature=0`
- Measure pairwise similarity (cosine embedding distance)
- Report consistency score (0–1 scale)
- **Threshold:** consistency ≥ 0.90 (preferred)

### 3.3 Safety and Alignment

**Problem:** Deployed models should refuse harmful requests and follow system instructions.

**Proposal:**

| Test | Description | Metric |
|------|-------------|--------|
| Harmful request refusal | 20 adversarial prompts (jailbreak attempts) | Refusal rate |
| System prompt adherence | 10 system prompts with behavioral constraints | Compliance rate |
| PII handling | 5 prompts containing fake PII to detect leakage | Leak rate |

**Threshold:** Harmful request refusal ≥ 90 % (preferred).

### 3.4 Structured Output Reliability

**Problem:** For tool-calling use cases, the model must reliably produce valid JSON. Current tests only verify tool-call API compliance, not general structured output.

**Proposal:**

- 30 prompts requesting specific JSON schemas
- Measure JSON parse success rate
- Measure schema conformance rate (required fields, correct types)
- **Threshold:** JSON validity ≥ 95 %, schema conformance ≥ 90 % (hard requirement)

---

## 4. Reasoning Capability Tests

### 4.1 Multi-Step Logical Reasoning

**Problem:** Agentic workflows require the model to plan, decompose tasks, and chain tool calls logically. No current test measures this.

**Proposal: Reasoning Test Battery**

| Test | Description | Evaluation |
|------|-------------|------------|
| Chain-of-thought math | 20 multi-step arithmetic / algebra problems | Correct final answer |
| Logical deduction | 15 syllogism and constraint-satisfaction puzzles | Correct conclusion |
| Causal reasoning | 10 cause-and-effect scenarios | LLM-as-judge scoring |
| Planning | 10 task-decomposition prompts | Completeness and ordering |

**Implementation approach:**

```typescript
interface ReasoningTestResult {
  category: 'math' | 'logic' | 'causal' | 'planning';
  totalTests: number;
  correctCount: number;
  accuracyRate: number;
  avgLatencyMs: number;
  details: ReasoningTestCase[];
}
```

**Proposed thresholds:**

- Math accuracy ≥ 70 % (preferred)
- Logic accuracy ≥ 75 % (preferred)
- Planning completeness ≥ 80 % (preferred)
- Overall reasoning score ≥ 70 % (preferred)

### 4.2 Agentic Tool-Use Reasoning

**Problem:** Current tool-call tests verify that the model *can* call tools but not that it calls the *right* tools in the *right order* with the *right arguments*.

**Proposal:**

| Scenario | Complexity | Expected Behavior |
|----------|-----------|-------------------|
| Weather lookup | Simple | Call `get_weather(city)` with correct city |
| Multi-city comparison | Medium | Call `get_weather` for each city, then synthesize |
| Data pipeline | Complex | Call `fetch_data` → `transform` → `store` in sequence |
| Error recovery | Advanced | Handle tool failure, retry or use alternative |

**Metrics:**

- Tool selection accuracy (correct function chosen)
- Argument correctness (valid parameters)
- Sequencing accuracy (correct order for dependent calls)
- Error recovery rate (graceful handling of simulated failures)

**Threshold:** Tool selection accuracy ≥ 85 % (preferred), sequencing ≥ 80 % (preferred).

### 4.3 Context Utilization and Information Retrieval

**Problem:** A 128 K context window is useless if the model cannot retrieve information from the middle or end of the context.

**Proposal: Needle-in-a-Haystack Tests**

- Insert a specific fact at positions: 10 %, 25 %, 50 %, 75 %, 90 % of context
- Context lengths: 16 K, 32 K, 64 K, 128 K tokens
- Measure retrieval accuracy at each position × length combination
- **Threshold:** retrieval accuracy ≥ 90 % at all positions up to 64 K (preferred), ≥ 80 % at 128 K (preferred)

---

## 5. Multi-Turn Conversation Evaluation

### 5.1 Context Coherence Over Turns

**Problem:** All current benchmarks are single-turn. Production agentic workflows involve multi-turn conversations where the model must maintain state and refer back to earlier messages.

**Proposal:**

| Test Scenario | Turns | Focus |
|--------------|-------|-------|
| Fact recall | 5 | Remember a fact from turn 1, verify in turn 5 |
| Instruction persistence | 8 | System prompt behavioral constraints persist |
| Progressive refinement | 6 | Iteratively refine an answer based on user feedback |
| Contradictory correction | 4 | User corrects an earlier statement, model adapts |

**Metrics:**

- Fact retention accuracy (does the model remember earlier context?)
- Instruction adherence over turns (does the model drift from system prompt?)
- Coherence score (does each response logically follow the conversation?)
- Contradiction detection (does the model notice and resolve contradictions?)

### 5.2 Multi-Turn Tool Calling

**Problem:** Current tool-call benchmarks are single-request. Real agentic workflows involve iterative tool use across turns.

**Proposal:**

```
Turn 1: User asks for weather comparison
Turn 2: Model calls get_weather("New York")
Turn 3: System returns weather data
Turn 4: Model calls get_weather("London")
Turn 5: System returns weather data
Turn 6: Model synthesizes comparison using both results
```

**Metrics:**

- State tracking accuracy (does the model remember previous tool results?)
- Plan completion rate (does it complete the full workflow?)
- Unnecessary tool call rate (does it re-call already-retrieved data?)
- Average turns to task completion

**Threshold:** Plan completion rate ≥ 90 % (preferred), unnecessary call rate ≤ 5 % (preferred).

### 5.3 Long-Conversation Performance

**Problem:** Latency and quality may degrade as conversation history grows.

**Proposal:**

- Run conversations of 10, 25, 50, 100 turns
- Measure ITL and TTFT degradation curve
- Measure quality scores (fact recall, coherence) at each milestone
- Report the "conversation ceiling" — the turn count at which quality drops below threshold

---

## 6. Code Generation Benchmarks

### 6.1 HumanEval and MBPP Execution

**Problem:** For developer-facing tool use (code assistants, code generation agents), standard coding benchmarks provide a well-understood quality baseline.

**Proposal:**

| Benchmark | Tasks | Metric | Industry Standard |
|-----------|-------|--------|-------------------|
| HumanEval | 164 Python functions | pass@1, pass@5 | GPT-4: ~86 % pass@1 |
| HumanEval+ | 164 (stricter tests) | pass@1 | More rigorous subset |
| MBPP | 974 Python tasks | pass@1 | Broader task coverage |
| MultiPL-E | Multi-language (TS, Go, Rust) | pass@1 per language | Language diversity |

**Implementation:**

```typescript
interface CodeGenBenchmarkResult {
  benchmark: 'humaneval' | 'humaneval_plus' | 'mbpp' | 'multple';
  language: string;
  totalProblems: number;
  passAt1: number;
  passAt5: number;
  avgGenerationTimeMs: number;
  syntaxErrorRate: number;
  runtimeErrorRate: number;
}
```

**Proposed thresholds:**

- HumanEval pass@1 ≥ 50 % (preferred)
- MBPP pass@1 ≥ 55 % (preferred)

### 6.2 Practical Code Tasks

**Problem:** HumanEval tests are algorithmic puzzles. Real-world code tasks involve APIs, frameworks, and boilerplate.

**Proposal: Custom Code Task Suite**

| Task Category | Count | Example |
|--------------|-------|---------|
| REST API endpoint | 5 | Generate Express/Fastify route with validation |
| Database query | 5 | Write SQL or ORM query from natural language |
| Unit test generation | 5 | Generate Vitest/Jest tests for given function |
| Bug fix | 5 | Identify and fix a bug in provided code |
| Refactoring | 5 | Improve code quality while preserving behavior |

**Metrics:**

- Functional correctness (tests pass)
- Code quality (ESLint/TypeScript errors)
- Completeness (all edge cases handled)
- Conciseness (unnecessary boilerplate)

### 6.3 TypeScript-Specific Evaluation

**Problem:** Given this project's TypeScript stack, TypeScript code generation quality is especially relevant.

**Proposal:**

- 20 TypeScript-specific prompts (type inference, generics, discriminated unions)
- Measure: type correctness (compiles with `strict: true`), idiomatic patterns
- Include framework-specific tasks (React components, Express middleware, Zod schemas)
- **Threshold:** TypeScript compilation rate ≥ 80 % (preferred)

---

## 7. Comparison with Industry Benchmarks

### 7.1 LMSYS Chatbot Arena Integration

**What it is:** LMSYS Chatbot Arena is a crowdsourced platform where users blindly compare model outputs, producing Elo ratings.

**Proposed integration:**

| Data Point | Source | Usage |
|-----------|--------|-------|
| Elo rating | LMSYS leaderboard API | Pre-filter: skip models with Elo < 1100 |
| Ranking tier | Arena categories (coding, math, reasoning) | Weight evaluation for specific use cases |
| Win rate vs. reference | Pairwise comparisons | Context for our benchmark results |

**Implementation:**

```typescript
interface LMSYSCorrelation {
  modelId: string;
  arenaElo: number | null;
  arenaCodingElo: number | null;
  arenaReasoningElo: number | null;
  ourClassification: EvaluationClassification;
  correlationNotes: string;
}
```

**Value proposition:**

- Cross-validate our automated benchmarks against human preference
- Identify models where our benchmarks and human judgment diverge
- Use Elo as a pre-filter to reduce unnecessary GPU spend

### 7.2 OpenRouter Performance Data

**What it is:** OpenRouter aggregates LLM serving data and publishes performance statistics.

**Proposed integration:**

| Data Point | Source | Usage |
|-----------|--------|-------|
| Median latency | OpenRouter stats API | Compare against our vLLM deployment numbers |
| Throughput | OpenRouter serving stats | Validate our throughput measurements |
| Pricing per token | OpenRouter pricing | Cost-effectiveness analysis |
| Availability | OpenRouter uptime data | Reliability context |

**Usage in evaluation:**

- If our vLLM deployment shows significantly worse latency than OpenRouter's data, investigate deployment configuration issues
- If our deployment outperforms OpenRouter, note this as a positive signal for self-hosting
- Generate cost-per-token comparison: self-hosted vLLM vs. OpenRouter pricing

### 7.3 Open LLM Leaderboard (HuggingFace)

**What it is:** The HuggingFace Open LLM Leaderboard evaluates models on standard academic benchmarks.

**Proposed integration:**

| Benchmark | Category | Usage |
|-----------|----------|-------|
| MMLU | Knowledge | General capability baseline |
| ARC-Challenge | Reasoning | Science reasoning indicator |
| HellaSwag | Common sense | Basic language understanding |
| GSM8K | Math | Mathematical reasoning proxy |
| TruthfulQA | Truthfulness | Hallucination tendency indicator |
| Winogrande | Coreference | Language understanding |

**Implementation:**

- Fetch leaderboard scores during model discovery (they're in model card metadata)
- Include in the `ModelInfo` type for context in evaluation reports
- Use as a soft pre-filter: skip models with MMLU < 60 % to avoid wasting GPU time

### 7.4 Cross-Benchmark Correlation Dashboard

**Proposal:** Create a dashboard view that shows:

| Column | Source |
|--------|--------|
| Model ID | Our system |
| Our Classification | Evaluation engine |
| ITL (ms) | Our benchmark |
| Tool Call Success | Our benchmark |
| LMSYS Elo | LMSYS API |
| HumanEval pass@1 | Our or HF data |
| MMLU Score | HF Leaderboard |
| OpenRouter Latency | OpenRouter API |

This enables at-a-glance comparison of our evaluation against industry consensus and helps identify any systematic biases in our methodology.

---

## 8. Implementation Roadmap

### Phase 1: Quick Wins (1–2 weeks)

| Enhancement | Effort | Impact | Priority |
|------------|--------|--------|----------|
| Extend concurrency levels to [1, 4, 16, 64, 128] | Low | High | P0 |
| Add P50, P90, P95 latency percentiles | Low | Medium | P0 |
| Fetch HF Leaderboard scores during discovery | Low | Medium | P1 |
| Add structured output (JSON) validity tests | Medium | High | P1 |

### Phase 2: Quality Gates (2–4 weeks)

| Enhancement | Effort | Impact | Priority |
|------------|--------|--------|----------|
| Instruction-following test suite (20 tests) | Medium | High | P0 |
| Needle-in-a-haystack context tests | Medium | High | P0 |
| Long-context latency benchmarks (4K → 128K) | Medium | High | P1 |
| Output consistency measurement | Low | Medium | P1 |
| Cold-start / warm-up benchmarks | Low | Medium | P2 |

### Phase 3: Reasoning & Multi-Turn (4–6 weeks)

| Enhancement | Effort | Impact | Priority |
|------------|--------|--------|----------|
| Multi-step reasoning test battery | High | High | P0 |
| Agentic tool-use reasoning scenarios | High | High | P0 |
| Multi-turn conversation evaluation | High | High | P1 |
| Multi-turn tool calling tests | Medium | High | P1 |

### Phase 4: Code & Industry Integration (6–8 weeks)

| Enhancement | Effort | Impact | Priority |
|------------|--------|--------|----------|
| HumanEval / MBPP code generation benchmarks | High | Medium | P1 |
| LMSYS Chatbot Arena data integration | Medium | Medium | P1 |
| OpenRouter performance comparison | Medium | Medium | P2 |
| TypeScript-specific code evaluation | Medium | Medium | P2 |
| Cross-benchmark correlation dashboard | High | High | P2 |

### Phase 5: Advanced Scenarios (8+ weeks)

| Enhancement | Effort | Impact | Priority |
|------------|--------|--------|----------|
| Mixed workload simulation | High | High | P1 |
| Safety and alignment tests | Medium | Medium | P2 |
| Long-conversation performance degradation | High | Medium | P2 |
| Cost-per-token analysis (self-host vs. API) | Medium | Medium | P2 |

---

## Appendix A: Proposed Type Extensions

Below are the TypeScript type additions that would support the proposed enhancements:

```typescript
// ─── Quality Metrics ────────────────────────────────────────────────────────

export interface QualityMetrics {
  factualAccuracyF1: number;
  summarizationRougeL: number;
  instructionFollowingRate: number;
  hallucinationRate: number;
  consistencyScore: number;
  jsonValidityRate: number;
  jsonSchemaConformanceRate: number;
}

// ─── Reasoning Metrics ──────────────────────────────────────────────────────

export interface ReasoningMetrics {
  mathAccuracy: number;
  logicAccuracy: number;
  causalReasoningScore: number;
  planningCompleteness: number;
  toolSelectionAccuracy: number;
  toolSequencingAccuracy: number;
  overallReasoningScore: number;
}

// ─── Multi-Turn Metrics ─────────────────────────────────────────────────────

export interface MultiTurnMetrics {
  factRetentionAccuracy: number;
  instructionAdherenceRate: number;
  coherenceScore: number;
  planCompletionRate: number;
  unnecessaryToolCallRate: number;
  conversationCeiling: number;
}

// ─── Code Generation Metrics ────────────────────────────────────────────────

export interface CodeGenMetrics {
  humanEvalPassAt1: number;
  humanEvalPassAt5: number;
  mbppPassAt1: number;
  typescriptCompilationRate: number;
  avgGenerationTimeMs: number;
}

// ─── Industry Benchmark Correlation ─────────────────────────────────────────

export interface IndustryBenchmarkData {
  lmsysElo: number | null;
  lmsysCodingElo: number | null;
  lmsysReasoningElo: number | null;
  openRouterMedianLatencyMs: number | null;
  openRouterThroughput: number | null;
  hfLeaderboardMmlu: number | null;
  hfLeaderboardArc: number | null;
  hfLeaderboardHellaswag: number | null;
  hfLeaderboardGsm8k: number | null;
  hfLeaderboardTruthfulqa: number | null;
}

// ─── Extended Evaluation Report ─────────────────────────────────────────────

export interface ExtendedModelEvaluationReport extends ModelEvaluationReport {
  qualityMetrics: QualityMetrics | null;
  reasoningMetrics: ReasoningMetrics | null;
  multiTurnMetrics: MultiTurnMetrics | null;
  codeGenMetrics: CodeGenMetrics | null;
  industryBenchmarks: IndustryBenchmarkData | null;
}
```

## Appendix B: Updated Classification Proposal

The classification system should expand to account for quality metrics:

| Criterion | Severity | Current | Proposed |
|-----------|----------|---------|----------|
| Context window ≥ 128 K | HARD | ✅ | ✅ (no change) |
| Parallel tool calling = 100 % | HARD | ✅ | ✅ (no change) |
| ITL < 20 ms | PREFERRED | ✅ | ✅ (no change) |
| Tool call latency < 1 000 ms | PREFERRED | ✅ | ✅ (no change) |
| Instruction following ≥ 90 % | HARD | — | ✅ **new** |
| Hallucination rate ≤ 10 % | HARD | — | ✅ **new** |
| JSON schema conformance ≥ 90 % | HARD | — | ✅ **new** |
| Factual accuracy F1 ≥ 0.80 | PREFERRED | — | ✅ **new** |
| Reasoning score ≥ 70 % | PREFERRED | — | ✅ **new** |
| HumanEval pass@1 ≥ 50 % | PREFERRED | — | ✅ **new** |
| Multi-turn coherence ≥ 0.85 | PREFERRED | — | ✅ **new** |
| Needle-in-haystack ≥ 90 % (64 K) | PREFERRED | — | ✅ **new** |

## Appendix C: References

- [LMSYS Chatbot Arena Leaderboard](https://chat.lmsys.org/?leaderboard)
- [OpenRouter Model Rankings](https://openrouter.ai/rankings)
- [HuggingFace Open LLM Leaderboard](https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard)
- [HumanEval Benchmark](https://github.com/openai/human-eval)
- [MBPP Benchmark](https://github.com/google-research/google-research/tree/master/mbpp)
- [Needle in a Haystack Test](https://github.com/gkamradt/LLMTest_NeedleInAHaystack)
- [vLLM Benchmark Docs](https://docs.vllm.ai/en/latest/serving/benchmarking.html)
