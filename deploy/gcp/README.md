# GCP Autonomous Deployment

Terraform-managed infrastructure for running the `elastic-llm-benchmarker` 24/7 on GCP.

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │        HTTPS Load Balancer            │
 Buildkite weekly   │  (reserved IP, TLS, authenticated)    │
 ──────────────────►│  vllm-benchmarker.example.com         │
                    └──────────────┬───────────────────────┘
                                   │ port 8000
                    ┌──────────────▼───────────────────────┐
                    │   GPU VM (a2-ultragpu-2g, always-on)  │
                    │   vLLM via Docker (2x A100-80GB)      │
                    │   private IP: 10.10.0.10              │
                    └──────────────▲───────────────────────┘
                                   │ SSH (private VPC)
                    ┌──────────────┴───────────────────────┐
                    │  Controller VM (e2-small, always-on)  │
                    │  Benchmarker daemon (Docker)          │
                    │  private IP: 10.10.0.20               │
                    └──────────────────────────────────────┘
```

- **Tier-1 evals** (validation): controller runs `eval-suite-runner` locally in-VPC,
  reaching vLLM over the private IP (10.10.0.10:8000).
- **Tier-2 evals** (full weekly matrix): Buildkite reaches vLLM via the HTTPS LB.

## One-time setup

```bash
cd deploy/gcp

# 1. Copy and edit tfvars
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars  # fill project_id, dns_domain, secrets, SSH key path

# 2. Create the managed DNS A-record pointing var.dns_domain → (reserve first)
terraform init
terraform apply -target=google_compute_global_address.lb_ip
# Note the lb_ip output, create A-record in Cloud DNS, then:
terraform apply
```

## Outputs

After `terraform apply`:
- `controller_vm_external_ip` — SSH here: `gcloud compute ssh benchmarker-controller`
- `load_balancer_url` — set as `tunnel.loadBalancerUrl` in `config/gcp.json`
- `gpu_vm_internal_ip` — the SSH target for the daemon's vLLM deploys

## Runtime

The controller VM pulls secrets from Secret Manager at boot and starts the
benchmarker container via `controller-startup.sh`. The daemon runs with
`evalTier: local` (Tier-1 in-VPC) by default. To enable Tier-2 weekly
Buildkite matrix, set `buildkite.enabled: true` and `evalTier` accordingly.

## GPU VM is always-on

The `a2-ultragpu-2g` instance has `automatic_restart = true` and is never
stopped by the benchmarker. GCP may restart it for host maintenance (the
scheduling config allows terminate-then-restart); the daemon's lease-based
restart logic handles graceful recovery.
