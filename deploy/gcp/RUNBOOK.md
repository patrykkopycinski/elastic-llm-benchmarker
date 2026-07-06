# GCP Deployment Runbook

## Health Signals

| Signal | Source | Meaning |
|---|---|---|
| `/health` uptime check | GCP Monitoring (every 60s) | Controller VM + daemon + ES are up |
| LB health check | GCP HTTPS LB (every 30s) | vLLM on the GPU VM is reachable |
| Cloud Logging | `gcloud logging tail` | Daemon logs (filtered to `resource.type=gce_instance`) |

## Common Issues

### Controller /health failing (alert: "Controller Down")

1. SSH to the controller:
   ```bash
   gcloud compute ssh benchmarker-controller --zone=us-central1-a
   ```
2. Check the container:
   ```bash
   docker ps -a | grep benchmarker
   docker logs --tail 100 benchmarker
   ```
3. If the container exited:
   ```bash
   docker start benchmarker
   ```
4. If ES is unreachable, check connectivity:
   ```bash
   curl -s localhost:3200/health | jq .status
   ```
5. Verify secrets are resolved (the startup script sets env vars from Secret Manager):
   ```bash
   docker exec benchmarker env | grep -E 'ES_|HF_|BUILDKITE_'
   ```

### GPU VM vLLM unreachable (LB 502s)

1. SSH to the GPU VM:
   ```bash
   gcloud compute ssh benchmarker-gpu-vm --zone=us-central1-a
   ```
2. Check Docker + vLLM:
   ```bash
   docker ps | grep vllm
   docker logs --tail 50 <vllm-container-name>
   ```
3. Check GPU health:
   ```bash
   nvidia-smi
   ```
4. If vLLM crashed, the benchmarker daemon will redeploy on the next model
   claim cycle (no manual restart needed).

### Daemon is running but not dequeuing models

1. Check the ES queue depth via the dashboard:
   ```bash
   curl -s localhost:3200/api/queue | jq '.data | length'
   ```
2. Check the daemon state:
   ```bash
   docker exec benchmarker cat /app/data/daemon-state.json | jq
   ```
3. Check the lease — another daemon may hold it:
   ```bash
   curl -s localhost:3200/api/leases | jq
   ```

### Secret rotation

Secrets are stored in GCP Secret Manager. Rotate via:

```bash
echo "new-key" | gcloud secrets versions add vllm-api-key --data-file=-
# Then restart the controller to pick up the new version:
docker restart benchmarker
```

## Cost Notes

- GPU VM (`a2-ultragpu-2g`): ~$6.12/hr → ~$4,485/mo (always-on, the dominant cost)
- Controller VM (`e2-small`): ~$13/mo
- HTTPS LB + reserved IP: ~$20/mo
- Secret Manager: negligible (4 secrets)
- Cloud Logging: free tier covers benchmarker volume

The GPU VM is the only significant cost. It is intentionally always-on to
eliminate cold-start latency and GPU driver re-initialization — the
benchmarker's value is continuous model coverage.
