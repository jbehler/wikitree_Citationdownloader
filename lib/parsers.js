/**
 * lib/parsers.js
 * -----------------------------------------------------------------------
 * Reine, DOM- und chrome-freie Parser-/Hilfsfunktionen des Service Workers
 * (background.js). Ausgelagert, damit sie per Node-Testrunner (node --test)
 * ohne Browser getestet werden können. Die Funktionen stehen im
 * Service-Worker per importScripts("lib/parsers.js") global zur Verfügung
 * (klassischer Service Worker, kein type:module, kein Build-Schritt) und
 * werden am Dateiende zusätzlich für Node per module.exports exportiert.
 *
 * Die Begründungskommentare (Historie der Parser-Entscheidungen) wurden
 * unverändert mit aus background.js übernommen - siehe dort den
 * Datei-Header für die Gesamtübersicht der Wege.
 * -----------------------------------------------------------------------
 */

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|tiff?)(\?[^"'\s]*)?$/i;
const SKIP_HINTS_RE = /(logo|icon|sprite|favicon|banner|avatar)/i;
const PREFERRED_USE_ORDER = ["MAX", "FULL", "DOWNLOAD", "DEFAULT", "MASTER", "ORIGINAL", "LARGE"];

function absoluteUrl(maybeRelative, baseUrl) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

// Liest ein Attribut aus einem Attribut-String, tolerant gegenüber doppelten
// UND einfachen Anführungszeichen sowie unquoted Werten (Landesarchiv-BW-
// Seiten nutzen teils Legacy-HTML wie width=13 ohne Anführungszeichen - ohne
// diese Toleranz gingen dort z.B. name/value der Betrachter-Formularfelder
// und der originalBilddatei-Optionen verloren und der POST-Renderversuch
// würde nie anlaufen).
function getAttr(attrString, name) {
  const re = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))", "i");
  const m = re.exec(attrString || "");
  if (!m) return null;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return m[3] || "";
}

// Findet alle Öffnungs-Tags eines Elementnamens (Namespace-Präfix egal),
// inkl. Info ob es sich um ein selbstschließendes Tag handelt.
function findAllTagOpenings(xml, tagName) {
  const re = new RegExp(`<(?:\\w+:)?${tagName}\\b([^>]*?)(\\/?)>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ index: m.index, end: re.lastIndex, attrs: m[1], selfClosing: m[2] === "/" });
  }
  return out;
}

function findAllClosingTagPositions(xml, tagName) {
  const re = new RegExp(`<\\/(?:\\w+:)?${tagName}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m.index);
  return out;
}

// ---------------------------------------------------------------------
// Weg 1: DFG-Viewer -> METS
// ---------------------------------------------------------------------

function parseDfgViewerUrl(dfgUrl) {
  try {
    const u = new URL(dfgUrl);
    const metsUrl = u.searchParams.get("tx_dlf[id]");
    const pageStr = u.searchParams.get("tx_dlf[page]");
    const page = pageStr ? parseInt(pageStr, 10) : 1;
    if (!metsUrl) return null;
    return { metsUrl, page: Number.isFinite(page) ? page : 1 };
  } catch (e) {
    return null;
  }
}

// Liefert: { fileId: { USE_WERT: absoluteUrl, ... }, ... }
// (fileGrp-Elemente stehen typischerweise als flache Geschwister im
// fileSec, daher hier weiterhin ein Blockregex – geringeres Risiko als
// bei strukturell garantiert verschachtelten structMap-Divs.)
function extractFileGroups(xmlText, baseUrl) {
  const fileMap = {};
  const fileGrpRe = /<(?:\w+:)?fileGrp\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?fileGrp>/gi;
  let gm;
  while ((gm = fileGrpRe.exec(xmlText)) !== null) {
    const use = (getAttr(gm[1], "USE") || "UNKNOWN").toUpperCase();
    const inner = gm[2];
    const fileRe = /<(?:\w+:)?file\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?file>)/gi;
    let fm;
    while ((fm = fileRe.exec(inner)) !== null) {
      const id = getAttr(fm[1], "ID");
      const body = fm[2] || "";
      // href kann in zwei Formen vorliegen: selbstschließend
      // (<file ID="…" xlink:href="…"/>) -> im Attribut-String, oder mit
      // <FLocat>-Kind (<file …><FLocat xlink:href="…"/></file>,
      // Kitodo-typisch) -> im Element-Inhalt. Vorher wurde nur im Inhalt
      // gesucht, weshalb selbstschließende file-Elemente stillschweigend
      // übergangen wurden (keine URL im fileSec zugeordnet).
      const attrAndBody = fm[1] + " " + body;
      const hrefMatch =
        /xlink:href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrAndBody) ||
        /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrAndBody);
      const href = hrefMatch ? hrefMatch[1] || hrefMatch[2] : null;
      if (id && href) {
        const abs = absoluteUrl(href, baseUrl);
        if (abs) {
          if (!fileMap[id]) fileMap[id] = {};
          fileMap[id][use] = abs;
        }
      }
    }
  }
  return fileMap;
}

