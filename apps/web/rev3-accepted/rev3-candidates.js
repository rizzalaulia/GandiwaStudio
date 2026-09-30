(() => {
'use strict';
// Candidate gallery (Paku 4, Issue #26): compare, zoom, background, explicit
// master selection. One approved prompt is one candidate per job (num_images
// is always 1 in the backend contract); the gallery therefore never invents
// extra images. It reads ONLY the real job history recorded by rev3-create.js
// in localStorage 'gandiwa-rev3-create-state-v1'. Jobs whose artifact bytes
// are not local are shown as honest placeholders (id + status), never fake
// pixels.
const KEY='gandiwa-rev3-create-state-v1';
const $=s=>document.querySelector(s);
const get=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return{}}};
const put=x=>localStorage.setItem(KEY,JSON.stringify({...get(),...x}));
const STAGES={queued:'Queued',dispatched:'Dispatched',running:'Running',waiting_provider:'Waiting for provider',needs_review:'Needs review',failed:'Failed',cancelled:'Cancelled',succeeded:'Succeeded'};
const stageLabel=s=>STAGES[s]||String(s||'unknown');
const short=id=>String(id||'').slice(0,8);
// Paku 6 (Issue #26): every locked master is a revision-ledger entry with full
// identity, appended by BOTH lock paths so history can never silently fork.
window.Rev3Ledger={append(entry){
 const s=get();const ledger=s.revisionLedger||[];
 ledger.unshift({jobId:entry.jobId,artifact:entry.artifact||null,prompt:entry.prompt||'',contentType:entry.contentType||'',approvedDigest:entry.approvedDigest||null,lockedAt:new Date().toISOString()});
 put({revisionLedger:ledger.slice(0,50),master:{jobId:entry.jobId,artifact:entry.artifact||null,prompt:entry.prompt||'',contentType:entry.contentType||''},masterLockedAt:ledger[0].lockedAt});
 return ledger.length;
}};

function render(){
 const gallery=$('#candidate-gallery');if(!gallery)return;
 const jobs=get().jobHistory||[];
 const empty=$('#gallery-empty'),grid=$('#candidate-grid');
 if(!jobs.length){empty.hidden=false;grid.hidden=true;grid.innerHTML='';}
 else{
  empty.hidden=true;grid.hidden=false;grid.innerHTML='';
  jobs.forEach(job=>{
   const li=document.createElement('li');
   const b=document.createElement('button');
   b.type='button';b.className='candidate';b.dataset.jobId=job.id;
   b.innerHTML=`<span class="c-stage">${stageLabel(job.status)}</span><span class="c-id">Job ${short(job.id)}</span><span class="c-meta">${job.contentType||''}</span>`;
   b.onclick=()=>assignSlot(job.id);
   li.append(b);grid.append(li);
  });
 }
 const master=get().master;
 const sel=$('#master-select');
 if(sel){const current=sel.value;
  sel.innerHTML='<option value="">Choose a candidate</option>'+jobs.map(j=>`<option value="${j.id}"${master&&master.jobId===j.id?' selected':''}>${short(j.id)} · ${stageLabel(j.status)}</option>`).join('');
  if(master&&master.jobId===current)sel.value=current;
 }
 const err=$('#gallery-note');if(err&&!master)err.textContent='';
 $('#gallery-go-prepare').hidden=!(master&&master.artifact);
 if(master&&master.artifact){err.textContent=`Master locked: job ${short(master.jobId)}.`;err.className='hint';}
}

function assignSlot(id){
 const a=$('#compare-a'),b=$('#compare-b');
 if(!a.dataset.job){a.dataset.job=id;a.querySelector('span').textContent=`Slot A: ${short(id)}`;}
 else if(!b.dataset.job||b.dataset.job===a.dataset.job){b.dataset.job=id;b.querySelector('span').textContent=`Slot B: ${short(id)}`;}
 else{a.dataset.job=id;a.querySelector('span').textContent=`Slot A: ${short(id)}`;}
 $('#compare-view').hidden=false;$('#compare-tools').hidden=false;
}

function compare(){
 const stage=$('#compare-stage');
 $('#compare-zoom').oninput=e=>{stage.style.setProperty('--compare-zoom',String(e.target.value/100));$('#compare-zoom-val').textContent=`${e.target.value}%`};
 $('#compare-bg-dark').onchange=e=>stage.classList.toggle('compare-dark',e.target.checked);
}

function lockMaster(e){
 e.preventDefault();
 const err=$('#master-error');err.className='error gallery-err';
 const value=$('#master-select').value;
 if(!value){err.textContent='Choose a candidate before locking a master.';return}
 const job=(get().jobHistory||[]).find(j=>j.id===value);
 if(!job||job.status!=='succeeded'||!job.artifact){err.textContent='A candidate without a succeeded owner-scoped artifact cannot become the master.';return}
 const n=window.Rev3Ledger.append({jobId:job.id,artifact:job.artifact,prompt:job.prompt||'',contentType:job.contentType||'',approvedDigest:job.approvedDigest||null}); err.textContent=`Master locked: revision ${String(n).padStart(2,'0')} from job ${short(job.id)}. Continue to Prepare.`;err.className='hint';
 $('#gallery-go-prepare').hidden=false;
}

function init(){
 if(!$('#candidate-gallery'))return;
 render();compare();
 $('#master-form').onsubmit=lockMaster;
 let signature='';
 const timer=setInterval(()=>{const s=JSON.stringify((get().jobHistory||[]).map(j=>[j.id,j.status]));if(s!==signature){signature=s;render()}},2000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)render()});
 window.addEventListener('beforeunload',()=>clearInterval(timer));
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
