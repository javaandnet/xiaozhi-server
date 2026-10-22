#!/bin/bash
# Probe: does the configured LLM (via aibridge) support native OpenAI tool_calls?
set -eu
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/../.."
node -e '
const c = require("./config.json");
const base = (c.llm.baseUrl||"http://127.0.0.1:3300/v1").replace(/\/$/,"");
const payload = {
  model: c.llm.model,
  messages: [{ role: "user", content: "让机器人点个头" }],
  tools: [{ type: "function", function: {
    name: "robot_arm_pose",
    description: "控制机器人做手臂手势动作，nod=点头",
    parameters: { type: "object", properties: { pose: { type: "string", enum: ["nod","greet","reset"] } }, required: ["pose"] }
  }}],
  tool_choice: "auto",
  stream: false
};
fetch(base + "/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (c.llm.apiKey||"") },
  body: JSON.stringify(payload)
}).then(async r => {
  const t = await r.text();
  console.log("HTTP", r.status);
  try {
    const j = JSON.parse(t);
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    console.log("tool_calls:", JSON.stringify(msg && msg.tool_calls || null));
    console.log("content:", JSON.stringify((msg && msg.content || "").slice(0,200)));
  } catch (e) { console.log("RAW:", t.slice(0,600)); }
}).catch(e => console.log("ERROR:", e.message));
'
