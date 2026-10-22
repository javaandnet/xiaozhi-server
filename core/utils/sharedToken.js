/**
 * Shared-token resolution.
 *
 * Goal: define the cross-system secret once at config.json top level
 * (`sharedToken`) and let `employee.token` / `voiceFlow.token` reference it
 * via the reserved literal "$shared", eliminating the two-copies-must-match
 * footgun. Resolution happens once at startup, in memory, and writes the
 * resolved plaintext back into the SAME flat shape consumers already read
 * (config.employee.token / config.voiceFlow.token), so no consumer changes.
 *
 * Value forms for any token reference point:
 *   "$shared"          -> the resolved top-level sharedToken
 *   "env:VAR_NAME"     -> process.env.VAR_NAME (secret kept out of the file)
 *   "<literal>"        -> used as-is (backward compat with existing configs)
 */

const REF = '$shared';

/** Resolve a possibly-ref token value against the shared secret. */
function resolveValue(val, shared) {
  if (val === REF) return shared;
  if (typeof val === 'string' && val.startsWith('env:')) {
    return process.env[val.slice(4)] || '';
  }
  return val;
}

/**
 * Resolve all "$shared" / "env:" references in-place on the live config.
 * Missing shared with a "$shared" reference => drop the token (consumer's own
 * "not configured" path then applies, e.g. voiceFlow endpoints return 503).
 * @param {object} config - the live runtime config object (mutated)
 * @returns {boolean} true when at least one reference was resolved
 */
export function resolveSharedToken(config) {
  if (!config) return false;
  const shared = typeof config.sharedToken === 'string' && config.sharedToken.startsWith('env:')
    ? (process.env[config.sharedToken.slice(4)] || '')
    : (config.sharedToken || '');

  let resolvedAny = false;
  const points = [
    ['employee', config.employee],
    ['voiceFlow', config.voiceFlow]
  ];
  for (const [name, section] of points) {
    if (!section || section.token === undefined) continue;
    if (section.token === REF || (typeof section.token === 'string' && section.token.startsWith('env:'))) {
      const value = resolveValue(section.token, shared);
      if (!value) {
        console.warn(`[sharedToken] ${name}.token references "${section.token}" but sharedToken is empty; treating ${name} as not configured`);
        delete section.token;
      } else {
        section.token = value;
      }
      resolvedAny = true;
    }
  }

  // Registry entries may also reference "$shared" / "env:" at the system level
  // or on individual outbound capabilities. Dereference them here so the
  // compile step only ever sees plaintext (or an empty = not-configured).
  const systems = config.externalSystems;
  if (systems && typeof systems === 'object') {
    for (const [name, sys] of Object.entries(systems)) {
      if (!sys || typeof sys !== 'object') continue;
      if (sys.token === REF || (typeof sys.token === 'string' && sys.token.startsWith('env:'))) {
        sys.token = resolveValue(sys.token, shared) || '';
        if (!sys.token) console.warn(`[sharedToken] externalSystems.${name}.token references "${REF}" but sharedToken is empty`);
        resolvedAny = true;
      }
      const ob = sys.outbound;
      if (ob && typeof ob === 'object') {
        for (const cap of Object.values(ob)) {
          if (cap && (cap.token === REF || (typeof cap.token === 'string' && cap.token.startsWith('env:')))) {
            cap.token = resolveValue(cap.token, shared) || sys.token || '';
            resolvedAny = true;
          }
        }
      }
    }
  }
  return resolvedAny;
}
