# ─── Outputs ──────────────────────────────────────────────────────────────────

output "gpu_vm_internal_ip" {
  value       = google_compute_instance.gpu_vm.network_interface[0].network_ip
  description = "Private IP of the GPU VM (controller SSHs here for vLLM deploys)."
}

output "gpu_vm_external_ip" {
  value       = google_compute_instance.gpu_vm.network_interface[0].access_config[0].nat_ip
  description = "Ephemeral external IP of the GPU VM (for Docker pulls)."
}

output "controller_vm_internal_ip" {
  value       = google_compute_instance.controller_vm.network_interface[0].network_ip
  description = "Private IP of the controller VM."
}

output "controller_vm_external_ip" {
  value       = google_compute_instance.controller_vm.network_interface[0].access_config[0].nat_ip
  description = "Ephemeral external IP of the controller VM (operator SSH)."
}

output "load_balancer_ip" {
  value       = google_compute_global_address.lb_ip.address
  description = "Reserved global IP for the HTTPS Load Balancer. Point var.dns_domain's A-record here."
}

output "load_balancer_url" {
  value       = "https://${var.dns_domain}"
  description = "Stable public HTTPS URL for vLLM (Tier-2 Buildkite weekly evals). Set as tunnel.loadBalancerUrl in config/gcp.json."
}

output "vpc_self_link" {
  value       = google_compute_network.vpc.self_link
  description = "Self link of the benchmarker VPC."
}

output "secret_ids" {
  value = {
    vllm_api_key        = google_secret_manager_secret.vllm_api_key.id
    es_api_key          = google_secret_manager_secret.es_api_key.id
    hf_token            = google_secret_manager_secret.hf_token.id
    buildkite_api_token = google_secret_manager_secret.buildkite_api_token.id
  }
  description = "Secret Manager IDs for runtime credential injection."
}
