#!/usr/bin/env bash
# Runs ON the MasterPi: install the client + config-server systemd units,
# grant the config server passwordless restart of the client, then enable+start.
# Safe to re-run (idempotent).
set -eu

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # .../masterpi (has systemd/)
# Live workdir = where client.py actually runs. Prefer the deployed dir.
WORKDIR="${MASTERPI_WORKDIR:-$HOME/masterpi_client}"
[ -f "$WORKDIR/client.py" ] || WORKDIR="$DIR"
[ -f "$WORKDIR/client.py" ] || { echo "[install] client.py not found in $WORKDIR or $DIR"; exit 1; }
USER_NAME="${MASTERPI_USER:-$(whoami)}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"

echo "[install] workdir=$WORKDIR user=$USER_NAME python=$PYTHON_BIN"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

for u in masterpi-client masterpi-config; do
  [ -f "$DIR/systemd/$u.service" ] || { echo "[install] missing $DIR/systemd/$u.service"; exit 1; }
  tmp="$(mktemp)"
  sed -e "s|@WORKDIR@|$WORKDIR|g" -e "s|@USER@|$USER_NAME|g" -e "s|@PYTHON@|$PYTHON_BIN|g" \
      "$DIR/systemd/$u.service" > "$tmp"
  $SUDO tee "/etc/systemd/system/$u.service" >/dev/null < "$tmp"
  rm -f "$tmp"
  echo "[install] wrote $u.service"
done

# Passwordless restart of the client, invoked by config_server.py (runs as $USER_NAME).
SUDOER=/etc/sudoers.d/masterpi-config
tmp="$(mktemp)"
printf '%s ALL=(ALL) NOPASSWD: /bin/systemctl restart masterpi-client, /usr/bin/systemctl restart masterpi-client\n' "$USER_NAME" > "$tmp"
$SUDO tee "$SUDOER" >/dev/null < "$tmp"
$SUDO chmod 440 "$SUDOER"
$SUDO visudo -cf "$SUDOER" >/dev/null && echo "[install] sudoers drop-in ok" || { echo "[install] sudoers invalid, aborting"; rm -f "$tmp"; exit 1; }
rm -f "$tmp"

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now masterpi-client masterpi-config
sleep 2
systemctl --no-pager --full status masterpi-client masterpi-config 2>/dev/null | grep -E "Active:|●" || true
echo "[install] done. client settings page: http://<this-pi-ip>:8010"
