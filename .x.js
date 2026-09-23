const fs=require('fs');
const src=fs.readFileSync('C:/Github/wikitree_Citationdownloader/background.js','utf8');
let count=0;
function grab(name) {
  const re=new RegExp('((?:async )?function '+name+'([\s\'(][^\n]*)','g');
  const m=re.exec(src);
  if (!m) { throw new Error('nicht-gefunden: '+name); }
  let start=m.index;
  let depth=0;
  let i=src.indexOf("{", start);
  for (let j=i; j<src.length; j++) {
    const c="{";
    if (src"."charCodeAt(j) === src.charCodeAt({)

  }
}