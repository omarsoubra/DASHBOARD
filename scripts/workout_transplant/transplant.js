/* Function-level workout-engine transplant.
   Replaces named top-level declarations and the single workout-engine IIFE with the
   byte-identical known-good production implementations taken from a reference shell.
   Never regenerates. Fails closed on: unknown variant, missing anchor, parse failure,
   content-block drift, or any change outside the declared transplant set. */
const fs=require('fs'),crypto=require('crypto'),acorn=require('acorn');
const {declsOf}=require('./decls.js'); const {units}=require('./iife.js');
// IIFE units are located by the functions they define, never by position or size.
const IIFE={
  ENGINE :{markers:['createSession','writeLocal','entryFor']},
  RESTORE:{markers:['hydrateFromCloud','KEY_LAST_RESTORE']},
};
/* PRE-LIFECYCLE ENGINE LOCATOR.
   A shell that predates the TV2 session lifecycle has no IIFE defining
   createSession/writeLocal/entryFor, so the ordinary ENGINE locator reports
   ABSENT and the transplant refuses. Such a shell nevertheless carries the TV2
   screen engine: exactly one top-level IIFE that publishes the tv2 window
   surface. It is located by that surface - never by size or position - and it
   is installed only when replacing it cannot remove behaviour the shell still
   uses, which is what the export-subset gate below proves. */
const PRE_LIFECYCLE={
  requires:['tv2Open','tv2LogSet','tv2Go','tv2Home'],   /* the TV2 screen surface */
  forbids:['createSession'],                            /* the lifecycle's own constructor */
  forbidsText:['_workout_sessions']                     /* and its ledger key */
};
function preLifecycleEngines(file){
  return units(file).filter(x=>
    PRE_LIFECYCLE.requires.every(m=>x.exports.includes(m)) &&
    !PRE_LIFECYCLE.forbids.some(m=>x.names.includes(m)) &&
    !PRE_LIFECYCLE.forbidsText.some(t=>x.text.includes(t)));
}
function iifeUnit(file,markers){
  const c=units(file).filter(x=>markers.every(m=>x.names.includes(m)));
  return c.sort((a,b)=>b.bytes-a.bytes)[0]||null;
}
const CLIENTS=process.env.CLIENTS_DIR||'clients';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const sha32=s=>crypto.createHash('sha256').update(s).digest('hex');

const UNITS={
  TRACK_A   :{members:['cloudWrite','_markSync','syncSaving','syncSaved','syncFailed','_mealPending','retryUnsyncedMeals'], anchorBefore:['loadWorkoutLogs','postWorkoutLog']},
  WORKOUT_IO:{members:['_workoutLogId','loadWorkoutLogs','saveWorkoutLogsLocal','postWorkoutLog','saveWorkoutLog','cancelWorkoutLog'], anchorBefore:['postWorkoutLog']},
  FIND_LOAD :{members:['_logWeightText','_FL_NON_LOAD','_FL_TOKEN','_fmtKg','_loadState','_FL_AUTH_KG','_FL_AUTH_FIND','_authoredLoadKind','_FL_EFFORT','_authoredEffortCue','_fl_esc','_resolveLoadBadge'], anchorBefore:['_workoutPending','postWorkoutLog']},
  PERF_REF  :{members:['_workoutPending','_perfRef','_ensurePerfRef'], anchorBefore:['postWorkoutLog']},
  B5        :{members:['_wlB5','_wlStr','_wlNorm','_wlIsBwRx','_wlLooksLikeLoad','_wlIsRange','_wlPlainInt','_wlField','_wlSet','_wlHintBox','_wlHint','_wlPriorActual','_wlUseLast','_wlValidate'], anchorBefore:['saveWorkoutLog']},
};
const CONTENT=[
 [/const mealPlan = \{\};[\s\S]*?mealPlan\[12\] = \[[\s\S]*?\];/,'mealPlan'],
 [/const phases = \{[\s\S]*?\n\};/,'phases'],
 [/const CLIENT_CONFIG = \{[\s\S]*?\n\};/,'CLIENT_CONFIG'],
 [/const phaseTargets = [\s\S]*?;/,'phaseTargets'],
 [/const DAY_TYPES=[\s\S]*?;/,'DAY_TYPES'],
 [/const DAY_NAMES=[\s\S]*?;/,'DAY_NAMES'],
 [/const howTos = \{[\s\S]*?\n\};/,'howTos'],
 [/const FOOD_DB = \[[\s\S]*?\n\];/,'FOOD_DB'],
];
const contentHashes=h=>Object.fromEntries(CONTENT.map(([re,n])=>{const m=h.match(re);return [n,m?sha(m[0]):null];}));

