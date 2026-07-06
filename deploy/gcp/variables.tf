# ─── Input Variables ──────────────────────────────────────────────────────────

variable "project_id" {
  type        = string
  description = "GCP project ID for the benchmarker deployment."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "GCP region for the controller VM and Load Balancer."
}

variable "zone" {
  type        = string
  default     = "us-central1-a"
  description = "GCP zone for the GPU VM (A100s are zone-scoped)."
}

variable "gpu_machine_type" {
  type        = string
  default     = "a2-ultragpu-2g"
  description = "Machine type for the always-on GPU VM (2x A100-80GB default)."
}

variable "gpu_count" {
  type        = number
  default     = 2
  description = "Number of GPUs attached to the GPU VM (must match machine type)."
}

variable "controller_machine_type" {
  type        = string
  default     = "e2-small"
  description = "Machine type for the controller VM (cheap, always-on)."
}

variable "ssh_public_key_path" {
  type        = string
  description = "Path to the SSH public key for controller→GPU VM access."
}

variable "dns_domain" {
  type        = string
  description = "Domain name for the HTTPS Load Balancer (e.g. vllm-benchmarker.example.com). A DNS A-record must point to the reserved LB IP."
}

variable "vllm_api_key" {
  type        = string
  sensitive   = true
  description = "Static API key that vLLM and the Load Balancer require. Injected via Secret Manager at runtime."
}

variable "es_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Elastic Serverless API key for results storage."
}

variable "es_url" {
  type        = string
  default     = ""
  description = "Elastic Serverless endpoint URL."
}

variable "hf_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "HuggingFace token for model discovery (higher rate limits)."
}

variable "buildkite_api_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Buildkite API token for weekly matrix eval triggers (Tier-2)."
}
