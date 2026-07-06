# ─── GCP Secret Manager ───────────────────────────────────────────────────────

resource "google_secret_manager_secret" "vllm_api_key" {
  secret_id = "vllm-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "vllm_api_key" {
  secret      = google_secret_manager_secret.vllm_api_key.id
  secret_data = var.vllm_api_key
}

resource "google_secret_manager_secret" "es_api_key" {
  secret_id = "es-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "es_api_key" {
  secret      = google_secret_manager_secret.es_api_key.id
  secret_data = var.es_api_key
}

resource "google_secret_manager_secret" "hf_token" {
  secret_id = "hf-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "hf_token" {
  secret      = google_secret_manager_secret.hf_token.id
  secret_data = var.hf_token
}

resource "google_secret_manager_secret" "buildkite_api_token" {
  secret_id = "buildkite-api-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "buildkite_api_token" {
  secret      = google_secret_manager_secret.buildkite_api_token.id
  secret_data = var.buildkite_api_token
}

# Grant the controller VM's service account access to secrets
resource "google_secret_manager_secret_iam_member" "controller_access" {
  for_each = toset([
    google_secret_manager_secret.vllm_api_key.id,
    google_secret_manager_secret.es_api_key.id,
    google_secret_manager_secret.hf_token.id,
    google_secret_manager_secret.buildkite_api_token.id,
  ])

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}
