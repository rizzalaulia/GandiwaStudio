import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire('/home/ubuntu/GandiwaStudio/apps/web/node_modules/jsdom/package.json');
const { JSDOM } = require('jsdom');
const load = (file) => new JSDOM(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, url: `https://gandiwa.local/${file}` }).window.document;
const failures = [];
const pass = (name, condition) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); if (!condition) failures.push(name); };
const create = load('index.html');
const prepare = load('prepare.html');
const settings = load('settings.html');

pass('T1 Create owns the shared project-bar reference', Boolean(create.querySelector('.mast + .project-actions')));
pass('T2 Prepare uses the same workspace frame vocabulary as Create', prepare.querySelector('.prepare-desk .workspace-style') && !prepare.querySelector('.legacy-metadata-surface'));
pass('T3 Prepare title and keywords live in a light shared work surface', prepare.querySelector('.metadata-workspace .canvas-bar') && prepare.querySelector('.metadata-workspace .metadata-body'));
pass('T4 Settings removes the dark secondary ledger mast', !settings.querySelector('.settings-mast') && !settings.querySelector('.settings-ledger'));
pass('T5 Settings uses the Create desk frame, not a separate settings theme', settings.querySelector('.settings-desk .side.left') && settings.querySelector('.settings-workspace .canvas-bar'));
pass('T6 Settings keeps the shared footer and project bar', settings.querySelector('.mast + .project-actions') && settings.querySelector('.disclaimer + .footer'));

if (failures.length) { console.error(`\n${failures.length} failures: ${failures.join('; ')}`); process.exit(1); }
console.log('\n6/6 PASS · Prepare and Settings inherit the Create visual language');
