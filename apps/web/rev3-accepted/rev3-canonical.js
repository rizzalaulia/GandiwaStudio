(() => {
'use strict';
// Canonical approval digest (Paku 1): the browser must hash the exact same
// material the backend hashes in gandiwa_api.creative.approval: a sorted-key,
// compact JSON dump of the prompt snapshot model dump. UMD-style so the same
// file serves the classic <script src> pages and the Node contract test.
const enc = new TextEncoder();

function canonicalJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  if (Object.keys(value).length === 0) return '{}';
  return '{' + Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',') + '}';
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function exported() {
  return { canonicalJson, sha256Hex, approvalDigest: async o => sha256Hex(canonicalJson(o)) };
}

if (typeof window !== 'undefined') window.Rev3Canonical = exported();
if (typeof module !== 'undefined' && module.exports) module.exports = exported();
})();
