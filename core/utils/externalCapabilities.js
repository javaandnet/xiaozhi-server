/**
 * External-system capability registry (closed enum).
 *
 * A "capability" is one concrete integration channel between xiaozhi-server and
 * an outside controller (aistudy / aiinterview / ...). The registry keys are a
 * CLOSED set on purpose: registering a new external system may only reference
 * these keys, so the config cannot silently invent endpoint groups. Adding a
 * capability is a code change here + its route wiring, not a config edit.
 */

/** Inbound: outside system calls INTO xiaozhi-server. */
export const INBOUND_CAPABILITIES = {
  // /api/voice/speak|session|session/close|devices  (X-Xiaozhi-Key)
  voiceFlow: { direction: 'inbound', auth: 'X-Xiaozhi-Key' },
  // /api/mcp/call-tool  (X-Xiaozhi-Key, conditionally registered when a token is set)
  mcpCallTool: { direction: 'inbound', auth: 'X-Xiaozhi-Key' },
  // /api/broadcast + /api/wake  (currently unauthenticated LAN/proxy control)
  broadcast: { direction: 'inbound', auth: 'none' }
};

/** Outbound: xiaozhi-server calls the outside system. */
export const OUTBOUND_CAPABILITIES = {
  // POST <baseUrl>/api/xiaozhi/employee-turn  (employee/digital-staff mode bridge)
  employeeTurn: { direction: 'outbound', auth: 'X-Xiaozhi-Key' },
  // POST <callbackUrl> aggregated transcript (host only登记 here; the URL itself
  // stays supplied per-session by the controller - controller-authority invariant)
  flowCallback: { direction: 'outbound', auth: 'X-Xiaozhi-Key' }
};

export const ALL_CAPABILITIES = { ...INBOUND_CAPABILITIES, ...OUTBOUND_CAPABILITIES };

/** True when capKey is a known capability. */
export function isKnownCapability(capKey) {
  return Object.prototype.hasOwnProperty.call(ALL_CAPABILITIES, capKey);
}

/** Direction of a capability: 'inbound' | 'outbound' | null. */
export function capabilityDirection(capKey) {
  return ALL_CAPABILITIES[capKey] ? ALL_CAPABILITIES[capKey].direction : null;
}
