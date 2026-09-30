import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

function loadBrowserCanonical() {
  const source = readFileSync(new URL('./rev3-canonical.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    TextEncoder,
    crypto: webcrypto,
    module,
  });
  return module.exports;
}
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const revisionsHtml = readFileSync(new URL('./revisions.html', import.meta.url), 'utf8');
const createJs = readFileSync(new URL('./rev3-create.js', import.meta.url), 'utf8');
const revisionsJs = readFileSync(new URL('./rev3-revisions.js', import.meta.url), 'utf8');

const failures = [];
const pass = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures.push(name); };

let canonical = null;
try { canonical = loadBrowserCanonical(); } catch { canonical = null; }

// Values chosen to mirror the frozen backend probe vector exactly; key order is
// deliberately shuffled because canonical serialization must not care.
const spec = {
  orientation: 'landscape',
  target_height: 3072,
  model_id: 'fal-ai/flux/schnell',
  negative_prompt_text: 'logo, watermark, brand name, random text, fake interface, malformed anatomy',
  stock_constraints: {
    negative_space_decision: 'none required',
    no_copyrighted_property: true,
    no_fake_ui: true,
    no_malformed_anatomy: true,
    no_logo: true,
    no_random_text: true,
    no_unintentional_crop: true,
    no_watermark: true,
    no_brand: true,
  },
  aspect_ratio: '4:3',
  content_type: 'photo',
  creation_method: 'generative_ai',
  prompt_text: 'Editorial ceramic coffee mug on warm linen, soft window light, 4096x3072',
  provider_id: 'fal',
  target_width: 4096,
};

// Truth minted by the backend: gandiwa_api.creative.approval.current_prompt_digest
// over the equivalent PromptSnapshot (json.dumps sort_keys + compact separators).
const BACKEND_DIGEST_VECTOR = '1b6a28015e6d450c95b8b9f505e68b96055f0538b513b73d80baaca994eac558';

pass('H1 shared canonical approval-digest module exists', typeof canonical?.approvalDigest === 'function');

let digestMatchesBackend = false;
if (canonical) {
  const hex = await canonical.approvalDigest(spec);
  digestMatchesBackend = hex === BACKEND_DIGEST_VECTOR;
}
pass('H2 canonical browser digest equals the backend digest vector', digestMatchesBackend);

pass('H3 Create hashes the canonical snapshot, not raw JSON.stringify', /Rev3Canonical\.approvalDigest/.test(createJs) && !/JSON\.stringify\(promptSpec\)/.test(createJs));
pass('H4 Revisions hashes the canonical prompt snapshot, not the wrapper object', /Rev3Canonical\.approvalDigest/.test(revisionsJs) && !/hash\(JSON\.stringify\(p\)\)/.test(revisionsJs));
pass('H5 Create and Revisions pages load the canonical module first', /<script src="rev3-canonical\.js/.test(html) && /<script src="rev3-canonical\.js/.test(revisionsHtml));

if (failures.length) process.exit(1);
console.log('5/5 PASS approval-digest canonical contract');
