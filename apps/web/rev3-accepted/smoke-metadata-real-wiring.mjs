import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('./metadata.html',import.meta.url),'utf8');
const js=readFileSync(new URL('./rev3-metadata.js',import.meta.url),'utf8');
const failed=[];const ok=(n,v)=>{console.log(`${v?'PASS':'FAIL'} ${n}`);if(!v)failed.push(n)};
ok('M1 metadata has one real handler and no demo script',/<script src="rev3-metadata\.js/.test(html)&&!/Botanical still life with sculptural vase/.test(html));
ok('M2 metadata requires a real locked master artifact',/m\?\.artifact/.test(js)&&/artifact_id:m\.artifact\.id/.test(js));
ok('M3 suggestion calls the schema-validated endpoint',/creative\/assistant\/metadata/.test(js));
ok('M4 saving requires human review',/metadata-reviewed/.test(js)&&/human_confirmed/.test(js));
if(failed.length)process.exit(1);console.log('4/4 PASS metadata real-wiring');
