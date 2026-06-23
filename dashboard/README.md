# LLM Benchmarker Dashboard

Two ways to visualize benchmark results from the `elastic-llm-benchmarker` project:

1. **Built-in web dashboard** (no Kibana required) — served by the daemon's REST API.
2. **Kibana saved objects** (this folder) — richer ad-hoc exploration inside Kibana.

## Built-in web dashboard

A self-contained, dark-mode dashboard ships with the API server and needs no
build step, npm install, or Kibana import. Start the API and open it in a
browser:

```bash
npm run api          # or: npm run start -- --api-port 3200
open http://localhost:3200/        # also available at /dashboard
```

It renders live from the REST API:

- **KPI tiles** — models tracked, total benchmark runs, overall pass rate, and
  current pipeline state.
- **Model leaderboard** — sortable table of every model with pass rate, mean
  throughput (tok/s), inter-token latency (ms), tool-call success, and last-run
  status.
- **Average throughput by model** and a **pass/fail run-outcome** donut.
- **Live queue panel** — the currently-running model plus pending entries,
  streamed over Server-Sent Events (`/api/queue/events`), with polling fallback.

Data routes consumed (all unauthenticated, consistent with the existing
internal-UI queue routes): `GET /healthz`, `GET /api/stats`,
`GET /api/models?summaries=true`, `GET /api/queue`, `GET /api/queue/events`.
The source file is [`public/dashboard.html`](../public/dashboard.html).

---

## Kibana saved objects

Kibana saved objects that visualize benchmark results.

## Files

- `benchmarker-dashboard.ndjson` — Kibana saved objects (index patterns + visualizations + dashboard)
- `generate-dashboard.cjs` — Node script that regenerates the NDJSON file

## Import

### Option 1: Kibana UI
1. Open Kibana → Stack Management → Saved Objects
2. Click **Import** and select `benchmarker-dashboard.ndjson`
3. Choose **Create new objects with random IDs** or **Check for existing objects**
4. Open the dashboard under **Analytics → Dashboards**

### Option 2: Script
```bash
./scripts/import-dashboard.sh \
  --kibana-url http://localhost:5601 \
  --api-key "your-api-key"
```

The script validates the HTTP 200 response and prints the dashboard URL.

## Required Elasticsearch Indices

| Index Pattern | Time Field | Purpose |
|---------------|------------|---------|
| `benchmarker-results-*` | `@timestamp` | Benchmark metrics (throughput, latency, GPU, etc.) |
| `benchmarker-eval-reports` | `@timestamp` | Evaluation gate pass/fail results |

Ensure these indices exist and contain data before opening the dashboard.

## Visualizations

### Throughput vs Concurrency
- **Type**: Lens line chart
- **X-axis**: `benchmark_metrics.concurrency_level`
- **Y-axis**: Average `benchmark_metrics.throughput_tokens_per_sec`
- **Split**: `model_id`
- **Shows**: How throughput scales with concurrent requests per model

### Latency Distribution
- **Type**: Lens grouped bar chart
- **X-axis**: `model_id`
- **Metrics**: Average `benchmark_metrics.itl_ms`, `benchmark_metrics.ttft_ms`, and `benchmark_metrics.p99_latency_ms`
- **Shows**: Per-model latency profile (inter-token, time-to-first-token, and P99)

### GPU Memory Usage
- **Type**: Lens time-series line chart
- **X-axis**: `@timestamp`
- **Y-axis**: Average `gpu_utilization.total_vram_used_gb`
- **Split**: `model_id`
- **Shows**: GPU VRAM consumption over time by model

### Stage 2 Gate Pass Rate
- **Type**: Lens metric
- **Value**: Average `passed_count` from `benchmarker-eval-reports`
- **Shows**: Percentage of models meeting all Stage-2 evaluation thresholds

### Benchmark Duration by Model
- **Type**: Lens bar chart
- **X-axis**: `model_id`
- **Y-axis**: Average `benchmark_metrics.p99_latency_ms` (proxy for total benchmark duration)
- **Shows**: Relative benchmark duration across models

### Raw Benchmark Results
- **Type**: Saved search table
- **Columns**: Timestamp, model, pass status, throughput, concurrency, VRAM used
- **Shows**: Raw documents for drill-down analysis

## Dashboard Layout

The **LLM Benchmarker Overview** dashboard is organized in three rows:

1. **Top row**: Throughput vs Concurrency | Latency Distribution
2. **Middle row**: GPU Memory Usage | Stage 2 Gate Pass Rate
3. **Bottom row**: Benchmark Duration by Model | Raw Benchmark Results table

Default time range: **Last 7 days**

## Regenerating

If you change fields or want to update the dashboard, edit `generate-dashboard.cjs` and run:

```bash
cd dashboard
node generate-dashboard.cjs
```

This will overwrite `benchmarker-dashboard.ndjson` with updated objects.
