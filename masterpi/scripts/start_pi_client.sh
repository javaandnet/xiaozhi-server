#!/bin/bash
# Runs ON the MasterPi: (re)start the xiaozhi device client detached and tail its log.
set -u
cd "$HOME/masterpi_client" || { echo "no masterpi_client dir"; exit 1; }
pkill -f "client.py --config" 2>/dev/null
sleep 1
nohup python3 -u client.py --config config.json > client.log 2>&1 < /dev/null &
PID=$!
disown
echo "client started pid=$PID"
sleep 5
echo "----- client.log -----"
cat client.log
