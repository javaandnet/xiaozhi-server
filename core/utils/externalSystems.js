/**
 * External-systems registry compiler.
 *
 * The registry (config.externalSystems) is the single place that登记s which
 * outside controllers talk to us (inbound) and which we talk to (outbound).
 * At startup we compile it into the SAME flat runtime shape consumers already
 * read (config.employee / config.voiceFlow), so nothing downstream changes.
 *
 * Contract invariants preserved:
 *   - compiled output must equal the pre-registry plaintext shape;
 *   - callbackAllowList is a UNION (derived hosts only ADD, never remove);
 *   - the callback URL itself still comes per-session from the controller
 *     (controller-authority): the registry only registers the host for the
 *     SSRF allowlist, it never becomes the source of the callback URL.
 */
import { isKnownCapability, capabilityDirection } from './externalCapabilities.js';

/** Normalize an allowlist entry to {host, origin} for membership checks. */
function entryHosts(entry) {
  const s = String(entry || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) {
    try { const u = new URL(s); return { host: u.hostname, origin: u.origin }; } catch { return null; }
  }
  // bare host or host:port
  const host = s.split(':')[0];
  return { host, origin: s };
}

function isCoveredBy(allowList, host) {
  return allowList.some((e) => {
    const n = entryHosts(e);
    return n && (n.host === host || e.toLowerCase() === host);
  });
}

/**
 * Compile the registry into runtime views. Mutates config in place.
 * @param {object} config - live runtime config (post resolveSharedToken)
 * @param {{warn?:(msg:string)=>void}} [logger]
 */
export function compileExternalSystems(config, logger = console) {
  if (!config) return;
  const systems = config.externalSystems;
  if (!systems || typeof systems !== 'object') return; // no registry: legacy sections stand as-is

  const warn = (m) => (logger.warn ? logger.warn(m) : console.warn(m));
  const enabledSystems = Object.entries(systems).filter(([, s]) => s && s.enabled !== false);

  // ---- validation (warn, never block startup) ----
  for (const [name, s] of Object.entries(systems)) {
    if (!s || typeof s !== 'object') continue;
    for (const cap of s.inbound || []) {
      if (!isKnownCapability(cap)) warn(`[externalSystems] ${name}.inbound references unknown capability "${cap}"`);
      else if (capabilityDirection(cap) !== 'inbound') warn(`[externalSystems] ${name}.inbound "${cap}" is not an inbound capability`);
    }
    for (const [cap, def] of Object.entries(s.outbound || {})) {
      if (!isKnownCapability(cap)) warn(`[externalSystems] ${name}.outbound references unknown capability "${cap}"`);
      else if (capabilityDirection(cap) !== 'outbound') warn(`[externalSystems] ${name}.outbound "${cap}" is not an outbound capability`);
      const needBaseUrl = cap === 'employeeTurn';
      if (s.enabled !== false && needBaseUrl && !s.baseUrl) warn(`[externalSystems] ${name} has outbound "${cap}" but no baseUrl`);
      if (def && typeof def === 'object' && def.token === '$shared') warn(`[externalSystems] ${name}.outbound.${cap}.token still "$shared" (not resolved)`);
    }
  }

  // ---- employee view: the enabled system declaring outbound.employeeTurn ----
  const empSys = enabledSystems.find(([, s]) => s.outbound && s.outbound.employeeTurn);
  if (empSys) {
    const [, s] = empSys;
    const empDef = s.outbound.employeeTurn;
    const fromRegistry = {
      enabled: s.enabled !== false,
      baseUrl: s.baseUrl || '',
      token: empDef.token || s.token || '',
      timeoutMs: empDef.timeoutMs || s.timeoutMs || 90000
    };
    const legacy = config.employee;
    if (legacy && (legacy.baseUrl || legacy.token)) {
      // Conflict policy: an explicit legacy section wins on differing values, with a
      // deprecation warn, so mid-migration deployments are never silently re-routed.
      for (const k of ['baseUrl', 'token', 'timeoutMs']) {
        if (legacy[k] !== undefined && String(legacy[k]) !== String(fromRegistry[k])) {
          warn(`[externalSystems] legacy config.employee.${k} overrides registry value (deprecated; remove the legacy section)`);
          fromRegistry[k] = legacy[k];
        }
      }
      if (legacy.enabled === false) fromRegistry.enabled = false;
    }
    config.employee = fromRegistry;
  }

  // ---- voiceFlow: keep the (resolved) server token; UNION the SSRF allowlist ----
  config.voiceFlow = config.voiceFlow || {};
  const allow = Array.isArray(config.voiceFlow.callbackAllowList) ? [...config.voiceFlow.callbackAllowList] : [];
  for (const [, s] of enabledSystems) {
    const fc = s.outbound && s.outbound.flowCallback;
    if (!fc || !fc.host) continue;
    const host = String(fc.host).toLowerCase();
    if (!isCoveredBy(allow, host)) {
      // derived hosts only ADD (never remove existing entries)
      allow.push(fc.port ? `${host}:${fc.port}` : host);
    }
  }
  config.voiceFlow.callbackAllowList = allow;
}
