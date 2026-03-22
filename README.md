# elastic-llm-benchmarker

**Automated LLM discovery, deployment, and benchmarking agent powered by LangGraph.js and the Elastic Stack**

## Features

- **LangGraph agent** — State-machine workflow for model discovery → evaluation → benchmark → storage → Kibana eval
- **Elasticsearch** — Unified storage for results, eval reports, queue, checkpoints, model catalog, errors
- **Kibana** — Dashboards, visualizations, alerting, AI Assistant connector integration
- **Elastic Agent** — Optional metrics and container log collection on vLLM hosts
- **Queue Management API** — Lightweight Express API for model evaluation requests
- **vLLM & Ollama support** — Configurable inference engines (vLLM for production, Ollama for simpler setups)
- **Tool-calling benchmarks** — Validates tool/function-calling support with parallel-call tests

---

## Architecture Overview

### LangGraph Agent

The agent is a state graph with 8 nodes:

| Node | Description |
|------|-------------|
| `idle` | Entry point, initializes state |
| `discover_models` | Fetches model candidates from HuggingFace |
| `evaluate_model` | Picks next model from queue, evaluates thresholds |
| `run_benchmark` | Deploys model (vLLM/Ollama), runs latency/throughput benchmarks |
| `store_results` | Persists results to Elasticsearch |
| `expose_api` | Optionally exposes API via tunnel, creates Kibana connector |
| `run_kibana_eval` | Runs Agent builder evaluation in Kibana (optional) |
| `handle_error` | Error recovery, circuit breaker, retry logic |

**Flow:** `idle` → `discover_models` → `evaluate_model` → (conditional) `run_benchmark` → `store_results` → `expose_api` → `run_kibana_eval` → back to `evaluate_model`. Errors route to `handle_error`, which may retry or return to `idle`.

### Elasticsearch

Six indices store all agent data:

| Index | Purpose |
|-------|---------|
| `benchmarker-results` | Benchmark results with metrics (ITL, TTFT, throughput, tool-call) |
| `benchmarker-eval-reports` | Model evaluation reports and criteria results |
| `benchmarker-queue` | Model evaluation queue (pending, running, completed) |
| `benchmarker-checkpoints` | Deployment lifecycle events (container start/stop) |
| `benchmarker-models` | Discovered model catalog from HuggingFace |
| `benchmarker-errors` | Error and recovery events |

### Kibana

- **Dashboards:** Benchmark Results, Performance Trends, Resource Usage, Queue & Status, Error Analysis  
- **Index patterns** for benchmarker indices and Elastic Agent data (logs, metrics)  
- **Alerting:** Configure connectors (Slack, email, webhook) in Stack Management  
- **AI Assistant:** Connectors to vLLM endpoints for model evaluation  

### Elastic Agent (Optional)

Installed on the vLLM host to collect:

- System metrics (CPU, memory, GPU)
- Docker container logs
- Container metrics  

Data is sent to Elasticsearch for visualization in Kibana.

### Queue Management API

Lightweight Express server for submitting and querying model evaluation requests. Runs independently from the LangGraph agent.

### Docker Compose

Local Elasticsearch and Kibana for development. Optional Fleet Server profile for Elastic Agent enrollment.

---

## Quick Start

```bash
# Clone and install
cd elastic-llm-benchmarker
npm install

# Start local Elastic Stack
# Create .env.docker with ELASTIC_PASSWORD and KIBANA_SYSTEM_PASSWORD
cp .env.docker.example .env.docker  # if available, or create manually
npm run infra:up

# Configure agent
cp .env.example .env
# Edit .env with SSH, HuggingFace, Elasticsearch config

# Import Kibana dashboards
npm run cli -- kibana-import

# Start the LangGraph dev server
npm run dev
```

---

## Setup Guide

### Elasticsearch

**Elastic Cloud:** Set `ELASTICSEARCH_CLOUD_ID` and `ELASTICSEARCH_API_KEY` in `.env`.

**Local Docker Compose:**

- Create `.env.docker` with:
  - `ELASTIC_PASSWORD` — Elasticsearch `elastic` user password
  - `KIBANA_SYSTEM_PASSWORD` — Kibana system user password