function index(file){
  const html=fs.readFileSync(file,'utf8');
  const d=declsOf(html).filter(x=>!x.error);
  const by=new Map(); for(const x of d) if(!by.has(x.name)) by.set(x.name,x);
  const iifes={};
  for(const [u,cfg] of Object.entries(IIFE)) iifes[u]=iifeUnit(file,cfg.markers);
  return {html,decls:d,by,iifes};
}
function unitSha(idx,u){
  const found=UNITS[u].members.filter(n=>idx.by.has(n));
  if(!found.length) return 'ABSENT';
  const s=sha(found.map(n=>idx.by.get(n).text).join('\n'));
  return found.length<UNITS[u].members.length ? 'PART:'+s : s;
}

function transplant(key,ref,refShas,allowed){
  const idx=index(`${CLIENTS}/${key}/index.html`);
  const audit={client:key,before:{},after:{},actions:[],refusals:[]};
  const edits=[]; // {start,end,text,what}

  // ---- IIFE units ----
  for(const u of Object.keys(IIFE)){
    const cur=idx.iifes[u]; const before = cur? sha(cur.text)+':'+cur.bytes : 'ABSENT';
    audit.before[u]=before;
    if(before===refShas[u]) continue;
    if(before==='ABSENT'){
      if(u!=='ENGINE'){ audit.refusals.push(`${u} IIFE absent — no anchor defined for a full install`); continue; }
      /* pre-lifecycle path — every gate must pass or the shell is refused */
      const cands=preLifecycleEngines(`${CLIENTS}/${key}/index.html`);
      if(cands.length!==1){ audit.refusals.push(`ENGINE absent and the pre-lifecycle locator matched ${cands.length} candidates (need exactly 1)`); continue; }
      const pre=cands[0], preSha=sha(pre.text)+':'+pre.bytes;
      audit.before.ENGINE='PRE_LIFECYCLE:'+preSha;
      if(!(allowed.ENGINE_PRE||[]).includes(preSha)){ audit.refusals.push(`unknown pre-lifecycle ENGINE variant ${preSha}`); continue; }
      const lost=pre.exports.filter(x=>!ref.iifes.ENGINE.exports.includes(x));
      if(lost.length){ audit.refusals.push(`pre-lifecycle ENGINE exports the reference does not provide: ${lost.join(',')}`); continue; }
      edits.push({start:pre.start,end:pre.end,text:ref.iifes.ENGINE.text,what:'ENGINE(pre-lifecycle)'});
      audit.actions.push(`ENGINE pre-lifecycle ${preSha} -> ${refShas.ENGINE} (exports ${pre.exports.length} -> ${ref.iifes.ENGINE.exports.length}, none lost)`);
      continue;
    }
    if(!allowed[u].includes(before)){ audit.refusals.push(`unknown ${u} IIFE variant ${before}`); continue; }
    edits.push({start:cur.start,end:cur.end,text:ref.iifes[u].text,what:u});
    audit.actions.push(`${u} IIFE replaced ${before} -> ${refShas[u]}`);
  }

  // ---- declaration units ----
  for(const u of Object.keys(UNITS)){
    const cur=unitSha(idx,u); audit.before[u]=cur;
    if(cur===refShas[u]) continue;
    if(!allowed[u].includes(cur)){ audit.refusals.push(`unknown ${u} variant ${cur}`); continue; }
    const present=UNITS[u].members.filter(n=>idx.by.has(n));
    const absent =UNITS[u].members.filter(n=>!idx.by.has(n));
    for(const n of present){
      if(!ref.by.has(n)){ audit.refusals.push(`${u}: reference lacks ${n}`); continue; }
      edits.push({start:idx.by.get(n).start,end:idx.by.get(n).end,text:ref.by.get(n).text,what:`${u}:${n}`});
    }
    if(absent.length){
      const anchorName=UNITS[u].anchorBefore.find(a=>idx.by.has(a));
      if(!anchorName){ audit.refusals.push(`${u}: no insertion anchor (${UNITS[u].anchorBefore.join('|')}) found`); continue; }
      const anchor=idx.by.get(anchorName);
      const text=absent.map(n=>ref.by.get(n).text).join('\n\n')+'\n\n';
      edits.push({start:anchor.start,end:anchor.start,text,what:`${u}:insert[${absent.join(',')}] before ${anchorName}`});
    }
    audit.actions.push(`${u} ${cur} -> ${refShas[u]} (replace ${present.length}, insert ${absent.length})`);
  }

  if(audit.refusals.length) return {audit,html:null};
  if(!edits.length){ audit.actions.push('already current — no change'); return {audit,html:idx.html,unchanged:true}; }

  // apply right-to-left; refuse on overlap
  edits.sort((a,b)=>b.start-a.start||b.end-a.end);
  for(let i=0;i<edits.length-1;i++){
    if(edits[i].start < edits[i+1].end && !(edits[i].start===edits[i].end)){
      audit.refusals.push(`overlapping edits: ${edits[i].what} vs ${edits[i+1].what}`); return {audit,html:null};
    }
  }
  let out=idx.html;
  for(const e of edits) out=out.slice(0,e.start)+e.text+out.slice(e.end);

  // ---- post-transform invariants ----
  const cb0=contentHashes(idx.html), cb1=contentHashes(out);
  audit.contentBlocks={before:cb0,after:cb1};
  for(const k of Object.keys(cb0)) if(cb0[k]!==cb1[k]) audit.refusals.push(`content block ${k} changed`);
  fs.writeFileSync(`/tmp/tp_${key}.html`,out);
  const idx2=index(`/tmp/tp_${key}.html`);
  if(idx2.decls.some(x=>x.error)) audit.refusals.push('post-transform parse error');
  for(const u of Object.keys(UNITS)){ audit.after[u]=unitSha(idx2,u); if(audit.after[u]!==refShas[u]) audit.refusals.push(`${u} did not converge (${audit.after[u]})`); }
  for(const u of Object.keys(IIFE)){
    audit.after[u]= idx2.iifes[u]? sha(idx2.iifes[u].text)+':'+idx2.iifes[u].bytes : 'ABSENT';
    if(audit.after[u]!==refShas[u]) audit.refusals.push(`${u} did not converge (${audit.after[u]})`);
  }

  // everything outside the transplant set must be untouched
  const protectedBefore=idx.decls.filter(x=>!isTransplanted(x.name)).map(x=>x.name+':'+sha(x.text)).sort();
  const protectedAfter =idx2.decls.filter(x=>!isTransplanted(x.name)).map(x=>x.name+':'+sha(x.text)).sort();
  const pb=sha32(protectedBefore.join('|')), pa=sha32(protectedAfter.join('|'));
  audit.protectedDecls={count:protectedBefore.length,before:pb.slice(0,16),after:pa.slice(0,16),identical:pb===pa};
  if(pb!==pa){
    const setB=new Set(protectedBefore), setA=new Set(protectedAfter);
    audit.refusals.push('protected declarations changed: '+[...setB].filter(x=>!setA.has(x)).slice(0,5).join(', '));
  }
  if(audit.refusals.length) return {audit,html:null};
  return {audit,html:out};
}
const TRANSPLANTED=new Set(Object.values(UNITS).flatMap(u=>u.members));
function isTransplanted(n){ return TRANSPLANTED.has(n); }
module.exports={transplant,index,unitSha,UNITS,IIFE,contentHashes,sha,preLifecycleEngines};
