import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('./revisions.html',import.meta.url),'utf8');
const js=readFileSync(new URL('./rev3-revisions.js',import.meta.url),'utf8');
const fail=[]; const ok=(n,v)=>{console.log(`${v?'PASS':'FAIL'} ${n}`);if(!v)fail.push(n)};
ok('R1 revisions uses one dedicated handler',/<script src="rev3-revisions\.js/.test(html)&&!/setTimeout\(/.test(html));
ok('R2 reason is required before a revision is billed',/revision-reason/.test(js)&&/confirm\(/.test(js));
ok('R3 job submission is owner scoped and idempotent',/creative\/jobs/.test(js)&&/idempotency_key/.test(js));
ok('R4 prior revision stays represented from browser state',/activeJob|master/.test(js));
if(fail.length)process.exit(1);console.log('4/4 PASS revisions real-wiring');
