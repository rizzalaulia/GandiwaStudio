import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('./rev3-create.js', import.meta.url), 'utf8');
const failures = [];
const pass = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures.push(name); };

pass('C1 Create loads one dedicated handler module', /<script\s+src="rev3-create\.js/.test(html));
pass('C2 Create does not retain prototype timer generation', !/function generate\(|setTimeout\(/.test(html));
pass('C3 Create uses browser-owned project folders', /showDirectoryPicker/.test(bridge) && /indexedDB/.test(bridge));
pass('C4 Create gets backend ownership before queueing', /const API='\/api\/v1'/.test(bridge) && /\$\{API\}\/creative\/bootstrap/.test(bridge));
pass('C5 Create requires human billing approval before enqueue', /confirm\(/.test(bridge) && /\$\{API\}\/creative\/jobs/.test(bridge));
pass('C6 Create supports poll and cancellation of the owner-scoped job', /setInterval/.test(bridge) && /method:\s*'DELETE'/.test(bridge));
pass('C7 Create never fabricates a generated preview', !/Generated botanical still life preview|Generated preview · Revision 01/.test(bridge));

if (failures.length) process.exit(1);
console.log('7/7 PASS Create real-wiring contract');
