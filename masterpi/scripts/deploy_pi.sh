#!/usr/bin/env bash
# Push masterpi/ code to the Raspberry Pi and run the client.
# Usage: ./deploy_pi.sh user@pi_ip [remote_dir] [--service]
#   --service : after sync+deps, install & start systemd units (detached, watchdog)
#               instead of a foreground client run.
#               The units target $HOME/masterpi_client when it holds client.py,
#               otherwise remote_dir — see install_pi_service.sh.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pull --service out of args, keep positional PI_HOST / REMOTE_DIR.
SERVICE=false
pos=()
for a in "$@"; do
  if [ "$a" = "--service" ]; then SERVICE=true; else pos+=("$a"); fi
done
PI_HOST="${pos[0]:?usage: deploy_pi.sh user@pi_ip [remote_dir] [--service]}"
REMOTE_DIR="${pos[1]:-~/masterpi}"

echo "[deploy] syncing ${SRC_DIR} -> ${PI_HOST}:${REMOTE_DIR}"
ssh "${PI_HOST}" "mkdir -p ${REMOTE_DIR}"
rsync -avz --exclude '__pycache__' --exclude 'config.json' "${SRC_DIR}/" "${PI_HOST}:${REMOTE_DIR}/"

echo "[deploy] installing deps on Pi"
ssh "${PI_HOST}" "python3 -m pip install --quiet -r ${REMOTE_DIR}/requirements.txt || true"

if [ "$SERVICE" = true ]; then
  echo "[deploy] installing systemd services on Pi (client + config web)"
  ssh "${PI_HOST}" "bash ${REMOTE_DIR}/scripts/install_pi_service.sh"
  echo "[deploy] service mode done. Settings page: http://<pi-ip>:8010"
else
  echo "[deploy] launching client (dryRun) on Pi; Ctrl-C to stop"
  ssh -t "${PI_HOST}" "cd ${REMOTE_DIR} && cp -n config.example.json config.json 2>/dev/null || true && python3 client.py --config config.json"
fi
