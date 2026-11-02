#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server (Azure VM, AWS EC2/Lightsail, or any other) for this app.
# Uses Ubuntu's own packages. Run as a user with sudo:  bash deploy/install-docker.sh
set -euo pipefail
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git sqlite3
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
echo "Docker installed. Log out and back in (so the docker group applies), then continue with docs/DEPLOY.md step 4."
