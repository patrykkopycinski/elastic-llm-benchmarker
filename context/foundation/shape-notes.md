# 10x Shape Notes: Elastic LLM Benchmarker

## Product
domain: AI Infrastructure & Model Evaluation
last_hero_commit: main
scope: A (internal Elastic engineers evaluating LLMs for Agent Builder support), with extensibility path to C (external self-hosting guidance)

---

## 1. Vision (the movie in 6 months)

The user opens Slack on Monday morning and sees a message from the
`#agent-builder-model-qual` channel:

> **New Model Proposal: Qwen/Qwen2.5-72B-Instruct**
> - Verdict: **SUPPORT** — passes performance gate (ITL p50 38ms @ A100) and quality eval suite (tool_calls 0.94, skill_invocation 0.91).
> - vLLM config: `--quantization=awq --tensor-parallel-size=2 --max-model-len=131072`
> - Recommendation: Add to EIS supported-models list. Community demand is high (HF 7d downloads: 42K).

They click the link, open the recommendation report in Kibana, review the
eval results, and decide to add the model to the Elastic Inference Service
supported-models list. That afternoon, the model is live in the Agent Builder
model picker for all users.

This is not a dashboard they browse. **It's a product decision artifact.**

---

## 2. Person + Persona

**Primary Person (Phase 1 — now):**
Elastic Agent Builder PM or engineering lead (e.g., a real human with a
Slack handle) who needs data to decide "should we officially support this
LLM in our platform?" They don't have time to manually run evals on every
HF trending model. They need a **trusted recommendation** with evidence.

**Secondary Person (Phase 1 — now):**
Elastic ML infrastructure engineer (Patryk + teammates) who operates the
qualification pipeline, curates eval suites, and maintains the hardware
profile configurations. They need the pipeline to be autonomous, observable,
and debuggable.

**Tertiary Person (Phase 2 — later):**
External user (startup engineer, hobbyist, enterprise self-hoster) who wants
to know "what open-source LLM should I deploy on my 2×A100 setup for
best tool-calling performance?" They need a tool they can run locally and
get actionable guidance.

**What they all have in common:** They want a **verdict**, not raw numbers.

---

## 3. Success Criteria

1. **Pipeline produces a recommendation report.** A concrete JSON/YAML artifact with a
   `verdict` field (support / investigate / reject), `passing_evals[]`, `blocking_issues[]`,
   and `suggested_vllm_flags`. This is the primary output. Dashboards are secondary.

2. **Phase 1: Elastic PM can make a model-support decision in < 5 minutes**
   after reading the recommendation report. No manual eval running required.

3. **Autonomous proposal, human decision.** The service proposes models for
   support. Humans approve or reject. The system never auto-promotes a model
   to "supported."

4. **Performance gate prevents wasted eval compute.** Stage 1 (vLLM bench)
   must gate Stage 2 (Kibana eval suites). Slow models are rejected quickly
   (minutes), not after hours of expensive eval runs.

5. **Hardware-aware by default.** The recommendation must reference a specific
   hardware profile and explain if results would differ on other hardware.

6. **Trace-based reasoning.** Stage 3 executes ES|QL over raw OTel traces to
   understand *why* eval cases failed, not just *that* they failed.

7. **Phase 2 ready (extensibility).** The codebase must have a clean
   abstraction boundary so the same pipeline can be run by an external user
   without Elastic-internal infra (EIS, golden ES cluster, private HF org).

---

## 4. MVP

A TypeScript CLI service that:
1. Is told (manually, for MVP) to evaluate one specific model + hardware profile.
2. Deploys that model on the target GPU VM via vLLM.
3. Runs Stage 1 performance benchmark (ITL/TTFT/throughput).
4. If Stage 1 passes, runs Stage 2 Kibana eval suites (tool_calls, latency, skill_invocation).
5. Runs Stage 3 LLM reasoning over Stage 1+2 results + raw traces.
6. Writes a **recommendation report** to ES with a `verdict`.

No autonomous discovery in MVP. No REST API in MVP. No golden cluster
forwarding in MVP. One model, one verdict, one report.

**MVP output:** A document in `recommendation-report` index that a PM can
read and act on.

---

