# Frame Brief: Elastic LLM Benchmarker — Reframing for Eval Pipeline

> Framing step before /shape-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.
> 
> **Last updated**: After user clarification on eval pipeline stages.

## Reported Observation

The `elastic-llm-benchmarker` repo exists as a 33K-line TypeScript project
(LangGraph state machine, vLLM engine, HF model discovery, ES store, Kibana
connector). It was built with ambition but the reliable end-to-end flow is
broken: model discovery is orphaned, the benchmark path defaults to a no-op,
and the Kibana eval integration is conceptually unclear.

**Critical clarification from user** (2026-06-14): The pipeline must have
**at least two distinct eval stages**, not run them simultaneously:

1. **Stage 1 — Performance Benchmark**: Run `vllm bench serve` to measure
   ITL/TTFT/throughput. If results are NOT promising → stop, report.
2. **Stage 2 — Quality Eval (Kibana)**: ONLY if Stage 1 is promising, ensure
   latest Kibana main is available, run specific Agent Builder eval suites
   (user-configurable which ones), get quality scores.
3. **Stage 3 — Reasoning**: Combine Stage 1 + Stage 2 results, reason about
   what could improve eval scores, report actionable suggestions.

Kibana is **NOT** a UI target to build inside. Kibana is a **dependency of
Stage 2** — the quality eval suites live in the Kibana repo and require it
to be cloned and bootstrapped. The user's current workflow already involves
Kibana evals; this automates that work.

"Build inside Kibana" → "Use Kibana's eval infrastructure as a pipeline stage."

## Initial Framing (preserved)

- **User's stated cause or approach**: The existing architecture is "almost
  right" — it just needs to be made autonomous (continuous discovery), given a
  proper queue with human override, made hardware-aware, and integrated with
  Kibana evals for the team to adopt.
- **User's proposed direction**: Extend the existing standalone codebase into
  an autonomous benchmark pipeline with a two-stage evaluation gate, where
  Kibana evals run conditionally on promising performance results.
- **Pre-dispatch narrowing**: The pipeline branches on performance results.
  vLLM bench must be the gatekeeper. Kibana evals are the deeper validation
  that only runs when the gate opens. Reasoning is the final output layer.

## Dimension Map

The previous "Kibana custom app" framing was **incorrect**. The correct
framing is a standalone TypeScript service (the existing codebase, refined)
with a richer evaluation pipeline:

1. **Standalone service** — The existing TS service with a proper scheduler
   (daemon or cron). Kibana is NOT a target platform for hosting code.
   ✓ This is the correct path.

2. **Kibana as eval dependency for Stage 2** — Kibana main must be cloned,
   bootstrapped, and its eval suites invoked via script. This is a heavy
   dependency, similar to how Kibana's own CI runs evals or how the `treadmill`
  framework manages eval runs.

3. **Results surfaced via existing infrastructure** — The existing ES store
   and dashboards remain the output layer. No new Kibana app needed.

## Reframed Problem Statement

> **The actual problem**: The team needs an autonomous evaluation pipeline
> that continuously discovers promising open-source LLMs, gauge-tests them
> with `vllm bench serve`, runs a deeper Kibana eval suite ONLY on
> passing models, reasons about the combined results, and reports
> performance + improvement suggestions — all while preserving the team's
> ability to manually queue models.

The current repo conflated the two eval stages into one, and never wired
Kibana evals to run conditionally. The reframe makes the pipeline a
conditional branching graph, not a linear sequence.

## Pipeline Architecture (Corrected)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Autonomous Benchmark Service (standalone TypeScript daemon)                │
│                                                                             │
│  ┌──────────┐    prom? yes    ┌──────────┐    🡳        ┌──────────┐       │
│  │  Stage 1 │ ───────────────▶│  Stage 2 │ ──────────▶│  Stage 3 │       │
│  │ vLLM     │                 │ Kibana   │             │ Reason   │       │
│  │ bench    │                 │ evals    │             │ about    │       │
│  │ serve    │    no ─────────▶│ (clone   │             │ results  │       │
│  │          │   report perf   │ main,    │             │ + sugg   │       │
│  │          │                 │ run      │             │          │       │
│  │          │                 │ suites)  │             │          │       │
│  └──────────┘                 └──────────┘             └──────────┘       │
│       🡳                            🡳                       🡳             │
│  performance                  quality scores          improvement           │
│  metrics (ITL/                (accuracy,              suggestions           │
│  TTFT/tput)                   tool-call,              (prompt changes,       │
│                               reasoning,               config tweaks,       │
│                               etc)                     etc)                 │
│                                                                             │
│       └────────────────────────────┬────────────────────────────┘           │
│                                    🡳                                        │
│                           Elasticsearch Golden Cluster                        │
│                           (queue + results + traces)                          │
│                                    🡳                                        │
│                           Kibana Dashboards (visualization)                 │
│                           Trace Explorer (raw OTel)                         │
└─────────────────────────────────────────────────────────────────────────────┘
│                                                                             │
│  EDOT Collector (long-running Docker, non-blocking port)                    │
│  ┌────────────────────────────────────────────────────────┐                 │
│  │ Receives OTLP from benchmark worker                    │                 │
│  │ Sends traces → golden ES cluster (OTel native)         │                 │
│  │ Health check: /healthz (verified before each run)      │                 │
│  │ 100% sampling — zero dropping                          │                 │
│  └────────────────────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Trace Infrastructure (NEW)

All eval traces (from Stage 2 Kibana eval suites) are sent via OTLP to the
EDOT Collector, which forwards them to the **golden ES cluster** as native
OpenTelemetry data (not APM). This enables:

1. **Trace-based evaluators**: Existing Kibana eval suites that analyze traces
2. **Raw trace mining**: Stage 3 reasoning can execute ES|QL queries over raw
to find patterns that suggest new evaluator concepts
3. **Post-hoc analysis**: Investigate why a specific eval case failed by
examining the full request/response trace

**OTel field names are PascalCase** in the ES data stream:
`TraceId`, `SpanId`, `ParentSpanId`, `Attributes`, `Duration`, `Name`.
Stage 3 ES|QL queries must match this casing exactly.

## Confidence

**VERY HIGH** — The clarified pipeline matches the user's exact words. The
conflation of "build inside Kibana" as a UI platform was an over-interpretation;
"use Kibana's eval infrastructure" was always the intent.

## What Changes for /shape-plan

1. **The scheduler IS NOT LangGraph** — it's a proper queue-based scheduler
   with conditional branching (Stage 1 must pass before Stage 2 runs).
2. **Stage 2 dependency management** — the service must be able to clone
   Kibana main, bootstrap it, and invoke eval suites. This is a significant
   operational dependency.
3. **Stage 3 reasoning** — requires LLM-based analysis of benchmark results.
   The service likely invokes an LLM (via API or local) to generate
   improvement suggestions.
4. **No Kibana app development** — all Kibana interaction is through eval
   scripts and dashboard viewing. The service remains standalone.
