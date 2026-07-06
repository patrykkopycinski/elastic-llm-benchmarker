# ─── Provider + Networking + Compute ──────────────────────────────────────────

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ─── VPC ──────────────────────────────────────────────────────────────────────

resource "google_compute_network" "vpc" {
  name                    = "benchmarker-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "benchmarker-subnet"
  ip_cidr_range = "10.10.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

# Allow SSH + internal traffic within the VPC
resource "google_compute_firewall" "allow_internal" {
  name    = "benchmarker-allow-internal"
  network = google_compute_network.vpc.name

  source_ranges = ["10.10.0.0/24"]

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "icmp"
  }
}

# Allow SSH from the internet to both VMs (operator access)
resource "google_compute_firewall" "allow_ssh" {
  name    = "benchmarker-allow-ssh"
  network = google_compute_network.vpc.name

  source_ranges = ["0.0.0.0/0"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Allow HTTPS (health check + LB backend) to the GPU VM
resource "google_compute_firewall" "allow_https" {
  name    = "benchmarker-allow-https"
  network = google_compute_network.vpc.name

  source_ranges = ["0.0.0.0/0", "130.211.0.0/22", "35.191.0.0/16"]

  allow {
    protocol = "tcp"
    ports    = ["443", "8000"]
  }
}

# Allow health checks from GCP LB health checkers
resource "google_compute_firewall" "allow_health_checks" {
  name    = "benchmarker-allow-health-checks"
  network = google_compute_network.vpc.name

  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]

  allow {
    protocol = "tcp"
    ports    = ["8000"]
  }
}

# ─── GPU VM (always-on, 2x A100-80GB) ────────────────────────────────────────

# Static internal IP so the controller can SSH to a stable address
resource "google_compute_address" "gpu_internal" {
  name         = "gpu-vm-internal"
  subnetwork   = google_compute_subnetwork.id
  address_type = "INTERNAL"
  address      = "10.10.0.10"
  region       = var.region
}

# Reserved global IP for the HTTPS Load Balancer (Tier-2 Buildkite path)
resource "google_compute_global_address" "lb_ip" {
  name          = "vllm-lb-ip"
  address_type  = "EXTERNAL"
  ip_version    = "IPV4"
  purpose       = "GLOBAL"
}

data "google_compute_image" "gpu_image" {
  project = "cloud-tier1-docker"
  family  = "cos-stable"
}

data "google_compute_default_service_account" "default" {}

resource "google_compute_instance" "gpu_vm" {
  name         = "benchmarker-gpu-vm"
  machine_type = var.gpu_machine_type
  zone         = var.zone

  hostname = var.dns_domain

  boot_disk {
    initialize_params {
      image = data.google_compute_image.gpu_image.self_link
      size  = 1000
      type  = "pd-ssd"
    }
  }

  guest_accelerator {
    type  = "nvidia-a100-80gb"
    count = var.gpu_count
  }

  scheduling {
    # Always-on: do NOT enable automatic restart suppression or preemptible
    on_host_maintenance = "TERMINATE"
    automatic_restart   = true
  }

  network_interface {
    subnetwork = google_compute_subnetwork.id
    network_ip = google_compute_address.gpu_internal.address

    access_config {} # ephemeral external IP for Docker pulls + ngrok fallback
  }

  # Install NVIDIA drivers + Docker on first boot
  metadata = {
    install-nvidia-driver = "true"
    docker-cluster        = "benchmarker"
    startup-script = <<-EOT
      #!/bin/bash
      set -e
      # Install NVIDIA driver if not present (COS provides cos-nvidia-installer)
      if ! command -v nvidia-smi &>/dev/null; then
        cos-extensions install gpu
      fi
      systemctl enable docker || true
      systemctl start docker || true
    EOT
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true
}

# ─── Controller VM (always-on, cheap) ────────────────────────────────────────

resource "google_compute_instance" "controller_vm" {
  name         = "benchmarker-controller"
  machine_type = var.controller_machine_type
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = data.google_compute_image.gpu_image.self_link
      size  = 50
      type  = "pd-standard"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.id
    network_ip = "10.10.0.20"
    access_config {} # ephemeral external IP for operator SSH
  }

  # Install Docker + Docker Compose on first boot
  metadata = {
    startup-script = <<-EOT
      #!/bin/bash
      set -e
      apt-get update && apt-get install -y docker.io docker-compose
      systemctl enable docker
      systemctl start docker
      usermod -aG docker benchmarker || true
    EOT
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true
}