- Run: `npm run infra:up`
- Data is stored in Docker volumes. `docker compose down` preserves data; `docker compose down -v` removes it.
- Indices are created automatically on first agent run.

### Kibana

- Auto-configured when using Docker Compose (`http://localhost:5601`).
- Import saved objects: `npm run cli -- kibana-import` (or `elbench kibana-import` after install).
- Dashboards: Benchmark Results, Performance Trends, Resource Usage, Queue & Status, Error Analysis.
- **Alerting:** Stack Management → Rules and Connectors → create connectors (Slack, email, webhook) and alert rules.

### Elastic Agent (Optional)

Install on the vLLM host for metrics and container logs:

1. Set `ELASTIC_AGENT_ENABLED=true`, `ELASTIC_AGENT_FLEET_URL`, `ELASTIC_AGENT_ENROLLMENT_TOKEN` in config.
2. Or use standalone mode with a custom `agent.yml` (see `elastic-agent/agent.yml.template` if present).
3. Collects: system metrics (CPU, memory, GPU), Docker container logs, container metrics.

### Queue Management API

- Start: `npm run api`
- Listens on port 3100 (configurable via `PORT`).
- Requires `ES_URL` and `ES_API_KEY` (or `ELASTICSEARCH_URL` / `ELASTICSEARCH_API_KEY`) for Elasticsearch.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/queue` | POST | Enqueue model (body: `{ modelId, priority?, requestedBy? }`) |
| `/api/queue` | GET | List queue entries (query: `status`, `source`) |
| `/api/queue/current` | GET | Get currently running entry |
| `/api/queue/:id` | DELETE | Cancel pending entry |
| `/api/queue/events` | GET | Server-Sent Events for queue/current state (polling every 5s) |

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `elbench status` | View ES-backed agent status (results counts, queue, current run) |
| `elbench results` | Query benchmark results (filters: model, status, after, before, gpu-type, limit, offset, summary) |
| `elbench export` | Export results as JSON or CSV |
| `elbench migrate-to-es` | Migrate SQLite DB to Elasticsearch |
| `elbench kibana-import` | Import Kibana saved objects (dashboards, visualizations) |
| `elbench print-deploy-command` | Print vLLM docker run command with tool calling for a model |
| `elbench tool-call-benchmark` | Run tool-call benchmark against a running API |

Use `npm run cli -- <command>` or install globally and run `elbench <command>`.

---

## Configuration

Environment variables (and `.env`):

### SSH

| Variable | Description |
|----------|-------------|
| `SSH_HOST` | GCP VM hostname or IP |
| `SSH_PORT` | SSH port (default: 22) |
| `SSH_USERNAME` | SSH username |
| `SSH_PASSWORD` | SSH password (or use `SSH_PRIVATE_KEY_PATH`) |
| `SSH_PRIVATE_KEY_PATH` | Path to private key |
| `SSH_USE_SUDO` | Use sudo for Docker (default: false) |

### HuggingFace

| Variable | Description |
|----------|-------------|
| `HUGGINGFACE_TOKEN` | HuggingFace API token |

### Elasticsearch

| Variable | Description |
|----------|-------------|
| `ELASTICSEARCH_URL` | ES URL (e.g. `http://localhost:9200`) |
| `ELASTICSEARCH_API_KEY` | API key (optional, for auth) |
| `ELASTICSEARCH_CLOUD_ID` | Elastic Cloud deployment ID |

### Elastic Agent

| Variable | Description |
|----------|-------------|
| `ELASTIC_AGENT_ENABLED` | Enable agent setup on vLLM host |
| `ELASTIC_AGENT_FLEET_URL` | Fleet server URL |
| `ELASTIC_AGENT_ENROLLMENT_TOKEN` | Fleet enrollment token |
| `ELASTIC_AGENT_MODE` | `fleet` or `standalone` |

### Engine

