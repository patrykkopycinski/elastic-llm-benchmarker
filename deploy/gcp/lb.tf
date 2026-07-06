# ─── HTTPS Load Balancer (Tier-2 Buildkite weekly evals) ──────────────────────
#
# Fronts the GPU VM's vLLM (port 8000) with a stable, reserved global IP.
# Buildkite weekly CI agents call this URL instead of an ephemeral tunnel,
# eliminating the ngrok/cloudflared URL churn that orphaned in-flight builds.

# Unmanaged instance group wrapping the GPU VM
resource "google_compute_instance_group" "gpu_ig" {
  name      = "gpu-vm-ig"
  zone      = var.zone
  instances = [google_compute_instance.gpu_vm.id]

  named_port {
    name = "vllm"
    port = 8000
  }
}

# Health check — vLLM serves /v1/models on port 8000
resource "google_compute_health_check" "vllm" {
  name = "vllm-health-check"

  http_health_check {
    port         = 8000
    request_path = "/v1/models"
  }

  timeout_sec         = 5
  check_interval_sec  = 30
  healthy_threshold   = 2
  unhealthy_threshold = 3
}

# Backend service
resource "google_compute_backend_service" "vllm" {
  name          = "vllm-backend"
  protocol      = "HTTP"
  port_name     = "vllm"
  health_checks = [google_compute_health_check.vllm.id]

  backend {
    group           = google_compute_instance_group.gpu_ig.id
    balancing_mode  = "UTILIZATION"
    max_utilization = 0.8
  }
}

# URL map — route everything to the vLLM backend
resource "google_compute_url_map" "vllm" {
  name            = "vllm-url-map"
  default_service = google_compute_backend_service.vllm.id
}

# Self-signed managed TLS certificate for HTTPS
# NOTE: For production, use a managed certificate with a verified domain.
resource "google_compute_managed_ssl_certificate" "vllm" {
  name = "vllm-cert"

  managed {
    domains = [var.dns_domain]
  }
}

# HTTPS proxy
resource "google_compute_target_https_proxy" "vllm" {
  name             = "vllm-https-proxy"
  url_map          = google_compute_url_map.vllm.id
  ssl_certificates = [google_compute_managed_ssl_certificate.vllm.id]
}

# Global forwarding rule (binds reserved IP → HTTPS proxy)
resource "google_compute_global_forwarding_rule" "https" {
  name       = "vllm-https-rule"
  target     = google_compute_target_https_proxy.vllm.id
  port_range = "443"
  ip_address = google_compute_global_address.lb_ip.address
}

# Also allow HTTP (301 → HTTPS) for convenience / health probes
resource "google_compute_url_map" "http_redirect" {
  name = "vllm-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http_redirect" {
  name    = "vllm-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name       = "vllm-http-rule"
  target     = google_compute_target_http_proxy.http_redirect.id
  port_range = "80"
  ip_address = google_compute_global_address.lb_ip.address
}
