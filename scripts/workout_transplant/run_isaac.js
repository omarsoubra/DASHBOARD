const fs=require('fs');
const {transplant,index,unitSha,UNITS,IIFE,sha}=require('./transplant.js');
const CLIENTS=process.env.CLIENTS_DIR||'clients';
const REF='salman_abdallah';
const ref=index(`${CLIENTS}/${REF}/index.html`);
const refShas={}; for(const u of Object.keys(IIFE)) refShas[u]=sha(ref.iifes[u].text)+':'+ref.iifes[u].bytes;
for(const u of Object.keys(UNITS)) refShas[u]=unitSha(ref,u);
const allowed={
  ENGINE:['20e324f35dd3:67843', refShas.ENGINE],
  ENGINE_PRE:['cb8d6fb4814b:39162'],
  RESTORE:['a4724c95952a:4774', refShas.RESTORE],
  TRACK_A:['PART:0d32c1aad9e4','ABSENT',refShas.TRACK_A],
  WORKOUT_IO:['0f21926ea5f6','e35b55011d51',refShas.WORKOUT_IO],
  FIND_LOAD:['ABSENT',refShas.FIND_LOAD],
  PERF_REF:['ABSENT',refShas.PERF_REF],
  B5:['ABSENT',refShas.B5],
};
console.log('REF SHAS',JSON.stringify(refShas));
const r=transplant('isaac_alameddine',ref,refShas,allowed);
console.log(JSON.stringify(r.audit,null,1));
if(r.html){ fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/isaac_alameddine.html',r.html); console.log('WROTE out/isaac_alameddine.html',r.html.length); }
else console.log('REFUSED');
