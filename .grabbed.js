function isLandesarchivBwUrl(url) {
  try {
    return /(^|\.)landesarchiv-bw\.de$/i.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}
function absoluteUrl(maybeRelative, baseUrl) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (e) {
    return null;
  }
}
function decodeUrlAmpersands(u) {
  return (u || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/\\u0026/gi, "&");
}
function getAttr(attrString, name) {
  const re = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i");
  const m = re.exec(attrString || "");
  if (!m) return null;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return m[3] || "";
}
function extractLandesarchivBwBildSource(html, pageUrl) {
  // Toleranter gelesen als bisher: die gerenderte URL kann einen Pfad-
  // Präfix haben (z.B. '/ofs21/bild_zoom/bild.php?...' nach Server-Update)
  // statt direkt mit 'bild.php?' zu beginnen.
  const sourceMatch = /imageSource:\s*(['"])([^'"]*bild\.php\?[^'"]+)\1/i.exec(html);
  if (!sourceMatch) return null;

  // '&'-Kodierung dekodieren (sonst übernimmt '&amp;zoom=...' als
  // Parameter-NAME im Abruf) und bewusst auf https anheben: WikiTree läuft
  // https, http-Bild-URLs wären Mixed Content und würden blockiert.
  const imageUrl = upgradeLandesarchivBwImageUrlToHttps(
    absoluteUrl(decodeUrlAmpersands(sourceMatch[2]), pageUrl)
  );
  if (!imageUrl) return null;

  // Volle JPEG-Qualität für den Download (siehe Kommentar oben). Fehlt der
  // Parameter, bleibt es bei der URL, wie die Seite sie selbst benutzt.
  let downloadUrl = imageUrl;
  if (/jpegQualitaetZoombild=\d+/i.test(downloadUrl)) {
    downloadUrl = downloadUrl.replace(/jpegQualitaetZoombild=\d+/i, "jpegQualitaetZoombild=100");
  }

  // Aktuell angezeigte Bilddatei: verstecktes Formularfeld (sicherster
  // Indikator), sonst URL-Param gewaehlteSeite, sonst die selected-Option.
  let currentFile = null;
  const vorigeMatch = /vorigeBilddatei["'][^>]*?value=["']([^"']+)["']/i.exec(html);
  if (vorigeMatch) currentFile = vorigeMatch[1];
  if (!currentFile) {
    const paramMatch = /[?&]gewaehlteSeite=([^&'"<>\s]+)/i.exec(pageUrl || "");
    if (paramMatch) {
      try {
        currentFile = decodeURIComponent(paramMatch[1]);
      } catch (e) {
        currentFile = paramMatch[1];
      }
    }
  }

  // Alle Optionen einsammeln, um daraus Label und Seitenzahl zu holen.
  // Über getAttr statt hartes value="..."-Muster: unquoted Optionen der
  // Legacy-HTML-Variante wären sonst verloren (gleiche Toleranz wie bei
  // den Betrachter-Formularfeldern unten).
  const options = [];
  const optionRe = /<option\b([^>]*)>([^<]*)<\/option>/gi;
  let optionMatch;
  while ((optionMatch = optionRe.exec(html)) !== null) {
    const file = getAttr(optionMatch[1], "value") || "";
    if (!/\.jpg(?:$|\?)/i.test(file)) continue;
    options.push({
      file,
      label: optionMatch[2].trim(),
      selected: /\bselected\b/i.test(optionMatch[1])
    });
  }

  let chosenOption = null;
  if (currentFile) chosenOption = options.find((o) => o.file === currentFile);
  if (!chosenOption) chosenOption = options.find((o) => o.selected);

  let pageNumber = null;
  let pageLabel = null;
  if (chosenOption) {
    pageLabel = chosenOption.label || null;
    const numMatch = /^Bild\s*(\d+)$/i.exec(chosenOption.label);
    if (numMatch) pageNumber = parseInt(numMatch[1], 10);
  }

  // Dokumenttitel (z.B. "456 C Nr. 1792, 2 cm") für ein sprechendes Label.
  let label = null;
  const titelMatch = /<div id="titel">[\s\S]{0,2000}?<span[^>]*>([^<]{2,200})</i.exec(html);
  if (titelMatch) label = titelMatch[1].trim();

  // Rechtekategorie, z.B. UND = Rechte unbestimmt (rightsstatements.org).
  let rightsCategory = null;
  const rightsMatch = /https:\/\/rightsstatements\.org\/page\/([A-Za-z0-9]+)\/1\.0\//i.exec(html);
  if (rightsMatch) rightsCategory = rightsMatch[1].toUpperCase();

  return { imageUrl, downloadUrl, label, pageLabel, pageNumber, rightsCategory };
}
function extractLandesarchivBwLegacyFormFields(html) {
  const fields = {};
  let m;
  const inputRe = /<input\b[^>]*>/gi;
  while ((m = inputRe.exec(html)) !== null) {
    if (!/type\s*=\s*["']?hidden["']?/i.test(m[0])) continue;
    const name = getAttr(m[0], "name");
    if (!name) continue;
    fields[name] = getAttr(m[0], "value") || "";
  }
  const selectRe = /<select\b[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(html)) !== null) {
    const name = getAttr(m[0], "name");
    if (!name) continue;
    const opts = [...m[1].matchAll(/<option\b[^>]*>/gi)];
    const chosen = opts.find((o) => /\bselected\b/i.test(o[0])) || opts[0];
    if (chosen) fields[name] = getAttr(chosen[0], "value") || "";
  }
  return fields;
}
function extractLandesarchivBwJpgOptions(html) {
  const values = [];
  const optRe = /<option\b[^>]*>/gi;
  let m;
  while ((m = optRe.exec(html)) !== null) {
    const value = getAttr(m[0], "value") || "";
    if (/\.jpg(?:$|\?)/i.test(value)) values.push(value);
  }
  return values;
}
function extractLandesarchivBwCurrentFile(html, pageUrl) {
  const jpgOptions = extractLandesarchivBwJpgOptions(html);
  if (jpgOptions.length === 0) return null;
  let idx = -1;
  const pageParam = pageUrl ? /[?&]gewaehlteSeite=(\d+)/i.exec(pageUrl) : null;
  const jsBilddatei = /bilddatei=(\d+)/i.exec(html);
  if (pageParam) idx = parseInt(pageParam[1], 10) - 1;
  else if (jsBilddatei) idx = parseInt(jsBilddatei[1], 10) - 1;
  if (idx >= 0 && idx < jpgOptions.length) return jpgOptions[idx];
  return jpgOptions[0];
}
async function reRenderLandesarchivBwZoomViaPost(html, pageUrl) {
  try {
    const fields = extractLandesarchivBwLegacyFormFields(html);
    const current = extractLandesarchivBwCurrentFile(html, pageUrl);
    if (!current) return null;
    fields.originalBilddatei = current;

    const formMatch = /<form\b[^>]*name\s*=\s*["']?formular["']?[^>]*>/i.exec(html);
    const action = formMatch ? getAttr(formMatch[0], "action") : null;
    const postUrl = absoluteUrl(action || "zoom.php", pageUrl);
    if (!postUrl || !/^https?:/i.test(postUrl)) return null;

    const res = await fetchWithTimeout(postUrl, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    // Bewusst still: Der POST ist nur ein Renderversuch. Scheitert er
    // (z.B. geaenderter Server-State), greift der Formular-Download.
    return null;
  }
}
function upgradeLandesarchivBwImageUrlToHttps(url) {
  if (/^http:\/\/(?:[a-z0-9-]+\.)*landesarchiv-bw\.de\//i.test(url)) {
    return url.replace(/^http:/i, "https:");
  }
  return url;
}
function resolveLandesarchivBwPlinkScreenRedirect(html, finalUrl) {
  try {
    if (!finalUrl || finalUrl.indexOf("/plink_screen.php") < 0) return null;
    // Zusaetzlich pruefen, dass die Seite wirklich der JS-Stub ist
    // (self.location.href mit zoom.php-Ziel) - sonst handelt es
    // sich um einen anderen Seitentyp unter plink_screen.php.
    const stubIdx = html.indexOf("self.location.href");
    if (stubIdx < 0 || html.indexOf("zoom.php?", stubIdx) < 0) return null;
    return finalUrl.replace("/plink_screen.php", "/zoom.php");
  } catch (e) {
    return null;
  }
}
function extractMatriculaMetaFromHtml(html) {
  const result = { parish: null, bookType: null, signature: null, pageNumber: null };

  const tableMatch = /<table\b[^>]*class=["'][^"']*\btable-register-data\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (tableMatch) {
    const rowRe = /<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tableMatch[1])) !== null) {
      const key = stripHtmlEntities(rm[1].replace(/<[^>]+>/g, " ")).trim();
      const val = stripHtmlEntities(rm[2].replace(/<[^>]+>/g, " ")).trim();
      if (/^Pfarre\/?\s*Ort$/i.test(key)) result.parish = val;
      else if (/^Signatur$/i.test(key)) result.signature = val;
      else if (/^Buchtyp$/i.test(key)) result.bookType = val;
    }
  }

  const activeRe = /<a\b(?=[^>]*\bclass=["'][^"']*\bdocview-pagelink\b)(?=[^>]*\bclass=["'][^"']*\bactive\b)[^>]*\bdata-pg=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
  const am = activeRe.exec(html);

  if (am) {
    const label = stripHtmlEntities(am[2].replace(/<[^>]+>/g, " ")).trim();
    const numMatch = /(\d+)\s*$/.exec(label);
    if (numMatch) result.pageNumber = parseInt(numMatch[1], 10);
  }

  return result;
}
function combineMatriculaLabel(meta) {
  const parts = [meta.parish, meta.bookType, meta.signature].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}
function extractTitleTag(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const text = stripHtmlEntities(m[1]);
  return text || null;
}
function extractPageNumberParam(url) {
  try {
    const u = new URL(url);
    const pg = u.searchParams.get("pg");
    return pg ? parseInt(pg, 10) : null;
  } catch (e) {
    return null;
  }
}