// Robuste Suche der FILEIDs für eine bestimmte Seite: Div-Grenzen werden
// über die Positionen ALLER div-Tags bestimmt, nicht über einen einzigen
// verschachtelten Regex-Treffer (siehe Erklärung oben im Datei-Header).
function extractFileIdsForPage(xmlText, pageOrder) {
  const openings = findAllTagOpenings(xmlText, "div").filter((d) => !d.selfClosing);
  const closings = findAllClosingTagPositions(xmlText, "div");

  const pageDivs = openings.filter((d) => {
    const type = getAttr(d.attrs, "TYPE");
    return type && type.toLowerCase() === "page";
  });

  const target = pageDivs.find((d) => {
    const order = getAttr(d.attrs, "ORDER");
    return order !== null && parseInt(order, 10) === pageOrder;
  });

  if (!target) {
    const orders = pageDivs
      .map((d) => getAttr(d.attrs, "ORDER"))
      .filter((o) => o !== null)
      .slice(0, 10);
    const diag =
      pageDivs.length === 0
        ? "Es wurden gar keine <div TYPE=\"page\"> Elemente gefunden – evtl. anderer TYPE-Wert oder anderes Element als erwartet."
        : `Es wurden ${pageDivs.length} Seiten-Divs gefunden, u.a. mit ORDER-Werten: ${orders.join(", ")}${pageDivs.length > 10 ? " …" : ""}. Gesuchte Seite ${pageOrder} war nicht darunter.`;
    return { ids: [], diag };
  }

  // Nächstliegende Grenze (nächstes div-Öffnungs- ODER Schließ-Tag nach
  // Ende des Ziel-Divs) bestimmt das Ende des Inhalts dieses Divs -
  // korrekt unter der Annahme, dass Seiten-Divs selbst keine weiteren
  // <div>-Kinder enthalten (nur <fptr>-Kinder), was der üblichen
  // DFG-Viewer/Kitodo-METS-Konvention entspricht.
  const nextOpen = openings.find((d) => d.index > target.end);
  const nextClose = closings.find((pos) => pos > target.end);
  const boundary = Math.min(nextOpen ? nextOpen.index : Infinity, nextClose !== undefined ? nextClose : Infinity);
  const slice = xmlText.slice(target.end, boundary === Infinity ? xmlText.length : boundary);

  const fptrRe = /<(?:\w+:)?fptr\b[^>]*?FILEID\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const ids = [];
  let fm;
  while ((fm = fptrRe.exec(slice)) !== null) ids.push(fm[1] || fm[2]);

  if (ids.length === 0) {
    return { ids: [], diag: `Seiten-Div für Seite ${pageOrder} gefunden, aber keine <fptr FILEID="..."> darin.` };
  }
  return { ids, diag: null };
}

function pickBestUrl(fileMap, fileIds) {
  for (const pref of PREFERRED_USE_ORDER) {
    for (const id of fileIds) {
      const groups = fileMap[id];
      if (!groups) continue;
      const key = Object.keys(groups).find((k) => k.includes(pref));
      if (key) return groups[key];
    }
  }
  for (const id of fileIds) {
    const groups = fileMap[id];
    if (groups) {
      const anyKey = Object.keys(groups)[0];
      if (anyKey) return groups[anyKey];
    }
  }
  return null;
}

function safeFromCodePoint(code) {
  // Ungültige CodePoints (z.B. 0 oder Surrogate-Hälften) -> leer, statt
  // eine Exception zu werfen oder ein defektes Zeichen zu erzeugen.
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  try {
    return String.fromCodePoint(code);
  } catch (e) {
    return "";
  }
}

