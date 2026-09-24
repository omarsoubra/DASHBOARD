const CLIENTS=process.env.CLIENTS_DIR||'clients';
const fs=require('fs');
const {transplant,index,unitSha,UNITS,sha}=require('./transplant.js');
const REF='salman_abdallah';
const ref=index(`${CLIENTS}/${REF}/index.html`);
const {IIFE}=require('./transplant.js');
const refShas={}; for(const u of Object.keys(IIFE)) refShas[u]=sha(ref.iifes[u].text)+':'+ref.iifes[u].bytes;
for(const u of Object.keys(UNITS)) refShas[u]=unitSha(ref,u);
// variants observed across the fleet that we accept as known inputs
const allowed={
  ENGINE:['20e324f35dd3:67843', refShas.ENGINE],
  RESTORE:['a4724c95952a:4774', refShas.RESTORE],
  TRACK_A:['PART:0d32c1aad9e4','ABSENT',refShas.TRACK_A],
  WORKOUT_IO:['0f21926ea5f6','e35b55011d51',refShas.WORKOUT_IO],
  FIND_LOAD:['ABSENT',refShas.FIND_LOAD],
  PERF_REF:['ABSENT',refShas.PERF_REF],
  B5:['ABSENT',refShas.B5],
};
console.log('REFERENCE',REF,JSON.stringify(refShas));
const KEYS=fs.readFileSync(process.env.KEYS_FILE||'migrate_keys.txt','utf8').trim().split(/\s+/);
const ST={}; for(const l of fs.readFileSync(process.env.STATUS_FILE||'client_status.txt','utf8').trim().split('\n')){const p=l.split('|');ST[p[0]]=p[1];}
const ACTIVE=KEYS.filter(k=>ST[k]==='active');
fs.mkdirSync('out',{recursive:true});
const audits=[]; let ok=0,unchanged=0,refused=0;
for(const k of ACTIVE){
  let r; try{ r=transplant(k,ref,refShas,allowed); }
  catch(e){ r={audit:{client:k,refusals:['exception: '+e.message]},html:null}; }
  audits.push(r.audit);
  if(r.html && !r.unchanged){ fs.writeFileSync(`out/${k}.html`,r.html); ok++; }
  else if(r.unchanged){ unchanged++; }
  else { refused++; }
}
fs.writeFileSync('transplant_audit.json',JSON.stringify(audits,null,1));
console.log(`\nACTIVE CLIENTS: ${ACTIVE.length}   migrated=${ok}  already-current=${unchanged}  REFUSED=${refused}`);
console.log('\n--- refusals ---');
for(const a of audits) if(a.refusals&&a.refusals.length) console.log(`  ${a.client}: ${a.refusals.join(' | ')}`);
