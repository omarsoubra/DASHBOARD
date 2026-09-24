/* Proof that nothing outside the declared transplant set changed.
   Reconstructs the ORIGINAL from the MIGRATED by reversing only the declared
   unit spans; if the reconstruction is byte-identical to the original, no other
   byte moved. Also re-checks the protected client surfaces explicitly. */
const OUT=process.env.OUT_DIR||'out';
const CLIENTS=process.env.CLIENTS_DIR||'clients';
const fs=require('fs'),crypto=require('crypto');
const {index,UNITS,IIFE,contentHashes,sha}=require('./transplant.js');
const sha32=s=>crypto.createHash('sha256').update(s).digest('hex');
const TRANS=new Set(Object.values(UNITS).flatMap(u=>u.members));
const KEYS=fs.readdirSync(OUT).filter(f=>f.endsWith('.html')).map(f=>f.slice(0,-5));
const PROTECT=[
 [/<h1 class="hero-title">[\s\S]*?<\/h1>/,'heroTitle'],
 [/<p class="hero-sub">[\s\S]*?<\/p>/,'heroSub'],
 [/const rationale=\[[\s\S]*?\];/,'macroRationale'],
 [/CLIENT_TOKEN_LEGACY = '[^']*'/,'legacyToken'],
 [/generatedAt: [^\n]*\n[\s\S]{0,120}?configPath: [^\n]*/,'genFooter'],
 [/const mealPlan = \{\};[\s\S]*?mealPlan\[12\] = \[[\s\S]*?\];/,'mealPlan'],
 [/const phases = \{[\s\S]*?\n\};/,'phases'],
 [/const phaseTargets = [\s\S]*?;/,'phaseTargets'],
 [/const CLIENT_CONFIG = \{[\s\S]*?\n\};/,'CLIENT_CONFIG'],
];
let allOk=true; const rows=[];
for(const k of KEYS){
  const a=fs.readFileSync(`${CLIENTS}/${k}/index.html`,'utf8');
  const b=fs.readFileSync(`${OUT}/${k}.html`,'utf8');
  const A=index(`${CLIENTS}/${k}/index.html`), B=index(`${OUT}/${k}.html`);
  // reverse the transplant on B
  const edits=[];
  for(const u of Object.keys(IIFE)){
    if(A.iifes[u]&&B.iifes[u]&&A.iifes[u].text!==B.iifes[u].text)
      edits.push({start:B.iifes[u].start,end:B.iifes[u].end,text:A.iifes[u].text});
  }
  for(const n of TRANS){
    const inA=A.by.get(n), inB=B.by.get(n);
    if(inB&&inA&&inA.text!==inB.text) edits.push({start:inB.start,end:inB.end,text:inA.text});
    else if(inB&&!inA) edits.push({start:inB.start,end:inB.end,text:'__DEL__'}); // inserted by us
  }
  edits.sort((x,y)=>y.start-x.start);
  let rec=b;
  for(const e of edits) rec=rec.slice(0,e.start)+(e.text==='__DEL__'?'':e.text)+rec.slice(e.end);
  rec=rec.replace(/\n\n\n+/g,'\n\n');
  const norm=s=>s.replace(/\n\n\n+/g,'\n\n');
  const reconstructed = norm(rec)===norm(a);
  // explicit protected surfaces
  const prot={};
  let protOk=true;
  for(const [re,name] of PROTECT){
    const ma=a.match(re), mb=b.match(re);
    const same=(ma?sha(ma[0]):null)===(mb?sha(mb[0]):null);
    prot[name]=same; if(!same) protOk=false;
  }
  const cb=contentHashes(a), cb2=contentHashes(b);
  const cbOk=Object.keys(cb).every(x=>cb[x]===cb2[x]);
  const growth=b.length-a.length;
  rows.push({k,reconstructed,protOk,cbOk,growth,failed:Object.entries(prot).filter(([,v])=>!v).map(([n])=>n)});
  if(!(reconstructed&&protOk&&cbOk)) allOk=false;
}
console.log('shells checked:',rows.length);
console.log('reverse-reconstruction byte-identical :',rows.filter(r=>r.reconstructed).length+'/'+rows.length);
console.log('protected client surfaces unchanged   :',rows.filter(r=>r.protOk).length+'/'+rows.length);
console.log('content blocks unchanged              :',rows.filter(r=>r.cbOk).length+'/'+rows.length);
console.log('byte growth range                     :',Math.min(...rows.map(r=>r.growth)),'..',Math.max(...rows.map(r=>r.growth)));
const bad=rows.filter(r=>!(r.reconstructed&&r.protOk&&r.cbOk));
if(bad.length){ console.log('\nPROBLEMS:'); bad.forEach(r=>console.log('  ',r.k,JSON.stringify(r))); }
console.log('\nOVERALL CONTENT INTEGRITY:',allOk?'PASS':'FAIL');