function stripHtmlEntities(text) {
  // Benannte Entities und numerische Entities (dezimal + hex). &amp; wird
  // ZULETZT ersetzt, damit doppelt kodierte Folgen wie "&amp;#39;" nicht
  // zweifach dekodiert werden.
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------
// Weg 2b: generische HTML-Bild-Suche (Fallback; für Matricula ist Weg 2a
// mit der dv1-Variable der verlässliche Weg)
// ---------------------------------------------------------------------

function extractCandidateImageUrlsFromHtml(html, baseUrl) {
  // Hochconfidence: <img>-Tags mit Kitodo/dlf-typischen id/class-Hinweisen
  // (z.B. id="image", class enthält "tx-dlf" oder "page"), UNABHÄNGIG von
  // einer erkennbaren Dateiendung in der URL - viele Kitodo-Installationen
  // liefern Bilder über endungslose bzw. query-basierte URLs aus.
  const highConfidence = [];
  const imgTagFullRe = /<img\b([^>]*)>/gi;
  let im;
  while ((im = imgTagFullRe.exec(html)) !== null) {
    const attrs = im[1];
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!srcMatch) continue;
    const src = srcMatch[1] || srcMatch[2];
    const abs = absoluteUrl(src, baseUrl);
    if (!abs || SKIP_HINTS_RE.test(abs)) continue;
    const idOrClass = /\b(?:id|class)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m2,
      hint = "";
    while ((m2 = idOrClass.exec(attrs)) !== null) hint += " " + (m2[1] || m2[2] || "");
    if (/tx-dlf|tx_dlf|page-?image|pageview|dlf-image|\bimage\b/i.test(hint)) {
      highConfidence.push(abs);
    }
  }
  if (highConfidence.length > 0) return highConfidence;

  // Fallback: wie bisher, aber mit erkennbarer Bild-Dateiendung.
  const candidates = new Set();
  const imgTagRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = imgTagRe.exec(html)) !== null) {
    const abs = absoluteUrl(m[1], baseUrl);
    if (abs && IMAGE_EXT_RE.test(abs) && !SKIP_HINTS_RE.test(abs)) candidates.add(abs);
  }
  const jsonFieldRe = /"(?:image|src|file|url)"\s*:\s*"([^"]+\.(?:jpe?g|png|webp|tiff?)[^"]*)"/gi;
  while ((m = jsonFieldRe.exec(html)) !== null) {
    const raw = m[1].replace(/\\\//g, "/");
    const abs = absoluteUrl(raw, baseUrl);
    if (abs && !SKIP_HINTS_RE.test(abs)) candidates.add(abs);
  }
  return Array.from(candidates);
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

function extractTitleTag(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const text = stripHtmlEntities(m[1]);
  return text || null;
}

// Bestätigte Struktur (vom Nutzer per Beispielseite geliefert):
// <table class="table table-register-data"><tr><th>Pfarre/Ort</th><td>…</td></tr>
// …<tr><th>Signatur</th><td>…</td></tr><tr><th>Buchtyp</th><td>…</td></tr>…</table>
// Die tatsächliche Kirchenbuch-Seitenzahl steht NICHT im "pg"-URL-Parameter
// und auch nicht im "data-pg"-Attribut, sondern im Text des aktiven
// Seiten-Links, z.B. <a class="docview-pagelink … active" data-pg="201">
// T_197</a> -> Seite 197 (Präfix wie "T_" für Taufen o.ä. wird abgeschnitten).
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

// ---------------------------------------------------------------------
// Weg 2a: Matricula-Bild-URLs aus der dv1-JavaScript-Variable (bestätigt)
// -----------------------------------------------------------------------
// Bestätigt an Live-Seiten (z.B.
// data.matricula-online.eu/de/deutschland/aachen/aachen-hl-kreuz/KB+001/?pg=1):
// Das sichtbare Bild liegt in einem Deep-Zoom-Viewer (<canvas>), ABER im
// HTML der Seite (letztes <script> im <body>) steht:
//   dv1 = new arc.imageview.MatriculaDocView("document", {
//     "labels": ["001_0001", ...],
//     "files": ["/image/<base64-kodierte Bild-URL>/", ...]
//   })
// Jeder files-Eintrag ist "/image/" + base64(URL) + "/" und dekodiert z.B.
// zu
//   http://hosted-images.matricula-online.eu/images/matricula/DE-BDAA/
//   images/17%20Matricula/DE_2187_KB_001/DE_2187_KB_001_0002.jpg
// (HTTP 200, image/jpeg - das Original in Scan-Auflösung; https auf dem
//selben Host ist ebenfalls bestätigt erreichbar). labels[i] gehört
// positionell zu files[i], und ?pg=N bezeichnet files[N-1]. Gleicher
// Ansatz wie der HTTP-Scraper matricula-online-scraper (lsg551, PyPI).
// ---------------------------------------------------------------------

function decodeBase64ToUtf8String(raw) {
  // Tolerant gegenüber URL-safe-Alphabet (bei Matricula bisher Standard-
  // base64, aber Schaden gibt es nicht: "-" und "_" kommen im Standard-
  // Alphabet nie vor) und fehlender Padding. Fehler -> null statt Exception.
  let b64 = String(raw).replace(/-/g, "+").replace(/_/g, "/");
  const missingPadding = b64.length % 4;
  if (missingPadding) b64 += "=".repeat(4 - missingPadding);
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return null;
  }
}

// Liefert { imageUrls: (string|null)[], labels: string[] | null } - die
// Positionen in imageUrls entsprechen 1:1 den Einträgen in files (fehl-
// geschlagene Dekodierung -> null an der Stelle), damit der ?pg=N-Index
// später korrekt bleibt.
function extractMatriculaImageUrlsFromDv1(html, baseUrl) {
  const startMatch = /dv1\s*=\s*new\s+arc\.imageview\.MatriculaDocView/i.exec(html);
  if (!startMatch) return null;
  const endIdx = html.indexOf("</script>", startMatch.index);
  const block = html.slice(startMatch.index, endIdx === -1 ? html.length : endIdx);

  const filesMatch = /"files"\s*:\s*(\[[^\]]*\])/i.exec(block);
  if (!filesMatch) return null;

  let files;
  try {
    files = JSON.parse(filesMatch[1]);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(files) || files.length === 0) return null;

  let labels = null;
  const labelsMatch = /"labels"\s*:\s*(\[[^\]]*\])/i.exec(block);
  if (labelsMatch) {
    try {
      const parsed = JSON.parse(labelsMatch[1]);
      if (Array.isArray(parsed)) labels = parsed;
    } catch (e) {
      /* labels sind optional - ohne sie funktioniert das Mapping trotzdem */
    }
  }

  const imageUrls = files.map((entry) => {
    if (typeof entry !== "string") return null;
    let raw = entry;
    if (raw.startsWith("/image/")) raw = raw.slice("/image/".length);
    raw = raw.replace(/\/+$/, "");
    if (!raw) return null;
    const decoded = decodeBase64ToUtf8String(raw);
    if (!decoded) return null;
    return absoluteUrl(decoded, baseUrl) || decoded;
  });

  if (imageUrls.every((u) => !u)) return null;
  return { imageUrls, labels };
}

