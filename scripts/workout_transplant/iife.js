/* Find top-level IIFEs / blocks in each script and report which named functions
   each one defines, so the real encapsulation boundary of the workout engine is
   visible rather than assumed. */
const fs=require('fs'),acorn=require('acorn'),walk=require('acorn-walk');
const {scriptBlocks}=require('./decls.js');
function units(file){
  const html=fs.readFileSync(file,'utf8'); const out=[];
  for(const blk of scriptBlocks(html)){
    const src=html.slice(blk.start,blk.end);
    let ast; try{ ast=acorn.parse(src,{ecmaVersion:'latest',sourceType:'script'}); }catch(e){ continue; }
    for(const node of ast.body){
      let fn=null;
      if(node.type==='ExpressionStatement'){
        const e=node.expression;
        const c = e.type==='CallExpression'?e : (e.type==='UnaryExpression'&&e.argument.type==='CallExpression'?e.argument : null);
        if(c&&c.callee&&(c.callee.type==='FunctionExpression'||c.callee.type==='ArrowFunctionExpression')) fn=c.callee;
      }
      if(!fn) continue;
      const names=new Set(); const wins=new Set();
      walk.simple(fn,{
        FunctionDeclaration(n){ if(n.id) names.add(n.id.name); },
        VariableDeclarator(n){ if(n.id&&n.id.type==='Identifier') names.add(n.id.name); },
        AssignmentExpression(n){ const L=n.left; if(L.type==='MemberExpression'&&L.object.type==='Identifier'&&L.object.name==='window'&&L.property.type==='Identifier') wins.add(L.property.name); }
      });
      out.push({start:blk.start+node.start,end:blk.start+node.end,bytes:node.end-node.start,
                names:[...names],exports:[...wins],text:html.slice(blk.start+node.start,blk.start+node.end)});
    }
  }
  return out;
}
module.exports={units};
if(require.main===module){
  const f=process.argv[2]||'shells/salman_abdallah/index.html';
  const u=units(f).sort((a,b)=>b.bytes-a.bytes);
  console.log(f,'top-level IIFEs:',u.length);
  for(const x of u.slice(0,8)){
    const probe=['tv2LogSet','createSession','altsFor','_resolveLoadBadge','tv2Fix','subsPendingSlots','cloudRestore','entryFor','writeLocal'].filter(p=>x.names.includes(p));
    console.log(`  bytes=${x.bytes.toString().padStart(7)} decls=${String(x.names.length).padStart(4)} exports=${x.exports.length}  engine:[${probe.join(',')}]`);
  }
}
