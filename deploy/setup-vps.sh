#!/usr/bin/env bash
# Prépare un VPS AlmaLinux 8.10 fraîchement livré pour faire tourner Hermes.
# À exécuter en root sur le VPS :
#
#   ssh root@203.0.113.10
#   curl -fsSL https://raw.githubusercontent.com/<toi>/hermes/main/deploy/setup-vps.sh | bash
#   # ou : scp deploy/setup-vps.sh root@203.0.113.10:/tmp/ && ssh root@203.0.113.10 bash /tmp/setup-vps.sh
#
# Le script est idempotent : le relancer ne casse rien.

set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ce script doit tourner en root." >&2
  exit 1
fi

log "Mise à jour du système"
dnf -y update

log "Outils de base"
dnf -y install curl git vim tar dnf-plugins-core

log "Installation de Docker Engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  # AlmaLinux 8 utilise le dépôt CentOS 8 de Docker
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

log "Pare-feu : on n'ouvre que SSH, HTTP et HTTPS"
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=ssh
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  # HTTP/3 (QUIC)
  firewall-cmd --permanent --add-port=443/udp
  firewall-cmd --reload
fi

log "Swap de 2 Go (le VPS n'a que 4 Go de RAM ; évite les OOM au build)"
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

log "Durcissement SSH : désactivation de l'authentification par mot de passe"
# Ne s'applique QUE si une clé publique est déjà installée, pour ne pas
# se verrouiller dehors.
if [[ -s /root/.ssh/authorized_keys ]]; then
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  systemctl reload sshd
  echo "  → authentification par mot de passe désactivée."
else
  echo "  ⚠ Aucune clé SSH dans /root/.ssh/authorized_keys."
  echo "    Installe ta clé (ssh-copy-id) PUIS relance ce script,"
  echo "    sinon le mot de passe reste le seul accès."
fi

log "Utilisateur applicatif 'hermes'"
id -u hermes >/dev/null 2>&1 || useradd -m -s /bin/bash hermes
usermod -aG docker hermes

log "Terminé."
cat <<'EOF'

Étapes suivantes :

  1. Pointe ton domaine (enregistrement A) vers 203.0.113.10
     et attends la propagation DNS (dig +short ton-domaine.com).

  2. Déploie le code :
       su - hermes
       git clone <url-du-repo> hermes && cd hermes
       cp .env.example .env && vim .env      # remplis les clés
       docker compose up -d --build

  3. Vérifie :
       docker compose ps
       docker compose logs -f caddy   # doit montrer l'obtention du certificat

Génère les secrets avec :  openssl rand -hex 32
EOF
