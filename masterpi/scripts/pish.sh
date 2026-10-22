#!/usr/bin/env bash
# Non-interactive SSH/SCP/RSSH helper for the MasterPi (password via SSH_ASKPASS).
# Usage:
#   pish "<remote bash command>"      -> run command on Pi
#   pisc <local> <remote-path>        -> scp a file to Pi
#   pirsync <local-dir> <remote-dir>  -> rsync a folder to Pi
set -euo pipefail
PI_HOST="${PI_HOST:-192.168.1.70}"
PI_USER="${PI_USER:-pi}"

# askpass script that prints the password
ASKPASS_DIR="$(mktemp -d)"
cat > "$ASKPASS_DIR/ap.sh" <<'AP'
#!/bin/sh
cat "$PI_PW_FILE"
AP
chmod 700 "$ASKPASS_DIR/ap.sh"
export PI_PW_FILE="$ASKPASS_DIR/pw"
printf '875D875d' > "$PI_PW_FILE"
chmod 600 "$PI_PW_FILE"
export SSH_ASKPASS="$ASKPASS_DIR/ap.sh"
export SSH_ASKPASS_REQUIRE=force
export DISPLAY="${DISPLAY:-:0}"

SSHOPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
         -o PubkeyAuthentication=no -o PreferredAuthentications=password
         -o ConnectTimeout=10)

cleanup() { rm -rf "$ASKPASS_DIR"; }
trap cleanup EXIT

case "${1:-}" in
  run)
    shift
    ssh "${SSHOPTS[@]}" "$PI_USER@$PI_HOST" "$@" < /dev/null
    ;;
  scp)
    shift; src="$1"; dst="$2"
    scp "${SSHOPTS[@]}" -r "$src" "$PI_USER@$PI_HOST:$dst" < /dev/null
    ;;
  rsync)
    shift; src="$1"; dst="$2"
    rsync -az --delete -e "ssh ${SSHOPTS[*]}" "$src" "$PI_USER@$PI_HOST:$dst" < /dev/null
    ;;
  *)
    echo "usage: pish.sh run|scp|rsync ..." >&2
    exit 2
    ;;
esac