// Die dekodierten URLs sind http:// - in der https-WikiTree-Seite würde
// ein <img src="http://..."> als Mixed Content behandelt. https auf
// matricula-online.eu-Hosts ist bestätigt erreichbar, also wird bewusst
// hochgestuft; Nicht-Matricula-URLs bleiben unverändert.
function upgradeMatriculaImageUrlToHttps(url) {
  if (/^http:\/\/(?:[a-z0-9-]+\.)*matricula-online\.eu\//i.test(url)) {
    return url.replace(/^http:/i, "https:");
  }
  return url;
}

// ---------------------------------------------------------------------
// Landesarchiv Baden-Württemberg (ofs21-Bildbetrachter, bild_zoom/zoom.php)
// ---------------------------------------------------------------------
// Diese Seiten rendern serverseitig die URL des angezeigten JPEGs in die
// Konfiguration des im Browser laufenden Zoom-Viewers:
//
//   $("#imageViewerContainer4-791354").verySimpleImageViewer({
//       imageSource: 'bild.php?drehen=&zoom=100&gamma=1&jpegQualitaetZoombild=60
//         &scopeid_besta=7883&originalBilddatei=%2Fdata%2Fbildcms%2F...74.jpg',
//
// bild.php liefert den Scan serverseitig gerendert als einzelnes JPEG (keine
// Tiles) und funktioniert OHNE Session-Cookie (ohne Cookie bestätigt:
// HTTP 200, image/jpeg). jpegQualitaetZoombild steuert die JPEG-Qualität des
// Renderers: 60 benutzt der Viewer (~1 MB im Beispiel), 100 liefert dieselbe
// Auflösung mit voller Qualitätsstufe (~4 MB im Beispiel). Der bisherige
// Formular-Download (pdfForm -> download.php) liefert dagegen eine stärker
// komprimierte Kopie (~985 KB) mit unten angehängtem Text-/Typenschild-Balken.
// Deshalb: Vorschau = URL wie auf der Seite, Download = gleiche URL mit
// jpegQualitaetZoombild=100.
//
// Seitenzahl: <select name="originalBilddatei"> enthält ALLE Bilddateien als
// <option value="...jpg">Bild N</option>, die angezeigte ist mit selected
// markiert. "Bild N" ist die Bild-Nr. im Betrachter (so benennt auch der
// Formular-Download die Datei), nicht zwangsläufig eine Registerseitenzahl.
// Dokumenttitel steht in <div id="titel"> als erster <span>-Text
// (z.B. "456 C Nr. 1792, 2 cm"). Die Rechtekategorie (z.B. UND = "Rechte
// unbestimmt") steht als rightsstatements.org-Link im Seitenkopf und wird
// für das Zitat mitgegeben.

