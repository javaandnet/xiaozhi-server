#!/bin/bash
# Dev helper: fire a device-MCP tool through xiaozhi-server via the dev-only
# /api/mcp/call-tool endpoint (bypasses the mock LLM). Reads the voiceFlow token
# from config.json for auth. Usage: trigger_tool.sh <tool_name> [json_args]
set -eu
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/../.."
TOOL="${1:-robot_arm_pose}"
ARGS="${2:-}"
if [ -z "$ARGS" ]; then ARGS='{"pose":"nod"}'; fi
TOKEN="$(node -e 'const c=require("./config.json");const t=c.voiceFlow&&c.voiceFlow.token;process.stdout.write(t==="$shared"?(c.sharedToken||""):(t||""))')"
echo "[trigger] tool=$TOOL args=$ARGS"
curl -sS -X POST http://127.0.0.1:8003/api/mcp/call-tool \
  -H "Content-Type: application/json" \
  -H "X-Xiaozhi-Key: $TOKEN" \
  -d "{\"tool\":\"$TOOL\",\"args\":$ARGS}"
echo ""
