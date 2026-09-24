/* Extract top-level declarations from every <script> block of a shell, with
   exact byte spans in the ORIGINAL file. Uses a real JS parser (acorn), never
   regex, so string/comment/regex literals can never be mistaken for code. */
const fs=require('fs'), acorn=require('acorn');

function scriptBlocks(html){
  const out=[]; const re=/<script\b([^>]*)>/gi; let m;
  while((m=re.exec(html))){
    const attrs=m[1]||'';
    if(/\bsrc\s*=/i.test(attrs)) continue;
    if(/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)/i.test(attrs)) continue;
    const start=m.index+m[0].length;
    const end=html.indexOf('</script>',start);
    if(end<0) continue;
    out.push({start,end});
    re.lastIndex=end;
  }
  return out;
}

function declsOf(html){
  const out=[];
  for(const blk of scriptBlocks(html)){
    const src=html.slice(blk.start,blk.end);
    let ast;
    try{ ast=acorn.parse(src,{ecmaVersion:'latest',sourceType:'script',locations:false}); }
    catch(e){ out.push({error:String(e.message),blockStart:blk.start}); continue; }
    for(const node of ast.body){
      const push=(name,kind,s,e)=>out.push({
        name,kind,start:blk.start+s,end:blk.start+e,
        text:html.slice(blk.start+s,blk.start+e)
      });
      if(node.type==='FunctionDeclaration'&&node.id) push(node.id.name,'function',node.start,node.end);
      else if(node.type==='VariableDeclaration'){
        for(const d of node.declarations){
          if(d.id&&d.id.type==='Identifier') push(d.id.name,node.kind,node.start,node.end);
        }
      }
      else if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'){
        const L=node.expression.left;
        if(L.type==='MemberExpression'&&L.object.type==='Identifier'&&L.object.name==='window'&&L.property.type==='Identifier')
          push('window.'+L.property.name,'window',node.start,node.end);
      }
      else if(node.type==='ExpressionStatement'&&node.expression.type==='CallExpression'){
        // IIFEs and bare calls are not named declarations; record position only
      }
    }
  }
  return out;
}
module.exports={declsOf,scriptBlocks};
if(require.main===module){
  const html=fs.readFileSync(process.argv[2],'utf8');
  const d=declsOf(html);
  const errs=d.filter(x=>x.error);
  if(errs.length){ console.log(JSON.stringify({parseErrors:errs},null,1)); }
  console.log(JSON.stringify({file:process.argv[2],blocks:scriptBlocks(html).length,decls:d.filter(x=>!x.error).length,
    names:d.filter(x=>!x.error).map(x=>x.name)},null,1).slice(0,1500));
}