| Variable | Description |
|----------|-------------|
| `ENGINE_TYPE` | `vllm` (default) or `ollama` |
| `ENGINE_API_PORT` | API port (vLLM: 8000, Ollama: 11434) |
| `ENGINE_DOCKER_IMAGE` | Docker image override |
| `OLLAMA_USE_DOCKER` | Use Docker for Ollama |
| `OLLAMA_NUM_GPU_LAYERS` | GPU layers for Ollama (-1 = all) |
| `VLLM_GPU_MEMORY_UTILIZATION` | GPU memory fraction (default: 0.9) |
| `ENGINE_MAX_MODEL_LEN` | Max model length override |

### Tunnel

| Variable | Description |
|----------|-------------|
| `TUNNEL_ENABLED` | Enable public API tunnel |
| `TUNNEL_PROVIDER` | `ngrok` (default), `cloudrun`, `load_balancer` |
| `NGROK_AUTH_TOKEN` | ngrok auth token |
| `NGROK_REGION` | ngrok region |
| `TUNNEL_LOCAL_PORT` | Local port to tunnel |
| `NGROK_DOMAIN` | Custom ngrok domain (paid) |
| `TUNNEL_TIMEOUT_MS` | Tunnel creation timeout |
| `TUNNEL_RETRY_ATTEMPTS` | Retry attempts |
| `TUNNEL_RETRY_DELAY_MS` | Retry delay |

### Kibana Connector

| Variable | Description |
|----------|-------------|
| `KIBANA_CONNECTOR_ENABLED` | Auto-create Kibana connectors |
| `KIBANA_CONNECTOR_URL` | Kibana URL |
| `KIBANA_CONNECTOR_API_KEY` | Kibana API key |
| `KIBANA_CONNECTOR_NAME_PREFIX` | Connector name prefix (default: `vllm-`) |
| `KIBANA_CONNECTOR_REQUEST_TIMEOUT_MS` | Request timeout |

### App Logs

| Variable | Description |
|----------|-------------|
| `APP_LOG_FILE` | Path for JSONL app log file (enables file logging) |

### Queue API

| Variable | Description |
|----------|-------------|
| `PORT` | Queue API port (default: 3100) |
| `ES_URL` | Elasticsearch URL for Queue API |
| `ES_API_KEY` | Elasticsearch API key for Queue API |

---

## Elasticsearch Indices

| Index | Description |
|-------|-------------|
| `benchmarker-results` | Benchmark results with metrics (ITL, TTFT, throughput, P99, tool-call success) |
| `benchmarker-eval-reports` | Model evaluation reports (classification, criteria, pass/fail) |
| `benchmarker-queue` | Model evaluation queue (pending, running, completed, cancelled) |
| `benchmarker-checkpoints` | Deployment lifecycle events (deploy, stop, errors) |
| `benchmarker-models` | Discovered model catalog (HuggingFace metadata) |
| `benchmarker-errors` | Error and recovery events (circuit breaker, retries) |

---

## Migration from SQLite

If migrating from the legacy SQLite setup:

1. **Backup** your SQLite database (`results/benchmarks.db` or path from `RESULTS_DIR`).
2. **Configure Elasticsearch** in `.env` (local or cloud).
3. **Start Elastic Stack** if using local: `npm run infra:up`.
4. **Run migration:**  
   `elbench migrate-to-es --db /path/to/benchmarks.db`
5. **Import Kibana dashboards:**  
   `elbench kibana-import`

---

## Development

```bash
npm run dev          # LangGraph dev server
npm run build:ts     # Build TypeScript (tsup)
npm run typecheck    # Type check
npm run test         # Run tests (Vitest)
npm run lint         # Lint
npm run format       # Format code
```

---

## Docker Compose Reference

| Command | Description |
|---------|-------------|
| `npm run infra:up` | Start Elasticsearch and Kibana |
| `npm run infra:down` | Stop (volumes preserved) |
| `npm run infra:reset` | Stop and remove all volumes (data wiped) |
| `npm run infra:fleet` | Start with Fleet Server (for Elastic Agent enrollment) |

Uses `.env.docker` for `ELASTIC_PASSWORD`, `KIBANA_SYSTEM_PASSWORD`, and optional overrides.

---

## License

MIT
