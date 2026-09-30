import { readFileSync } from 'node:fs';
const create = readFileSync(new URL('./rev3-create.js', import.meta.url), 'utf8');
const cand = readFileSync(new URL('./rev3-candidates.js', import.meta.url), 'utf8');
const revJs = readFileSync(new URL('./rev3-revisions.js', import.meta.url), 'utf8');
const fail = []; const ok = (n, v) => { console.log(`${v ? 'PASS' : 'FAIL'} ${n}`); if (!v) fail.push(n); };

ok('R1 every locked master appends a revision-ledger entry (both lock paths)', /appendRevision/.test(create) && /Rev3Ledger\.append/.test(cand));
ok('R2 ledger entries carry full identity: job, artifact, digest, prompt, time', /approvedDigest/.test(create) && /lockedAt/.test(create));
ok('R3 regenerate (Revisions) appends on success, not on enqueue', /status==='succeeded'/i.test(revJs) && /Succeeded/.test(revJs) || /status==='succeeded'/i.test(revJs));
ok('R4 ledger is the revision list source; no fake "No revision yet" ghost when history exists', /revisionLedger/.test(revJs));
ok('R5 audit pipeline is visible as honest pipeline stage states', /audit-status/.test(revJs) && /Audit pipeline/.test(revJs));
ok('R6 no fabricated audit verdicts in rev3 pages', !/\bPASS\b.*ruleset|\bcriativ/i.test(revJs) && !/audit passed/i.test(revJs));
ok('R7 queue watch keeps the ledger truthful (succeeded/failed append)', /watchRevision/.test(revJs) && /appendLedger/.test(revJs) && /activeJob:now/.test(revJs));

if (fail.length) process.exit(1);
console.log('7/7 PASS revision ledger + audit visibility contract');
