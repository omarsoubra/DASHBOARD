const fs=require('fs'), acorn=require('acorn'), walk=require('acorn-walk');
function blocks(src){const re=/<script\b[^>]*>([\s\S]*?)<\/script>/g;const o=[];let m;
  while((m=re.exec(src))) o.push(m[1]); return o;}
function declaredAnywhere(src){
  const D=new Set();
  for(const b of blocks(src)){
    let ast; try{ast=acorn.parse(b,{ecmaVersion:2022});}catch(e){continue;}
    walk.full(ast,n=>{
      if(n.type==='FunctionDeclaration'&&n.id)D.add(n.id.name);
      if(n.type==='FunctionExpression'&&n.id)D.add(n.id.name);
      if(n.type==='ClassDeclaration'&&n.id)D.add(n.id.name);
      if(n.type==='VariableDeclarator'&&n.id.type==='Identifier')D.add(n.id.name);
      if((n.type==='FunctionDeclaration'||n.type==='FunctionExpression'||n.type==='ArrowFunctionExpression'))
        n.params.forEach(p=>{if(p.type==='Identifier')D.add(p.name);});
    });
  }
  return D;
}
function referenced(src){
  const R=new Set();
  for(const b of blocks(src)){
    let ast; try{ast=acorn.parse(b,{ecmaVersion:2022});}catch(e){continue;}
    walk.full(ast,(n)=>{ if(n.type==='Identifier') R.add(n.name); },
      Object.assign({},walk.base,{MemberExpression(node,st,c){ c(node.object,st);
        if(node.computed) c(node.property,st); }, Property(node,st,c){ if(node.computed) c(node.key,st); c(node.value,st);} }));
  }
  return R;
}
const ref=process.argv[2], files=process.argv.slice(3);
const refDecl=declaredAnywhere(fs.readFileSync(ref,'utf8'));
let bad=0;
for(const f of files){
  const src=fs.readFileSync(f,'utf8');
  const D=declaredAnywhere(src), R=referenced(src);
  const missing=[...R].filter(n=>!D.has(n)&&refDecl.has(n)).sort();
  if(missing.length){ console.log(f,'=>',missing.join(', ')); bad++; }
}
console.log('scanned',files.length,'withFindings',bad);
