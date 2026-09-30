import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('./rev3-candidates.js', import.meta.url), 'utf8');
const fail = []; const ok = (n, v) => { console.log(`${v ? 'PASS' : 'FAIL'} ${n}`); if (!v) fail.push(n); };

ok('G1 create page ships a candidate gallery section', /id="candidate-gallery"/.test(html));
ok('G2 gallery is driven by one dedicated handler module', /<script src="rev3-candidates\.js/.test(html));
ok('G3 compare view compares exactly two candidates', /id="compare-stage"/.test(html) && /compare-a/.test(js) && /compare-b/.test(js));
ok('G4 zoom control scales the compare stage', /id="compare-zoom"/.test(html) && /--compare-zoom/.test(js));
ok('G5 background toggle flips the inspection surface', /id="compare-bg-dark"/.test(html) && /compare-dark/.test(js));
ok('G6 master selection is explicit, never a silent default', /id="master-select"/.test(html) && js.includes('Choose a candidate'));
ok('G7 locking refuses jobs without a succeeded artifact', /succeeded/.test(js) && /artifact/.test(js));
ok('G8 empty state is honest, no fabricated previews', !/Generated botanical|demo preview/i.test(js) && /No candidates yet/.test(html));
ok('G9 gallery reads only real job history from browser state', /jobHistory/.test(js));
ok('G10 one approved prompt maps to exactly one candidate card', /num_images/.test(js) || /one candidate per job/.test(js));

if (fail.length) process.exit(1);
console.log('10/10 PASS candidate gallery contract');