function isLandesarchivBwUrl(url) {
  try {
    return /(^|\.)landesarchiv-bw\.de$/i.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

// Dekodiert das '&'-Zeichen in gerenderten Bild-URLs: Die zoom.php-Seiten
// können die Viewer-Konfiguration serverseitig als HTML-Entities (&amp; /
// &#38; / &#x26;) oder JS-kodiert (\u0026) enthalten. Ohne Dekodierung würde
// '&amp;zoom=...' als Parameter-NAME übergeben werden und der Server liefert
// Fehler statt des Scans.
function decodeUrlAmpersands(u) {
  return (u || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/\\u0026/gi, "&");
}

// Landesarchiv-BW-Bild-URLs bewusst auf https anheben (Site sendet HSTS,
// https ist erreichbar): WikiTree läuft https, http-Bild-URLs wären sonst
// Mixed Content und würden vom Browser blockiert (gleicher Gedanke wie
// upgradeMatriculaImageUrlToHttps oben).
function upgradeLandesarchivBwImageUrlToHttps(url) {
  if (/^http:\/\/(?:[a-z0-9-]+\.)*landesarchiv-bw\.de\//i.test(url)) {
    return url.replace(/^http:/i, "https:");
  }
  return url;
}

// Extrahiert aus dem HTML einer bild_zoom-Seite (GET- oder POST-Rendervariante)
// die serverseitig gerenderte bild.php-URL des Scans inkl. Label/Seitenzahl.
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


// ---------------------------------------------------------------------
// Weg 2a-BW, Zweitversuch (Legacy-Rendervariante des Bildbetrachters):
// Der GET-Abruf einer zoom.php-Seite rendert seit dem Server-Update oft
// den JS-getriebenen Legacy-Viewer: Die Bilddatei steht NICHT als
// statische imageSource im HTML, sondern wird erst per Inline-JS aus den
// Formularfeldern gebaut (bild2.php + <img id="ausschnittbild">).
// Der Betrachter blaettert Seiten durch, indem er sein
// <form name="formular" action="zoom.php" method="POST"> mit den Feldern
// abschickt - und GENAU dieses POST rendert die Variante, in der die
// bild.php-URL (imageSource) serverseitig im HTML steht.
// Live am Beispiel-Link verifiziert: Das POST braucht weder Session noch
// Cookies (credentials:"omit" genuegt), die Antwort wird nur fuer die
// Extraktion ausgewertet und aendert nichts dauerhaft am Server.
// ---------------------------------------------------------------------

// Versteckte Felder + Selects des Legacy-Formulars einsammeln. Tolerant
// gegen unquoted Attribute, weil die BW-Seiten teils Legacy-HTML nutzen
// (z.B. width=13 ohne Anfuehrungszeichen).
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

// JPG-Dateinamen aus den originalBilddatei-Optionen (die Betrachter-Seite
// listet alle Seiten des Dokuments als <option value="04_...jpg">Bild N</option>).
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

// Welcher Scan wird aktuell angezeigt? Der GET-Render markiert die Option
// NICHT als selected - verlaesslich ist die URL (gewaehlteSeite=N, wie die
// Betrachter-JS selbst hardcodiert: bilddatei=N). Reihenfolge:
// gewaehlteSeite-URL-Param -> bilddatei=N aus dem Inline-JS -> erste Option.
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

// plink-Format ?f=<archiv>-<bestand>-<bild> (live verifiziert): Der
// plink-Server leitet auf bild_zoom/plink_screen.php weiter; diese
// Seite ist ein JS-Weiterleitungs-Stub (self.location.href = "zoom.php?...")
// zum eigentlichen zoom.php-Betrachter. Die Extension repliziert das,
// indem sie aus der plink_screen-Antwort-URL den zoom.php-Abruf baut
// (gleiche Query-Parameter, plink_screen.php -> zoom.php;
// screenbreite/screenhoehe sind optional - zoom.php antwortet auch
// ohne sie mit der statischen bild.php-Quelle, live geprueft).
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

// ---------------------------------------------------------------------
// Weg 3: wbc.poznan.pl (dLibra, Wielkopolska Digital Library)
// -----------------------------------------------------------------------
// dLibra-Links sehen z.B. so aus:
//   https://www.wbc.poznan.pl/dlibra/publication/147448/edition/156210/content
// Die HTML-Seite selbst enthaelt Dialog-Templates ("Secured publication",
// reCAPTCHA), die auch bei frei zugaenglichen Publikationen im Markup
// liegen - daraus laesst sich KEINE zuverlaessige Aussage ableiten (in
// 0.12.0 fuehrte das zur pauschalen Nichtautomatisierung; live verifiziert:
// die Beispielpublikation ist offen abrufbar und im METS steht
// dlibra_avs:PublicAccess = "true").
//
// Verlaesslicher Weg (live verifiziert): dLibra liefert fuer jede Edition
// METS-XML ueber den eigenen OAI-Endpunkt. Das data-oaiurl-Attribut der
// Content-Seite zeigt das Muster:
//   /dlibra/oai-pmh-repository.xml?verb=GetRecord&metadataPrefix=mets
//     &identifier=oai:<host>:<editionId>
// In den METS: fileSec mit fileGrp USE="original" (file IDs wie
// "DjVu_original<N>" -> FLocat xlink:href = URL von Seite N+1, 0-basiert)
// und structMap; die Gesamtdokument-Datei (dLibra-Konvention: basename
// "index.*") gehoert NICHT zu den Einzelseiten. dmdSec liefert Titel
// (mets LABEL bzw. dc:title), dc:date und dc:rights fuer das Zitat.
//
// Format-Ehrlichkeit: dLibra-Holdings sind oft DjVu (image/x.djvu, live:
// HTTP 200, ~1 MB/Seite). DjVu ist kein <img>-faehiges Format - die
// Vorschau im Panel ist dann bewusst NICHT moeglich (previewUnavailable),
// stattdessen Download-Link der Zielseite mit klarer Erklaerung. Bei
// JPEG-/PNG-Holdings funktioniert Vorschau+Download wie bei Weg 1.
//
// Server-Besonderheit (live beobachtet): Bei Nicht-Browser-UAs antwortet
// wbc.poznan.pl zeitweise mit einer JS-Proof-of-Work-Seite ("High Load -
// Verifying Browser", setzt Cookie captcha_pow). Diese Pruefung wird NICHT
// automatisiert umgangen (gleiche Haltung wie bei Captcha-Sperren):
// erkannt und ehrlich gemeldet. Im normalen Browser (und damit im
// Extension-Fetch mit Browser-UA und Cookie-Jar) ist die Seite normal
// erreichbar; hilft: die Quelle einmal im Browser oeffnen, dann erneut
// pruefen.
// ---------------------------------------------------------------------

function isWbcPoznanDlibraUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)(wbc\.poznan\.pl)$/i.test(u.hostname)) return false;
    return /\/dlibra\//i.test(u.pathname) || /\/Content\/\d+/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

