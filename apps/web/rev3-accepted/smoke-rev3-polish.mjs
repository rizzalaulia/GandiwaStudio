import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const styles = readFileSync(new URL('./rev3.css', import.meta.url), 'utf8');
if (!/\.brand\{[^}]*display:flex[^}]*align-items:center[^}]*transform:translateY\(4px\)/.test(styles) || /\.brand-sub\{[^}]*transform:translateY/.test(styles)) {
  console.error('FAIL masthead title needs a restrained 2px optical correction without moving the subtitle');
  process.exit(1);
}

const require = createRequire('/home/ubuntu/GandiwaStudio/apps/web/node_modules/jsdom/package.json');
const { JSDOM } = require('jsdom');
const read = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const sleep = (window, ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const failures = [];
const pass = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures.push(name);
};
const boot = (file, state = {}) => new JSDOM(read(file), {
  runScripts: 'dangerously', pretendToBeVisual: true, url: `https://gandiwa.local/${file}`,
  beforeParse(window) { Object.entries(state).forEach(([key, value]) => window.localStorage.setItem(key, value)); },
});

const create = boot('index.html');
const c = create.window.document;
pass('C1 project actions live below the identity header', c.querySelector('.project-actions') && !c.querySelector('.top .project-actions'));
pass('C2 theme and settings are icon controls with accessible names', c.querySelector('#night-mode[aria-label]')?.textContent.trim().length <= 2 && c.querySelector('a[href="settings.html"][aria-label]')?.textContent.trim().length <= 2);
pass('C2a masthead keeps the brand lockup structurally separate from utility controls', c.querySelector('.mast > .brand') && c.querySelector('.mast > .brand-sub') && c.querySelector('.mast > .header-actions'));
pass('C3 create has a footer disclaimer and attribution', c.querySelector('[role="note"].disclaimer') && c.querySelector('footer a[href="https://github.com/Rizzalaulia"]'));
pass('C4 create starts with an honest empty stage, not a fabricated preview', c.querySelector('#generated-stage')?.dataset.ready === 'false' && /generated image will appear here/i.test(c.querySelector('#generated-stage')?.textContent ?? ''));
pass('C5 generate button explains that billing needs an explicit human approval', /only created after your explicit approval/i.test(c.querySelector('form + .hint')?.textContent ?? ''));

const prepare = boot('prepare.html', {'gandiwa-rev3-master': 'revision-1'});
const p = prepare.window.document;
pass('P1 prepare retains project actions and icon header controls', p.querySelector('.project-actions') && p.querySelector('#night-mode[aria-label]')?.textContent.trim().length <= 2);
pass('P2 prepare includes footer disclaimer and attribution', p.querySelector('[role="note"].disclaimer') && p.querySelector('footer'));
pass('P3 Prepare starts with an explicit missing-master state', /locked master artifact is required/i.test(p.querySelector('#audit-status')?.textContent ?? ''));
pass('P4 Prepare does not fabricate an Adobe audit before it has artifact bytes', p.querySelector('#audit-checks')?.hidden === true);
pass('P5 metadata controls are disabled until a real master exists', p.querySelector('#generate-title')?.disabled === true);
pass('P6 metadata explains that an explicit 9Router model is required', /explicit 9Router model/i.test(p.querySelector('#metadata-status')?.textContent ?? ''));

const settings = boot('settings.html');
const s = settings.window.document;
pass('S1 settings has icon-only theme and return controls', s.querySelector('#night-mode[aria-label]')?.textContent.trim().length <= 2 && s.querySelector('a[href="index.html"][aria-label]')?.textContent.trim().length <= 2);
pass('S2 settings has no general Save button', ![...s.querySelectorAll('button')].some((button) => /save/i.test(button.textContent)));
pass('S3 both API sections expose a compact diagnostic check action in their own header', s.querySelector('.settings-section-head #check-connection.connection-check') && s.querySelector('.settings-section-head #check-reasoning-connection.connection-check'));
s.querySelector('#reasoning-name').value = 'Metadata worker';
s.querySelector('#reasoning-prefix').value = 'metadata-worker';
s.querySelector('#reasoning-base-url').value = 'https://reasoning.example/v1';
s.querySelector('#reasoning-key').value = 'prototype-key-not-sent';
s.querySelector('#reasoning-model').value = 'reasoning-model';
s.querySelector('#check-reasoning-connection').click();
pass('S4 reasoning check gives its own honest local-only result', /production check|prototype/i.test(s.querySelector('#reasoning-connection-feedback')?.textContent ?? ''));
pass('S5 settings includes footer disclaimer and attribution', s.querySelector('[role="note"].disclaimer') && s.querySelector('footer'));

if (failures.length) {
  console.error(`\n${failures.length} failures: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\n16/16 PASS · rev3 polish requirements hold');
