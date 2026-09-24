/* FIND-LOAD repair: the transplanted FIND_LOAD unit omitted `_logWeightText`,
   which `_loadState` calls. Pure insertion of the reference declaration,
   byte-identical, immediately before the unit's first member (`_FL_NON_LOAD`).
   Fails closed on anything unexpected. */
const fs=require('fs'), path=require('path'), acorn=require('acorn');
const REF=fs.readFileSync('fix_logweighttext.txt','utf8');
const ANCHOR='_FL_NON_LOAD';

function blocks(src){
  const re=/<script\b[^>]*>([\s\S]*?)<\/script>/g; const out=[]; let m;
  while((m=re.exec(src))){ const body=m[1]; out.push({off:m.index+m[0].indexOf(body), body}); }
  return out;
}
function tops(src){
  const out=[];
  for(const b of blocks(src)){
    let ast; try{ ast=acorn.parse(b.body,{ecmaVersion:2022}); }catch(e){ continue; }
    for(const n of ast.body){
      const names=[];
      if(n.type==='FunctionDeclaration'&&n.id) names.push(n.id.name);
      else if(n.type==='ClassDeclaration'&&n.id) names.push(n.id.name);
      else if(n.type==='VariableDeclaration') n.declarations.forEach(d=>{ if(d.id.type==='Identifier') names.push(d.id.name); });
      names.forEach(nm=>out.push({name:nm,s:b.off+n.start,e:b.off+n.end}));
    }
  }
  return out;
}
function fail(k,m){ console.log(JSON.stringify({key:k,ok:false,reason:m})); process.exitCode=1; }

const [,,inPath,outPath,key]=process.argv;
const src=fs.readFileSync(inPath,'utf8');
const T=tops(src);
const already=T.filter(d=>d.name==='_logWeightText');
if(already.length){ return fail(key,'already declared ('+already.length+')'); }
if(!/_logWeightText/.test(src)) return fail(key,'not referenced — unit absent, nothing to repair');
const anch=T.filter(d=>d.name===ANCHOR);
if(anch.length!==1) return fail(key,'anchor '+ANCHOR+' count='+anch.length);
const at=anch[0].s;
const ins=REF+'\n\n';
const out=src.slice(0,at)+ins+src.slice(at);

if(out.length!==src.length+ins.length) return fail(key,'length drift');
if(out.slice(0,at)!==src.slice(0,at)) return fail(key,'prefix drift');
if(out.slice(at+ins.length)!==src.slice(at)) return fail(key,'suffix drift');
const T2=tops(out);
const n2=T2.filter(d=>d.name==='_logWeightText');
if(n2.length!==1) return fail(key,'post decl count='+n2.length);
if(out.slice(n2[0].s,n2[0].e)!==REF) return fail(key,'inserted bytes not identical to reference');
if(T2.length!==T.length+1) return fail(key,'top-level count '+T.length+'->'+T2.length);
const map2={}; T2.forEach(d=>{ (map2[d.name]=map2[d.name]||[]).push(out.slice(d.s,d.e)); });
for(const d of T){
  const before=src.slice(d.s,d.e);
  const cand=map2[d.name]||[];
  if(!cand.includes(before)) return fail(key,'declaration changed: '+d.name);
}
for(const b of blocks(out)){ try{ acorn.parse(b.body,{ecmaVersion:2022}); }catch(e){} }
fs.writeFileSync(outPath,out);
console.log(JSON.stringify({key,ok:true,insertedAt:at,bytes:ins.length,newSize:out.length}));
