const fs=require('fs');
const src=fs.readFileSync('C:/Github/wikitree_Citationdownloader/background.js','utf8');
function grab(name) {
  let idx=src.indexOf('async function '+name+'(');
  if (idx === -1) { idx=src.indexOf('function '+name+'('); }
  if (idx === -1) { throw new Error('sig-nicht-gefunden: '+name); }
  return innerGrab(src, idx);
}
function innerGrab(src, start) {
  let i=src.indexOf("{", start);
  let depth=0;
  for (let j=i; j<src.length; j++) {
    const ch=src.charAt(j);
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { return src.substring(start, j+1); } }
  }
  throw new Error('ende-nicht-gefunden');
}
const parts=[];
parts.push(grab('isLandesarchivBwUrl'));
parts.push(grab('absoluteUrl'));
parts.push(grab('decodeUrlAmpersands'));
parts.push(grab('getAttr'));
parts.push(grab('extractLandesarchivBwBildSource'));
parts.push(grab('extractLandesarchivBwLegacyFormFields'));
parts.push(grab('extractLandesarchivBwJpgOptions'));
parts.push(grab('extractLandesarchivBwCurrentFile'));
parts.push(grab('reRenderLandesarchivBwZoomViaPost'));
parts.push(grab('upgradeLandesarchivBwImageUrlToHttps'));
parts.push(grab('resolveLandesarchivBwPlinkScreenRedirect'));
parts.push(grab('extractMatriculaMetaFromHtml'));
parts.push(grab('combineMatriculaLabel'));
parts.push(grab('extractTitleTag'));
parts.push(grab('extractPageNumberParam'));
fs.writeFileSync('C:/Github/wikitree_Citationdownloader/.grabbed.js', parts.join(String.fromCharCode(10)), 'utf8');
console.log('grabbed: '+parts.length);