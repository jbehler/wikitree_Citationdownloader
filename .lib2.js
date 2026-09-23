const fs=require('fs');
const src=fs.readFileSync('C:/Github/wikitree_Citationdownloader/background.js','utf8');
function grab(name) {
  const sig='function '+name+'(';
  const start=src.indexOf(sig);
  if (start < 0) { throw new Error('sig-nicht-gefunden: '+name); }
  let i=src.indexOf("{", start);
  let depth=0;
  for (let j=i; j<src.length; j++) {
    const ch=src.charAt(j);
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { return src.substring(start, j+1); } }
  }
  throw new Error('ende-nicht-gefunden: '+name);
}
let code='';
  code+=
  grab('isLandesarchivBwUrl');
  code+=
  grab('absoluteUrl');
  code+=
  grab('decodeUrlAmpersands');
  code+=
  grab('getAttr');
  code+=
  grab('extractLandesarchivBwBildSource');
  code+=
  grab('extractLandesarchivBwLegacyFormFields');
  code+=
  grab('extractLandesarchivBwJpgOptions');
  code+=
  grab('extractLandesarchivBwCurrentFile');
  code+=
  grab('reRenderLandesarchivBwZoomViaPost');
  code+=
  grab('upgradeLandesarchivBwImageUrlToHttps');
  code+=
  grab('resolveLandesarchivBwPlinkScreenRedirect');
  code+=
  grab('extractMatriculaMetaFromHtml');
  code+=
  grab('combineMatriculaLabel');
  code+=
  grab('extractTitleTag');
  code+=
  grab('extractPageNumberParam');
eval(code);