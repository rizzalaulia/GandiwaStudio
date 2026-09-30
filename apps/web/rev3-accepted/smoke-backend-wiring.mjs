import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('/home/ubuntu/GandiwaStudio/apps/web/node_modules/jsdom/package.json');
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('./settings.html', import.meta.url), 'utf8');
const dom = new JSDOM(source, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://gandiwa.local/settings.html',
  beforeParse(window) {
    window.fetch = async () => new window.Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

const document = dom.window.document;
const failures = [];
const pass = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures.push(name);
};

pass('B1 rev3 settings loads a dedicated backend integration module', /<script\s+src="rev3-api\.js/.test(source));
pass('B2 backend module uses provider-state endpoint', /\/api\/v1\/settings\/providers/.test(readFileSync(new URL('./rev3-api.js', import.meta.url), 'utf8')));
pass('B3 backend module uses non-billing validation endpoint', /\/validate/.test(readFileSync(new URL('./rev3-api.js', import.meta.url), 'utf8')));
pass('B4 rev3 never enqueues a creative generation job without explicit approval', !/\/api\/v1\/creative\/jobs/.test(readFileSync(new URL('./rev3-api.js', import.meta.url), 'utf8')));

if (failures.length) process.exit(1);
console.log('4/4 PASS backend wiring contract');
