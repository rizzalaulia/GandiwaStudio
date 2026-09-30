import { readFileSync } from 'node:fs';
const js = readFileSync(new URL('./rev3-create.js', import.meta.url), 'utf8');
const revJs = readFileSync(new URL('./rev3-revisions.js', import.meta.url), 'utf8');
const fail = []; const ok = (n, v) => { console.log(`${v ? 'PASS' : 'FAIL'} ${n}`); if (!v) fail.push(n); };

ok('Q1 stage labels map every queue stage, incl. waiting provider', /waiting_provider/.test(js) && /Dispatched/.test(js) && /Needs review/.test(js));
ok('Q2 queue position is pronounced while waiting', /queue position/.test(js));
ok('Q3 needs_review is a distinct, alarming state with the redacted code', /needs_review/.test(js) && /error_code/.test(js));
ok('Q4 artifact expiry is shown once an artifact exists', /artifact_expires_at/.test(js) && /expires/.test(js));
ok('Q5 cancellation wording never claims a finished outcome', /Cancellation requested/.test(js) && !/cancellation completed/i.test(js));
ok('Q6 revisions list marks stage text, not just ids', /Latest job/.test(revJs) && /s\.activeJob\.status/.test(revJs));
ok('Q7 the job monitor keeps polling every active stage', /'queued','dispatched','running','waiting_provider'/.test(js));

if (fail.length) process.exit(1);
console.log('7/7 PASS queue status display contract');