// Editions-ID aus den bekannten dLibra-URL-Formen:
//   /dlibra/publication/<pub>/edition/<ed>/content   -> ed
//   /dlibra/publication/edition/<ed>/...             -> ed (dc:identifier-Variante)
//   /Content/<ed>/... (direkte Datei-/Download-URLs) -> ed
//   /dlibra/docmetadata?id=<ed>&from=edition         -> ed (NUR bei from=edition;
//        bei from=publication ist id eine Publikations-ID und unbrauchbar
//        fuer den edition-bezogenen METS-Abruf)
function extractWbcEditionId(url) {
  try {
    const u = new URL(url);
    const edition = /\/edition\/(\d+)/i.exec(u.pathname);
    if (edition) return edition[1];
    const content = /\/Content\/(\d+)/i.exec(u.pathname);
    if (content) return content[1];
    const idParam = u.searchParams.get("id");
    if (idParam && /^\d+$/.test(idParam) && (u.searchParams.get("from") || "edition") === "edition") {
      return idParam;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Muster aus dem data-oaiurl-Attribut der Content-Seite (live verifiziert
// fuer Edition 156210). Der Identifier nutzt den Host der Anfrage ohne
// Pfad - derselbe Code funktioniert damit auch fuer andere dLibra-Instanzen.
function buildWbcOaiMetsUrl(editionId, requestUrl) {
  try {
    const u = new URL(requestUrl);
    const identifier = `oai:${u.hostname}:${editionId}`;
    return `https://${u.hostname}/dlibra/oai-pmh-repository.xml?verb=GetRecord&metadataPrefix=mets&identifier=${encodeURIComponent(identifier)}`;
  } catch (e) {
    return null;
  }
}

// PoW-Challenge-Seite erkennen ("High Load - Verifying Browser"; kleine
// HTML-Seite, die per JS das Cookie captcha_pow setzt). Nicht loesen,
// nicht umgehen - ehrlich melden.
function looksLikeWbcPowChallenge(body) {
  return /High Load\s*-\s*Verifying Browser/i.test(body || "") || /captcha_pow/i.test(body || "");
}

// ---------------------------------------------------------------------
// URL-Allowlist
// ---------------------------------------------------------------------
// imageUrl/downloadUrl/suggestedUrl stammen aus fremden Daten (METS-XML von
// beliebigen Hosts - tx_dlf[id] in einem DFG-Viewer-Link kann auf jeden
// Server zeigen -, BW-HTML, base64-dekodierte Matricula-URLs; WikiTree-
// Profile kann jeder editieren). Sie landen im Content Script in img.src /
// a.href und hier in chrome.downloads.download. Daher nur http:/https:
// (und data:image/... fuer Canvas-Schnappschuesse, nur wo imageOk=true)
// zulassen - nie javascript:, file:, blob:, chrome-extension: o.ae.
function isSafeExternalUrl(url, { allowDataImage = false } = {}) {
  if (typeof url !== "string" || !url) return false;
  // Nur Rastertypen (kein svg+xml: SVG kann Skripte/externe Referenzen enthalten).
  if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i.test(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

// Prueft die URL-Felder eines FIND_*-Ergebnisses; unzulaessig => ok:false.
function sanitizeFindResult(result) {
  if (!result || typeof result !== "object") return result;
  const bad = (field) => ({
    ok: false,
    reason: `Ergebnis verworfen: unzulässiges URL-Schema in ${field} (nur http/https erlaubt).`
  });
  if (result.imageUrl != null && !isSafeExternalUrl(result.imageUrl, { allowDataImage: true })) return bad("imageUrl");
  if (result.downloadUrl != null && !isSafeExternalUrl(result.downloadUrl, { allowDataImage: true })) return bad("downloadUrl");
  if (result.suggestedUrl != null && !isSafeExternalUrl(result.suggestedUrl)) return bad("suggestedUrl");
  return result;
}

// Text eines XML-Elements, tolerant gegenueber Namespace-Praefix, CDATA
// und eingebetteten Kind-Elementen; Entities werden dekodiert.
// Der uebergebene Name darf ein Praefix enthalten ("dc:title"): Zuerst wird
// das exakte Praefix gesucht (damit z.B. <dc:title> einem <mods:title>
// vorgezogen wird); findet sich dort nichts, passt ein beliebiges Praefix
// (oder keins) vor dem lokalen Namen - METS/OAI-Dokumente binden denselben
// Namespace gern unter anderem Praefix ein. Regex-Sonderzeichen im Namen
// werden escaped.
function extractCdataOrText(xml, tagName) {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tryTag = (nameRe) => {
    const re = new RegExp(`<${nameRe}\\b[^>]*>([\\s\\S]*?)<\\/${nameRe}>`, "i");
    return re.exec(xml || "");
  };
  let m = tryTag(escapeRe(tagName));
  if (!m) {
    const local = tagName.includes(":") ? tagName.slice(tagName.lastIndexOf(":") + 1) : tagName;
    m = tryTag(`(?:[A-Za-z_][\\w.-]*:)?${escapeRe(local)}`);
  }
  if (!m) return null;
  let val = m[1];
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(val);
  if (cdata) val = cdata[1];
  return stripHtmlEntities(val.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() || null;
}

// Titel/Datum/Rechte aus dem METS (dmdSec) - fuer Label und Zitat.
function extractWbcMetaFromMets(xml) {
  // Titel: LABEL-Attribut des <mets>-Elements (identisch mit dc:title),
  // tolerant gegenueber Namespace-Praefix und einfachen Anfuehrungszeichen.
  let title = null;
  const metsOpening = findAllTagOpenings(xml || "", "mets").find((o) => getAttr(o.attrs, "LABEL"));
  if (metsOpening) title = getAttr(metsOpening.attrs, "LABEL");
  if (!title) title = extractCdataOrText(xml, "dc:title");
  return {
    title: title || null,
    date: extractCdataOrText(xml, "dc:date"),
    rights: extractCdataOrText(xml, "dc:rights"),
  };
}

// dlibra_avs:PublicAccess aus dem METS: "true" = frei zugaenglich,
// "false" = geschuetzte Publikation (Zugang nur nach Anfrage/Login).
function extractWbcPublicAccess(xml) {
  const val = extractCdataOrText(xml, "dlibra_avs:PublicAccess");
  return val ? val.toLowerCase() : null;
}

// Seitenliste aus dem fileSec: fileGrp USE="original", file IDs mit
// numerischem Suffix (z.B. DjVu_original7 = Seite 8, 0-basiert).
// Die Gesamtdokument-Datei (dLibra-Konvention: basename "index.*") wird
// ausgeklammert. dLibra-structMaps haben KEIN ORDER-Attribut (live: die
// phys-Divs stehen dort sogar unsortiert) - die ID-Suffixe sind die
// verlaessliche Seitenreihenfolge.
function extractWbcPageFilesFromMets(xml, baseUrl) {
  const groups = extractFileGroups(xml, baseUrl);
  const entries = [];
  let wholeDocumentUrl = null;
  for (const fileId of Object.keys(groups)) {
    const useMap = groups[fileId];
    const url = useMap.ORIGINAL || useMap.original || Object.values(useMap)[0];
    if (!url) continue;
    let base = null;
    try {
      base = new URL(url).pathname.split("/").pop();
    } catch (e) {
      base = null;
    }
    if (base && /^index\./i.test(base)) {
      if (!wholeDocumentUrl) wholeDocumentUrl = url;
      continue;
    }
    const suffix = /(\d+)\s*$/.exec(fileId);
    entries.push({ url, order: suffix ? parseInt(suffix[1], 10) : Number.MAX_SAFE_INTEGER });
  }
  entries.sort((a, b) => a.order - b.order || String(a.url).localeCompare(String(b.url)));
  return { pageUrls: entries.map((e) => e.url), wholeDocumentUrl };
}

function sanitizeForFilesystem(name) {
  // Entfernt/ersetzt Zeichen, die unter Windows/macOS/Linux in Datei-
  // oder Ordnernamen nicht erlaubt sind. Unicode-Buchstaben (ä, ö, ß, …)
  // bleiben erhalten - die sind auf allen gängigen Dateisystemen zulässig.
  const cleaned = (name || "")
    // eslint-disable-next-line no-control-regex -- Steuerzeichen sind in Dateinamen bewusst unzulässig
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  // Windows-reservierte Gerätenamen (CON, NUL, COM1 …) sind als reiner
  // Datei-/Ordnername unzulässig - Präfix voranstellen, statt
  // stillschweigend einen ungültigen Namen zu erzeugen.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) {
    return "_" + cleaned;
  }
  return cleaned || "Quelle";
}

// btoa erwartet einen "binary string" (ein Zeichen pro Byte). Der alte
// Trick `btoa(unescape(encodeURIComponent(s)))` nutzt das deprecated
// unescape() - ersetzt durch TextEncoder, blockweise, um Stack-Limits
// bei sehr langen Strings zu vermeiden.
function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    absoluteUrl,
    getAttr,
    findAllTagOpenings,
    findAllClosingTagPositions,
    parseDfgViewerUrl,
    extractFileGroups,
    extractFileIdsForPage,
    pickBestUrl,
    safeFromCodePoint,
    stripHtmlEntities,
    extractCandidateImageUrlsFromHtml,
    extractPageNumberParam,
    extractTitleTag,
    extractMatriculaMetaFromHtml,
    combineMatriculaLabel,
    decodeBase64ToUtf8String,
    extractMatriculaImageUrlsFromDv1,
    upgradeMatriculaImageUrlToHttps,
    isLandesarchivBwUrl,
    decodeUrlAmpersands,
    upgradeLandesarchivBwImageUrlToHttps,
    extractLandesarchivBwBildSource,
    extractLandesarchivBwLegacyFormFields,
    extractLandesarchivBwJpgOptions,
    extractLandesarchivBwCurrentFile,
    resolveLandesarchivBwPlinkScreenRedirect,
    isWbcPoznanDlibraUrl,
    extractWbcEditionId,
    buildWbcOaiMetsUrl,
    looksLikeWbcPowChallenge,
    isSafeExternalUrl,
    sanitizeFindResult,
    extractCdataOrText,
    extractWbcMetaFromMets,
    extractWbcPublicAccess,
    extractWbcPageFilesFromMets,
    sanitizeForFilesystem,
    utf8ToBase64,
    IMAGE_EXT_RE,
    SKIP_HINTS_RE,
    PREFERRED_USE_ORDER,
  };
}