## 5. High-level MVP flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Manual Queue  │────▶│  Stage 1: vLLM  │────▶│ Stage 2: Kibana │
│  "Evaluate      │     │   bench serve   │pass │   eval suites   │
│   Qwen2.5-72B   │     │ (ITL/TTFT/tput) │     │  (tool_calls,   │
│   on A100x2"    │     │  gate: p50 ITL  │     │  latency, etc)  │
│                 │     │   < 200ms       │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                                              │
         │                     ┌────────────────────────┘
         │                     ▼ fail
         │            ┌─────────────────┐
         │            │  Verdict: REJECT│
         │            │  Reason: perf   │
         │            └─────────────────┘
         │                     ▲
         └─────────────────────┘
                               │
                               ▼ pass
                     ┌─────────────────┐
                     │ Stage 3: Reason │
                     │ over results +  │
                     │  raw OTel traces│
                     └─────────────────┘
                               │
                               ▼
                     ┌─────────────────┐
                     │Recommendation   │
                     │Report:          │
                     │SUPPORT /        │
                     │INVESTIGATE /    │
                     │REJECT           │
                     └─────────────────┘
```

**Recommendation Report Schema (MVP):**
```json
{
  "model_id": "Qwen/Qwen2.5-72B-Instruct",
  "verdict": "support",
  "hardware_profile": "A100-80GBx2",
  "stage1_passed": true,
  "stage2_passed": true,
  "passing_evals": [
    {"suite": "tool_calls", "score": 0.94, "threshold": 0.85},
    {"suite": "skill_invocation", "score": 0.91, "threshold": 0.80}
  ],
  "blocking_issues": [],
  "vllm_config_used": {
    "flags": ["--quantization=awq", "--tensor-parallel-size=2"],
    "source": "hardware_profile_default"
  },
  "suggestions": [
    {
      "category": "vllm_config",
      "suggested": "Try --quantization=fp8 for +12% throughput",
      "expected_impact": "ITL p50 improves from 38ms to 33ms",
      "confidence": "medium"
    }
  ],
  "confidence": "high",
  "evaluated_at": "2026-06-15T10:00:00Z",
  "evaluated_by": "benchmarker-v2.1.0",
  "trace_run_id": "uuid"
}
```

---

## 6. What It Does and Doesn't Do

**DOES:**
- Propose models for official Agent Builder support based on empirical eval data.
- Gate expensive Stage 2 evals behind a cheap Stage 1 performance check.
- Produce a structured recommendation report as the primary output artifact.
- Run on a GPU VM (SSH) with vLLM as the inference engine.
- Store all results in Elasticsearch ( queue, runs, reasoning, recommendations ).

**DOESN'T:**
- Auto-promote models to "supported" — humans decide.
- Define the eval bar — Agent Builder team defines thresholds; benchmarker
  measures against them.
- Provide a public web UI in Phase 1 (CLI + ES dashboards + Slack/report links
  are sufficient for internal use).
- Support Ollama or other inference engines (vLLM only, for reproducibility).
- Handle model fine-tuning or RLHF.

---

## 7. Business Logic

> The service autonomously proposes promising open-source LLMs for Elastic
> Agent Builder support by running them through a 3-stage qualification
> pipeline (performance gate → AB eval suite validation → improvement
> reasoning), then produces a structured recommendation report with a
> support / investigate / reject verdict.

**Key rules:**
- Stage 1 must pass before Stage 2 runs. No exceptions.
- A model cannot receive "support" without passing ALL configured eval suites.
- The recommendation report is immutable once written (append-only, versioned).
- Phase 1 runs against Elastic-internal infra; Phase 2 abstracted behind a
  clean interface.

---

## 8. Framing

Previous framing was "personal deployment helper for ML engineers." That
was incorrect — it optimized for a single engineer choosing their own model.

**Correct framing:** This is a **product qualification gate** that produces
a decision artifact for an internal product team. The output is not a
dashboard to browse — it's a recommendation report to act on. The primary
metric is not "how many models did we benchmark" but "how many support
decisions were made faster because of this tool."

---

## 9. Open Questions (pre-PRD)

1. **Which eval suites define the Agent Builder bar?** The benchmarker does not
   decide the threshold; it measures against it. We need the canonical list of
   required eval suites and their pass thresholds from the Agent Builder team.
   *Decision: Start with ["tool_calls", "skill_invocation"] as MVP suites.*

2. **How does the PM consume the recommendation?** Slack webhook? Email?
   Kibana dashboard with alert? *Decision: Write to ES + optional Slack
   webhook. Kibana dashboard for historical review.*

3. **Phase 2 abstraction boundary.** Which parts of the pipeline must be
   portable (vLLM, ES, HF) and which are Elastic-specific (EIS connector,
   golden cluster, private HF org)? *Decision: Core pipeline (queue →
   deploy → benchmark → eval → reason) is portable. Elastic-specific
   integrations are pluggable connectors behind an interface.*

4. **What happens when a model is already in the recommendation-report index?**
   Re-evaluate or skip? *Decision: Versioned reports. Each evaluation is a
   new document. Latest report is the current recommendation.*

5. **Discovery in MVP?** No — MVP is manual queue only. Discovery (autonomous
   proposal) comes after the recommendation artifact is proven.

## 10. Decisions Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | Scope starts with Phase A (internal Elastic), extensible to Phase C (external) | Internal-first means we can use Elastic infra (EIS, golden ES, private HF); external abstraction comes later | 2026-06-15 |
| 2 | Primary output = recommendation report, not dashboards | PMs make decisions on documents, not by browsing charts | 2026-06-15 |
| 3 | Remove LangGraph; use explicit scheduler + ES-backed queue | LangGraph stub is non-functional; explicit scheduler is proven and debuggable | 2026-06-15 |
| 4 | Stage 1 gates Stage 2 unconditionally | Prevents wasting expensive eval compute on slow models | 2026-06-15 |
| 5 | vLLM-only; Ollama removed | Reproducibility and team expertise both favor vLLM | 2026-06-15 |
| 6 | MVP excludes autonomous discovery and REST API | Prove the recommendation artifact first, then automate input | 2026-06-15 |
| 7 | No auto-promotion to "supported" | The benchmarker proposes; the PM/engineering lead decides. Authority separation prevents unilateral support decisions | 2026-06-15 |

## 11. Confidence

**VERY HIGH** — The reframed intent ("which LLMs should Agent Builder
officially support?") is a concrete, measurable job. The MVP is minimal
(one model, one report) but validates the core value proposition. The
four execution gaps (orphaned discovery, stub LangGraph, split queue
binary, missing recommendation artifact) are all addressable within the
existing codebase architecture.
