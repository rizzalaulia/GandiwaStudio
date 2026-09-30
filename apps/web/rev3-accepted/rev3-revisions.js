(() => {
'use strict';
const API='/api/v1',KEY='gandiwa-rev3-create-state-v1',$=s=>document.querySelector(s);
const get=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return{}}};
const put=x=>localStorage.setItem(KEY,JSON.stringify({...get(),...x}));
const say=(m,k='')=>{const n=$('#revision-status');if(n)n.textContent=m,n.className=`notice ${k}`};
const STAGES={queued:'Queued',dispatched:'Dispatched',running:'Running',waiting_provider:'Waiting for provider',needs_review:'Needs review',failed:'Failed',cancelled:'Cancelled',succeeded:'Succeeded'};
// Paku 6: revisions keep the same revision ledger identity as Create's lock
// paths (idempotent per job) and append ONLY on a succeeded result, never at
// enqueue, so history cannot contain jobs that never produced an artifact.
function appendLedger(entry){const s=get();const ledger=s.revisionLedger||[];if(ledger.some(x=>x.jobId===entry.jobId))return ledger.length;ledger.unshift({jobId:entry.jobId,artifact:entry.artifact||null,prompt:entry.prompt||'',contentType:entry.contentType||'',approvedDigest:entry.approvedDigest||null,lockedAt:new Date().toISOString()});put({revisionLedger:ledger.slice(0,50)});return ledger.length}
function auditLine(status){const map={queued:'Audit pipeline: queued; checkpoint audit has not started.',dispatched:'Audit pipeline: dispatched to the provider connector.',running:'Audit pipeline: running; no verdict exists yet.',waiting_provider:'Audit pipeline: waiting for the provider; no verdict exists yet.',needs_review:'Audit pipeline: human review required before any further dispatch.',failed:'Audit pipeline: job ended failed; preserved in history.',cancelled:'Audit pipeline: ended by cancellation request.',succeeded:'Audit pipeline: artifact ready; awaiting checkpoint audit in Prepare.'};return map[status]||'Audit pipeline: unknown stage.'}
function renderAudit(){$('#audit-status')&&($('#audit-status').textContent=auditLine(get().activeJob?.status))}
function watchRevision(job){
 const timer=setInterval(async()=>{try{
  const r=await fetch(`${API}/creative/jobs/${encodeURIComponent(job.id)}`,{credentials:'same-origin'}),now=await json(r);
  if(!r.ok)throw Error(now.detail||'Revision status unavailable.');
  put({activeJob:now});render();renderAudit();
  if(['queued','dispatched','running','waiting_provider'].includes(now.status))return;
  clearInterval(timer);
  if(now.status==='succeeded'&&now.artifact){const n=appendLedger({jobId:now.id,artifact:now.artifact,prompt:get().master?.prompt||'',contentType:get().master?.contentType||'',approvedDigest:now.approvedDigest||null});say(`Revision ${String(n).padStart(2,'0')} recorded from job ${now.id.slice(0,8)}.`,'ready')}
  else if(now.status==='succeeded')say('The job ended succeeded without an artifact; nothing entered the revision ledger.','error')
  else say(`${STAGES[now.status]||now.status}. ${auditLine(now.status)}`,now.status==='failed'?'error':'');
  render();renderAudit();
 }catch(e){clearInterval(timer);say(e.message||'Revision monitor stopped.','error')}},1500);
}
const json=async r=>{const t=await r.text();try{return t?JSON.parse(t):{}}catch{return{detail:t}}};
async function csrf(){const r=await fetch(`${API}/auth/csrf`,{credentials:'same-origin'}),b=await json(r);if(!r.ok)throw Error('Security token unavailable.');return b.csrf_token}
async function hash(s){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function render(){const s=get(), list=$('#revision-list');if(!list)return;list.innerHTML='';const rows=[];
 // Paku 6: the revision ledger is the source of truth for visible history;
 // roles/audit states come from real job state, never fabricated verdicts.
 const AUDIT_HINT={succeeded:'Audit pipeline: awaiting checkpoint audit (no verdict fabricated here)',needs_review:'Audit pipeline: human review required before any further dispatch',failed:'Audit pipeline: reached failed state; preserved in history',cancelled:'Audit pipeline: ended by cancellation request'};
 (s.revisionLedger||[]).forEach((entry,i)=>{rows.push({label:`Revision ${String(i+1).padStart(2,'0')} \u00b7 job ${entry.jobId?entry.jobId.slice(0,8):'?'}`,detail:`Artifact ${entry.artifact?.id||'pending'} \u00b7 locked ${entry.lockedAt}${entry.approvedDigest?` \u00b7 digest ${entry.approvedDigest.slice(0,12)}`:''}`});});
 const live=(s.activeJob)&&!(s.revisionLedger||[]).some(x=>x.jobId===s.activeJob.id);
 if(live)rows.unshift({label:`Latest job: ${s.activeJob.status}`,detail:`${s.activeJob.id}${AUDIT_HINT[s.activeJob.status]?` \u00b7 ${AUDIT_HINT[s.activeJob.status]}`:''}`});
 if(!rows.length)rows.push({label:'No revision yet',detail:'Create and lock a master first.'});
 rows.forEach((r,i)=>{const a=document.createElement('article');a.className='revision';a.innerHTML=`<span class="num">${String(i+1).padStart(2,'0')}</span><div><strong>${r.label}</strong><p>${r.detail}</p></div>`;list.append(a)});}
async function revision(e){e.preventDefault();const reason=$('#revision-reason').value.trim(),s=get();if(!s.master?.prompt){say('Lock a master in Create before making a revision.','error');return}if(reason.length<12){say('Describe a meaningful visual change in at least 12 characters.','error');return}if(reason===s.lastRevisionReason){say('This is the same revision reason. Change the prompt meaningfully first.','error');return}if(!confirm('Approve one new fal.ai revision job? This can use provider credit.')){say('No revision job was created.');return}const revisionPrompt={prompt_text:`${s.master.prompt}\nRevision instruction: ${reason}`,negative_prompt_text:'logo, watermark, random text',content_type:s.master.contentType||'photo',creation_method:'generative_ai',provider_id:'fal',model_id:s.model||'fal-ai/flux/schnell',target_width:4096,target_height:3072,aspect_ratio:'4:3',orientation:'landscape',stock_constraints:{no_logo:true,no_brand:true,no_watermark:true,no_random_text:true,no_fake_ui:true,no_unintentional_crop:true,no_malformed_anatomy:true,no_copyrighted_property:true,negative_space_decision:'none'}};const digest=await Rev3Canonical.approvalDigest(revisionPrompt);const payload={session:{topic:s.projectName||'Local project',prompt:revisionPrompt,human_prompt_approval:true,approved_prompt_digest:digest,creative_approvals:[{stage:'revision',human:'Master Peng',approved_at:new Date().toISOString(),prompt_digest:digest}],revisions:[]},rules_snapshot:{id:'adobe-stock-2026-09-08-v1',version:'adobe-stock-2026-09-08-v1'},idempotency_key:`revision-${crypto.randomUUID()}-${digest.slice(0,16)}`};try{await fetch(`${API}/creative/bootstrap`,{credentials:'same-origin'});const r=await fetch(`${API}/creative/jobs`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':await csrf()},body:JSON.stringify(payload)}),j=await json(r);if(!r.ok)throw Error(j.detail||'Revision queue rejected.');put({activeJob:j,lastRevisionReason:reason});say(`Revision job ${j.id} queued. Return to Create to monitor it.`,'ready');render()}catch(x){say(x.message,'error')}}
function init(){render();renderAudit();const f=$('#revision-form');if(f)f.onsubmit=revision;const s=get();if(s.activeJob&&['queued','dispatched','running','waiting_provider'].includes(s.activeJob.status))watchRevision(s.activeJob)}document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
