# ─── Observability: Uptime Check + Alert Policy ───────────────────────────────

# Uptime check on the controller VM's /health endpoint (port 3200).
# The benchmarker's queue-server API serves /health and reflects scheduler
# + ES connectivity. GCP pings this every 1 min and alerts on 2+ failures.

resource "google_monitoring_uptime_check_config" "controller_health" {
  display_name = "Benchmarker Controller /health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    port           = 3200
    request_path   = "/health"
    use_ssl        = false
    ping_config {
      pings_count = 1
    }
  }

  # Monitored resource: the controller VM's external IP
  resource_type = "UPTIME_CHECK_IP"
}

# Alert notification channel — placeholder; operator wires Slack/Email via
# `gcloud beta monitoring channels create` or the Console UI. The alert
# policy references this by ID once the channel exists.
resource "google_monitoring_alert_policy" "controller_down" {
  display_name = "Benchmarker Controller Down"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failure rate > 50% for 5 min"

    condition_threshold {
      filter = join("", [
        "resource.type = \"uptime_url\" ",
        "AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" ",
        "AND metric.label.check_id = \"", google_monitoring_uptime_check_config.controller_health.uptime_check_id, "\"",
      ])
      comparison      = "COMPARISON_LT"
      threshold_value = 0.5
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content = <<-EOT
      ## Benchmarker Controller is not responding

      The `/health` endpoint on the controller VM (port 3200) has been failing
      for 5+ minutes. The benchmarker daemon may be down.

      ### Triage
      1. SSH to the controller: `gcloud compute ssh benchmarker-controller`
      2. Check the container: `docker ps -a | grep benchmarker`
      3. Check logs: `docker logs --tail 100 benchmarker`
      4. If the container exited, restart: `docker start benchmarker`
      5. Check ES connectivity: `curl localhost:3200/health | jq`

      See `deploy/gcp/RUNBOOK.md` for the full runbook.
    EOT
    mime_type = "text/markdown"
  }
}

# Alert: GPU VM health check failing (vLLM backend unreachable from LB)
resource "google_monitoring_alert_policy" "gpu_vllm_down" {
  display_name = "GPU VM vLLM Backend Unhealthy"
  combiner     = "OR"

  conditions {
    display_name = "LB backend health < 100% for 5 min"

    condition_threshold {
      filter = join("", [
        "resource.type = \"compute.backend_service\" ",
        "AND metric.type = \"compute.googleapis.com/https/backend_request_count\" ",
        "AND metric.label.backend_service_name = \"", google_compute_backend_service.vllm.name, "\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
    }
  }

  # Disabled by default — the backend request count alert is noisy without
  # traffic. Operator enables after confirming baseline. The uptime check
  # above is the primary signal.
  enabled = false

  documentation {
    content = "The vLLM backend on the GPU VM is failing LB health checks. SSH to the GPU VM and check `docker ps` + `nvidia-smi`."
    mime_type = "text/markdown"
  }
}
