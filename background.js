/**
 * background.js
 * -----------------------------------------------------------------------
 * Service Worker (Manifest V3). Zwei Wege, eine Bild-URL zu finden:
 *
 * 1) DFG-Viewer-Links: Der Viewer selbst wird NICHT abgerufen. Stattdessen
 *    wird die im Link enthaltene METS-XML-Datei direkt beim Archiv geladen
 *    und ausgewertet (fileSec/fileGrp = verfügbare Datei-Varianten,
 *    structMap = welche Datei zu welcher Seitenzahl gehört).
 *
 * 2) Matricula (und Fallback für andere Domains): Die Registerseiten von
 *    data.matricula-online.eu enthalten - serverseitig gerendert, rein per
 *    HTTP abrufbar - im letzten <script> des <body> eine JavaScript-
 *    Variable mit den base64-kodierten Direkt-URLs ALLER Scans des
 *    Kirchenbuchs:
 *      dv1 = new arc.imageview.MatriculaDocView("document", {
 *        "labels": ["001_0001", ...],
 *        "files": ["/image/<base64-kodierte Bild-URL>/", ...]
 *      })
 *    Jeder files-Eintrag dekodiert zu einer direkten JPEG-URL auf
 *    hosted-images.matricula-online.eu (http UND https erreichbar, per
 *    Stichprobe bestätigt) -> Bilder können genau wie bei Landesarchiv
 *    NRW als Original-JPEG angezeigt und heruntergeladen werden. Der
 *    ?pg=N-Parameter der URL entspricht files[N-1].
 *    Schlägt diese Extraktion fehl, greift erst eine generische Suche
 *    nach <img>-Tags im HTML und danach der Folgende Fallback:
 *    Ein Tab mit der Seite wird kurz aktiv (!) im Vordergrund gehalten -
 *    ein rein im Hintergrund geöffneter Tab wird von Chrome bei
 *    requestAnimationFrame & Co. gedrosselt, wodurch Deep-Zoom-Viewer
 *    (Kachel-Rendering per <canvas>) oft gar nicht erst zeichnen. Nach
 *    der Auswertung wird automatisch zum vorher aktiven Tab
 *    zurückgesprungen - das kostet aber einen kurzen, sichtbaren
 *    Tab-Wechsel.
 *
 *    WICHTIG zur Historie (Landesarchiv NRW/METS): Eine erste Version
 *    parste structMap mit einem einzelnen nicht-greedy Regex über
 *    verschachtelte <div>-Elemente hinweg. Bei einer typischen Struktur
 *      <div TYPE="physSequence">
 *        <div TYPE="page" ORDER="1">...</div>
 *        <div TYPE="page" ORDER="2">...</div>
 *        ...
 *      </div>
 *    "verschluckt" ein solcher Regex das ERSTE verschachtelte page-Div in
 *    den (fälschlich zu weit gefassten) Treffer des äußeren physSequence-
 *    Divs – Seite 1 wurde dadurch nie gefunden. Diese Version bestimmt
 *    Div-Grenzen stattdessen über die Positionen aller Öffnungs-/
 *    Schließ-Tags, nicht über einen einzigen verschachtelten Regex-Treffer.
 *    Bestätigt funktionierend (vom Nutzer getestet).
 *
 *    WICHTIG zur Historie (Matricula): Ein älteres Scraper-Projekt brauchte
 *    zur Bild-Ermittlung noch `js2py`, um Matriculas JavaScript auszuführen
 *    - ein neueres, aktiv gepflegtes Projekt (matricula-online-scraper,
 *    lsg551) kommt rein über HTTP aus, ohne JS-Ausführung. Die ursprüngliche
 *    Annahme "serverseitig gerendertes <img>" war dabei falsch: Matricula
 *    zeigt das Bild in einem Deep-Zoom-Viewer (<canvas>) und versteckt die
 *    Direkt-URLs base64-kodiert in der dv1-JavaScript-Variable des HTML
 *    (siehe Weg 2a unten) - genau diese Dekodierung nutzt auch der
 *    HTTP-Scraper. Der Hidden/Active-Tab-Snapshot bleibt nur noch als
 *    letzter Fallback für den Fall, dass die dv1-Extraktion scheitert.
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

// Fetch mit Zeitlimit: Ein hängender Server (oder blockierender Proxy) soll
// die Antwort an den Content-Script nicht unbegrenzt blockieren - ein MV3-
// Service Worker kann sonst inzwischen sogar gekillt werden und die Antwort
// wäre verloren. Besser bewusst abbrechen und verständlich melden.
function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .catch((e) => {
      if (e && e.name === "AbortError") {
        throw new Error(`Timeout nach ${Math.round(timeoutMs / 1000)}s beim Laden von ${url}`);
      }
      throw e;
    })
    .finally(() => clearTimeout(timer));
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

// Best effort: liest die sichtbare Metadaten-Anzeige der DFG-Viewer-Seite
// aus (bestätigtes Element: <dd class="tx-dlf-title">...</dd>). Schlägt
// das fehl, wird einfach kein Label geliefert - kein Abbruch, da das
// Bild selbst schon über die METS-Datei gefunden wurde.
async function fetchDfgViewerTitleLabel(dfgUrl) {
  try {
    const res = await fetchWithTimeout(dfgUrl, { credentials: "omit" });
    if (!res.ok) return null;
    const html = await res.text();
    const m = /<dd[^>]*class=["'][^"']*\btx-dlf-title\b[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i.exec(html);
    if (!m) return null;
    const text = stripHtmlEntities(m[1].replace(/<[^>]+>/g, " "));
    return text || null;
  } catch (e) {
    return null;
  }
}

async function fetchImageFromDfgViewerLink(dfgUrl) {
  const parsed = parseDfgViewerUrl(dfgUrl);
  if (!parsed) {
    return { ok: false, reason: "Konnte METS-URL/Seitenzahl nicht aus dem DFG-Viewer-Link lesen" };
  }
  try {
    const res = await fetchWithTimeout(parsed.metsUrl, { credentials: "omit" });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} beim Laden der METS-Datei (${parsed.metsUrl})` };
    }
    const xml = await res.text();
    const { ids: fileIds, diag } = extractFileIdsForPage(xml, parsed.page);
    if (fileIds.length === 0) {
      return { ok: false, reason: `Keine Datei-Referenz für Seite ${parsed.page} im structMap gefunden. ${diag || ""}`.trim() };
    }
    const fileMap = extractFileGroups(xml, parsed.metsUrl);
    const best = pickBestUrl(fileMap, fileIds);
    if (!best) {
      return { ok: false, reason: `Datei-ID(s) für Seite ${parsed.page} gefunden (${fileIds.join(", ")}), aber keine URL im fileSec zugeordnet.` };
    }
    const titleText = await fetchDfgViewerTitleLabel(dfgUrl);
    return { ok: true, imageUrl: best, via: "mets", label: titleText, pageNumber: parsed.page };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
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

// POST-Renderversuch: repliziert den Formular-Submit des Legacy-Betrachters
// und liefert (falls erfolgreich) das HTML der Variante mit imageSource.
// Scheitert der Versuch still, bleibt der Formular-Download als Rueckfallweg.
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

async function fetchAndFindImageGeneric(url) {
  try {
    const res = await fetchWithTimeout(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const meta = extractMatriculaMetaFromHtml(html);
    const label = combineMatriculaLabel(meta) || extractTitleTag(html);
    const pageNumber = meta.pageNumber !== null ? meta.pageNumber : extractPageNumberParam(url);

    // Landesarchiv BW (Weg 2a-BW): bild_zoom-Seiten rendern die bild.php-URL
    // des aktuellen Scans ins HTML - gleicher Gedanke wie Matriculas dv1.
    // WICHTIG: BW-Seiten dürfen NICHT in die generische <img>-Heuristik
    // fallen (Weg 2b) - sie enthalten viele UI-Grafiken (Logos, Buttons),
    // die dort als falsches "Bild" enden würden. Rendert der GET-Abruf nur
    // die Legacy-Variante (Bilddatei wird erst per Inline-JS gebaut, keine
    // statische imageSource im HTML - live am Beispiel-Link verifiziert),
    // gibt es den Zweitversuch: der Formular-Submit des Betrachters selbst
    // (POST der Felder mit originalBilddatei) rendert die Variante mit
    // serverseitiger bild.php-Quelle, ohne Cookies und ohne Session.
    // Fehlt danach immer noch die imageSource (z.B. andere BW-Seitentypen),
    // brechen wir bewusst ab; content.js fällt dann auf den bekannten
    // Formular-Download-Pfad zurück.
    if (isLandesarchivBwUrl(url)) {
      // Basis für relative bild.php-URLs ist die FINALE Antwort-URL
      // (res.url): gerenderte/plink-Links können serverseitig weiterleiten
      // (z.B. www -> www2, plink -> bild_zoom/zoom.php). Gegen die
      // ORIGINAL-Anfrage aufgelöst würde 'bild.php' in den falschen Pfad
      // landen (z.B. /bild.php statt /ofs21/bild_zoom/bild.php).
      const finalUrl = res.url || url;
      // Zuerst ohne Cookies: Liefert der GET den JS-getriebenen Legacy-
      // Betrachter (keine statische imageSource im HTML), repliziert der
      // Formular-POST des Betrachters die serverseitige Renderung der
      // Variante mit bild.php-Quelle (live verifiziert).
      let bw = extractLandesarchivBwBildSource(html, finalUrl);
      if (!bw) {
        // plink-Format ?f=<archiv>-<bestand>-<bild> (live verifiziert):
        // plink leitet auf einen plink_screen-JS-Stub weiter - den
        // zoom.php-Abruf daraus bauen und dort normal extrahieren
        // (inkl. POST-Renderversuch fuer die Legacy-Variante).
        const plinkZoomUrl = resolveLandesarchivBwPlinkScreenRedirect(html, finalUrl);
        if (plinkZoomUrl) {
          const plinkRes = await fetchWithTimeout(plinkZoomUrl, { credentials: "include" });
          if (plinkRes.ok) {
            const plinkHtml = await plinkRes.text();
            const plinkFinal = plinkRes.url || plinkZoomUrl;
            bw = extractLandesarchivBwBildSource(plinkHtml, plinkFinal);
            if (!bw) {
              const plinkPostHtml = await reRenderLandesarchivBwZoomViaPost(plinkHtml, plinkFinal);
              if (plinkPostHtml) bw = extractLandesarchivBwBildSource(plinkPostHtml, plinkFinal);
            }
          }
        }
      }
      if (!bw) {
        const postHtml = await reRenderLandesarchivBwZoomViaPost(html, finalUrl);
        if (postHtml) bw = extractLandesarchivBwBildSource(postHtml, finalUrl);
      }
      // Letzter Versuch MIT Cookies (credentials "include"): Der browser-
      // seitige Session-/Consent-Cookie (z.B. bestätigter Datenschutzhinweis
      // oder vom Betrachter-JS registrierte Session) kann dafür sorgen,
      // dass der Server die moderne Variante mit statischer imageSource
      // direkt rendert - in diesem Fall genügt der erneute GET ohne
      // POST-Renderversuch.
      let retryBody = null;
      if (!bw) {
        const retryRes = await fetchWithTimeout(url, { credentials: "include" });
        if (retryRes.ok) {
          retryBody = await retryRes.text();
          bw = extractLandesarchivBwBildSource(retryBody, retryRes.url || finalUrl);
        }
      }
      if (bw) {
        return {
          ok: true,
          imageUrl: bw.imageUrl,
          downloadUrl: bw.downloadUrl,
          via: "bw-bild-php",
          label: bw.label || label,
          pageNumber: bw.pageNumber !== null ? bw.pageNumber : pageNumber,
          pageLabel: bw.pageLabel,
          rightsCategory: bw.rightsCategory
        };
      }
      // Server antwortet mit HTTP 200 aber LEEREM Inhalt: Live-Probe bestätigt:
      // das plink-Format ?i=<id> wird nicht mehr aufgelöst (der Server antwortet
      // fuer JEDEN, auch mit Browser-UA und allen Browser-Headern, mit einer
      // leeren Seite - www2/ofs21-Varianten antworten 404). Das Format
      // ?f=<archiv>-<bestand>-<bild> funktioniert noch und wird oben über den
      // plink_screen-Stub aufgelöst. Kein Abrufverfahren kann einen toten
      // ?i-Link auflösen; content.js zeigt deshalb ehrlich den Grund.
      if (html.trim() === "" && (retryBody === null || retryBody.trim() === "")) {
        return {
          ok: false,
          reason:
            "Link antwortet leer (HTTP 200 ohne Inhalt): das plink-Format mit ?i=<id> wird von Landesarchiv BW nicht mehr aufgelöst (der Server antwortet für JEDEN mit einer leeren Seite, auch im Browser) - das plink-Format ?f=<archiv>-<bestand>-<bild> funktioniert noch. Bitte den Quellen-Link auf eine aktuelle Landesarchiv-BW-Digitalisat-Seite (z.B. www2.landesarchiv-bw.de/ofs21/bild_zoom/zoom.php?...) aktualisieren; mit einem aktuellen Link liefert 0.16.1 die Bildvorschau."
        };
      }
      return {
        ok: false,
        reason:
          "Landesarchiv-BW-Seite enthält weder direkt noch über den Formular-POST-Renderversuch eine bild.php-Bildquelle (vermutlich ein Seitentyp ohne Vorschau) - es wird der Formular-Download versucht."
      };
    }

    // Erst der deterministische Matricula-Sonderweg (Weg 2a): dv1-Variable
    // dekodieren -> direkte Original-JPEG-URL, genau wie die METS-Logik
    // beim Landesarchiv NRW. Wichtig: Der Index in files ist strikt
    // positionell (?pg=N -> files[N-1], Reihenfolge der Scans im Register).
    // meta.pageNumber (aktiver Seiten-Link, z.B. "T_197" = Kirchenbuch-
    // Seite 197) ist NICHT der Scan-Index und wird nur fuer die Angabe
    // "Seite N" im Dateinamen bzw. Zitat benutzt. Nur wenn das dv1 nichts
    // liefert, greift die generische <img>-Heuristik (Weg 2b) und als
    // letzte Rettung der Tab-Snapshot.
    const dv1 = extractMatriculaImageUrlsFromDv1(html, url);
    if (dv1) {
      const pgParam = extractPageNumberParam(url);
      const index = pgParam !== null ? pgParam - 1 : 0;
      if (index < 0 || index >= dv1.imageUrls.length) {
        return {
          ok: false,
          reason: `Seite ${pgParam} liegt außerhalb des Kirchenbuchs (das Register enthält ${dv1.imageUrls.length} Scans) - Link/Seitenzahl bitte prüfen.`
        };
      }
      const chosen = dv1.imageUrls[index];
      if (chosen) {
        return {
          ok: true,
          imageUrl: upgradeMatriculaImageUrlToHttps(chosen),
          via: "dv1-html",
          label,
          pageNumber: pageNumber !== null ? pageNumber : (pgParam !== null ? pgParam : 1)
        };
      }
      // bewusst weiterfallen: null-Eintrag an der Zielposition -> Heuristik
    }

    const candidates = extractCandidateImageUrlsFromHtml(html, url);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason:
          "keine Bild-URL im HTML gefunden (dv1-Variable fehlte oder war nicht dekodierbar - bei Matricula unerwartet, bitte Rückmeldung geben)"
      };
    }
    candidates.sort((a, b) => b.length - a.length);
    return { ok: true, imageUrl: candidates[0], via: "html-guess", label, pageNumber };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// ---------------------------------------------------------------------
// Weg 3: Matricula-Fallback über einen kurz aktiven Tab
// -----------------------------------------------------------------------
// Wird nur genutzt, wenn der HTML-Abruf (Weg 2a dv1-Variable und Weg 2b
// generische <img>-Heuristik) nichts findet.
// Matricula zeigt das Bild in der Praxis über einen Deep-Zoom-Viewer mit
// genau einem <canvas>-Element. Ein rein im Hintergrund geöffneter Tab
// wird von Chrome bei requestAnimationFrame & Co. gedrosselt - der Viewer
// zeichnet dann oft gar nicht. Deshalb wird der Tab hier kurz AKTIV
// geöffnet (sichtbarer, kurzer Tab-Wechsel), das Canvas per Stichproben
// abgewartet, bis es nicht mehr (fast) leer ist, und danach zum vorher
// aktiven Tab zurückgesprungen.
//
// Grenzen (ehrlich): Selbst so kann es sein, dass der Viewer innerhalb der
// Wartezeit nicht genug lädt (z.B. bei langsamer Verbindung) - das wird
// dann als Diagnose zurückgegeben statt stillschweigend zu scheitern.
// Und selbst ein erfolgreicher Schnappschuss zeigt nur den sichtbaren
// Bildschirmausschnitt in Bildschirmauflösung, nicht das Original-Digita-
// lisat in voller Auflösung.
// ---------------------------------------------------------------------

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("Timeout beim Laden der Seite"));
      }
    }, timeoutMs || 15000);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        if (!done) {
          done = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function fetchImageViaHiddenTab(url) {
  let newWindow = null;
  let previousWindowId = null;
  try {
    // Größeres eigenes Fenster statt normalem Tab: Viele Deep-Zoom-Viewer
    // füllen ihr <canvas> proportional zur verfügbaren Fenstergröße - ein
    // großes Fenster gibt dem Viewer also mehr Pixel zum Zeichnen und
    // liefert dadurch einen höher aufgelösten Schnappschuss. Das bleibt
    // aber grundsätzlich ein Bildschirm-Schnappschuss, kein Zugriff auf
    // die Originaldatei in tatsächlicher Scan-Auflösung.
    try {
      const current = await chrome.windows.getCurrent();
      previousWindowId = current.id;
    } catch (e) {
      /* ignorieren, dann wird am Ende kein Fenster zurück-fokussiert */
    }

    newWindow = await chrome.windows.create({
      url,
      type: "normal",
      width: 1920,
      height: 1200,
      focused: true // Bestätigt (vom Nutzer getestet): ein unfokussiertes
      // Fenster wird von Chrome genauso gedrosselt wie ein Hintergrund-Tab
      // - das Canvas blieb dabei leer. Fokussiert ist daher notwendig,
      // nicht nur ein "sollte reichen"-Kompromiss.
    });
    const tab = newWindow.tabs && newWindow.tabs[0];
    if (!tab) {
      return { ok: false, reason: "Konnte kein Fenster/Tab für den Schnappschuss öffnen" };
    }

    await waitForTabComplete(tab.id);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        // Hilfsfunktion: prüft per Stichproben, ob ein Canvas noch (fast)
        // leer/einfarbig ist - typischerweise der Fall, solange ein
        // Deep-Zoom-Viewer seine Kacheln noch lädt.
        function sampleIsBlank(canvas) {
          try {
            const ctx = canvas.getContext("2d");
            const w = canvas.width,
              h = canvas.height;
            if (!w || !h) return true;
            const points = 10;
            let first = null;
            for (let i = 0; i < points; i++) {
              const x = Math.max(0, Math.min(w - 1, Math.floor((w / points) * i + w / (points * 2))));
              const y = Math.floor(h / 2);
              const px = ctx.getImageData(x, y, 1, 1).data.join(",");
              if (first === null) first = px;
              else if (px !== first) return false; // Unterschiede gefunden -> nicht leer
            }
            return true;
          } catch (e) {
            return true; // im Zweifel als "noch nicht bereit" behandeln
          }
        }

        function pickBiggestCanvas() {
          const canvases = Array.from(document.querySelectorAll("canvas"));
          if (canvases.length === 0) return null;
          canvases.sort((a, b) => b.width * b.height - a.width * a.height);
          return canvases[0];
        }

        const pageNumber = (() => {
          try {
            const pg = new URLSearchParams(location.search).get("pg");
            return pg ? parseInt(pg, 10) : null;
          } catch (e) {
            return null;
          }
        })();

        // Gleiche Struktur wie bei der schnellen HTML-Methode, hier aber
        // per echtem DOM statt Regex ausgelesen (zuverlässiger).
        function extractMatriculaMetaFromDom() {
          const result = { parish: null, bookType: null, signature: null, pageNumber: null };
          const table = document.querySelector("table.table-register-data");
          if (table) {
            table.querySelectorAll("tr").forEach((tr) => {
              const th = tr.querySelector("th");
              const td = tr.querySelector("td");
              if (!th || !td) return;
              const key = th.textContent.trim();
              const val = td.textContent.trim();
              if (/^Pfarre\/?\s*Ort$/i.test(key)) result.parish = val;
              else if (/^Signatur$/i.test(key)) result.signature = val;
              else if (/^Buchtyp$/i.test(key)) result.bookType = val;
            });
          }
          const active = document.querySelector("a.docview-pagelink.active");
          if (active) {
            const m = /(\d+)\s*$/.exec(active.textContent.trim());
            if (m) result.pageNumber = parseInt(m[1], 10);
          }
          return result;
        }
        const matriculaMeta = extractMatriculaMetaFromDom();

        const imgs = Array.from(document.querySelectorAll("img"));
        const scored = imgs
          .map((img) => ({
            src: img.currentSrc || img.src,
            area: (img.naturalWidth || 0) * (img.naturalHeight || 0)
          }))
          .filter((x) => x.src && x.area > 40000);
        scored.sort((a, b) => b.area - a.area);
        if (scored.length > 0) {
          return { bestImgSrc: scored[0].src, canvasCount: document.querySelectorAll("canvas").length, pageTitle: document.title, pageNumber, matriculaMeta };
        }

        let canvas = pickBiggestCanvas();
        let waitedForCanvasMs = 0;
        const maxWaitForCanvasMs = 6000;
        while (!canvas && waitedForCanvasMs < maxWaitForCanvasMs) {
          await new Promise((r) => setTimeout(r, 500));
          waitedForCanvasMs += 500;
          canvas = pickBiggestCanvas();
        }
        if (!canvas) {
          return {
            bestImgSrc: null,
            canvasCount: 0,
            diagnostic: {
              readyState: document.readyState,
              visibilityState: document.visibilityState,
              title: document.title,
              bodyChildCount: document.body ? document.body.children.length : -1,
              waitedForCanvasMs
            }
          };
        }

        // Aktiv auf Kachel-Inhalt warten statt einer festen Pause:
        // bis zu ~12 Sekunden, alle 600ms geprüft.
        const maxWaitMs = 12000;
        const stepMs = 600;
        let waited = 0;
        let stillBlank = sampleIsBlank(canvas);
        while (stillBlank && waited < maxWaitMs) {
          await new Promise((r) => setTimeout(r, stepMs));
          waited += stepMs;
          stillBlank = sampleIsBlank(canvas);
        }

        try {
          const dataUrl = canvas.toDataURL("image/png");
          return {
            bestImgSrc: dataUrl,
            canvasCount: document.querySelectorAll("canvas").length,
            isCanvasSnapshot: true,
            waitedMs: waited,
            wasStillBlankAtEnd: stillBlank,
            pageTitle: document.title,
            pageNumber,
            matriculaMeta
          };
        } catch (e) {
          return {
            bestImgSrc: null,
            canvasCount: document.querySelectorAll("canvas").length,
            canvasTainted: true,
            canvasError: String(e)
          };
        }
      }
    });

    const data = results && results[0] && results[0].result;
    if (!data) {
      return { ok: false, reason: "Konnte die geladene Seite nicht auswerten" };
    }
    if (data.bestImgSrc && data.isCanvasSnapshot) {
      if (data.wasStillBlankAtEnd) {
        return {
          ok: false,
          reason: `Canvas war auch nach ${Math.round((data.waitedMs || 0) / 1000)}s Wartezeit noch (fast) leer - der Viewer hat die Kacheln in dieser Zeit nicht sichtbar geladen.`
        };
      }
      return {
        ok: true,
        imageUrl: data.bestImgSrc,
        via: "canvas-snapshot",
        caveat: "Schnappschuss des sichtbaren Ausschnitts (Bildschirmauflösung) - nicht das Original-Digitalisat in voller Auflösung.",
        label: (data.matriculaMeta && combineMatriculaLabel(data.matriculaMeta)) || data.pageTitle,
        pageNumber: (data.matriculaMeta && data.matriculaMeta.pageNumber) || data.pageNumber
      };
    }
    if (data.bestImgSrc) {
      return {
        ok: true,
        imageUrl: data.bestImgSrc,
        via: "hidden-tab",
        label: (data.matriculaMeta && combineMatriculaLabel(data.matriculaMeta)) || data.pageTitle,
        pageNumber: (data.matriculaMeta && data.matriculaMeta.pageNumber) || data.pageNumber
      };
    }
    if (data.canvasTainted) {
      return {
        ok: false,
        reason: `Bild wird über <canvas> gezeichnet, aber das Auslesen wurde vom Browser blockiert (Cross-Origin-Schutz: ${data.canvasError}). Das ist eine serverseitige Absicherung, die sich clientseitig nicht sauber umgehen lässt.`
      };
    }
    if (data.canvasCount > 0) {
      return {
        ok: false,
        reason: `Seite zeigt das Bild vermutlich kachelweise über ${data.canvasCount} <canvas>-Element(e) an (Deep-Zoom-Viewer) - daraus lässt sich keine einzelne Bild-URL extrahieren.`
      };
    }
    if (data.diagnostic) {
      const d = data.diagnostic;
      return {
        ok: false,
        reason:
          `Weder <img> noch <canvas> gefunden (auch nach ${Math.round(d.waitedForCanvasMs / 1000)}s Warten). ` +
          `Diagnose: readyState=${d.readyState}, visibilityState=${d.visibilityState}, Titel="${d.title}", ` +
          `Elemente im <body>=${d.bodyChildCount}. Mögliche Ursache: Seite wurde nicht wie erwartet geladen ` +
          `(z.B. Weiterleitung, Fehlerseite, oder serverseitige Bremse bei mehreren schnellen Aufrufen).`
      };
    }
    return { ok: false, reason: "Kein ausreichend großes <img>-Element auf der geladenen Seite gefunden" };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    if (newWindow && newWindow.id) {
      try {
        await chrome.windows.remove(newWindow.id);
      } catch (e2) {
        /* Fenster evtl. schon geschlossen */
      }
    }
    if (previousWindowId) {
      try {
        await chrome.windows.update(previousWindowId, { focused: true });
      } catch (e3) {
        /* ursprüngliches Fenster evtl. inzwischen geschlossen */
      }
    }
  }
}

// ---------------------------------------------------------------------
// Gebündelter Download aller gefundenen Bilder in einen benannten Ordner
// -----------------------------------------------------------------------
// Nutzt die chrome.downloads-API. Ein "/" im filename erzeugt bei Chrome
// einen Unterordner innerhalb des Standard-Download-Verzeichnisses -
// nicht konfigurierbar auf einen beliebigen Pfad (Sicherheitsbeschränkung
// der API), aber ausreichend für "alle Quellen eines Profils in einem
// gemeinsamen, klar benannten Ordner".
// ---------------------------------------------------------------------

function sanitizeForFilesystem(name) {
  // Entfernt/ersetzt Zeichen, die unter Windows/macOS/Linux in Datei-
  // oder Ordnernamen nicht erlaubt sind. Unicode-Buchstaben (ä, ö, ß, …)
  // bleiben erhalten - die sind auf allen gängigen Dateisystemen zulässig.
  const cleaned = (name || "")
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

async function bulkDownload(payload) {
  const folder = sanitizeForFilesystem(payload.folderName || "WikiTree-Quellen");
  const results = [];

  if (payload.citationsText) {
    try {
      const b64 = utf8ToBase64(payload.citationsText);
      await chrome.downloads.download({
        url: `data:text/plain;charset=utf-8;base64,${b64}`,
        filename: `${folder}/Quellenangaben.txt`,
        conflictAction: "uniquify"
      });
    } catch (e) {
      results.push({ ok: false, reason: `Quellenangaben.txt: ${String(e)}` });
    }
  }

  for (const file of payload.files || []) {
    const safeName = sanitizeForFilesystem(file.suggestedName);
    try {
      const id = await chrome.downloads.download({
        url: file.url,
        filename: `${folder}/${safeName}`,
        conflictAction: "uniquify"
      });
      results.push({ ok: true, downloadId: id, filename: safeName });
    } catch (e) {
      results.push({ ok: false, reason: `${safeName}: ${String(e)}` });
    }
  }

  return { folder, results };
}

// ---------------------------------------------------------------------
// Arcinsys-Direktlinks: passenden DFG-Viewer-Link finden und vorschlagen
// -----------------------------------------------------------------------
// Solche Links (z.B. "showArchivalDescriptionDetails") zeigen nur auf das
// Gesamtdokument. Arcinsys-Seiten enthalten aber oft einen Link "In
// DFG-Viewer öffnen", der auf dieselbe METS-Datei verweist wie die
// METS-basierte Bildsuche, die für DFG-Viewer-Links schon funktioniert.
// Wird dieser Link gefunden, wird daraus (zusammen mit einer ggf. aus der
// Quellenbeschreibung bekannten Seitenzahl) ein normaler
// tx_dlf[id]/tx_dlf[page]-Permalink gebaut und über die bereits
// bestehende METS-Logik ausgewertet.
//
// Bekannte Einschränkung: Der "In DFG-Viewer öffnen"-Link kann direkt auf
// der zitierten Seite stehen, oder erst auf einer verlinkten
// "digitalMediaViewer"-Unterseite - beide Fälle werden versucht. Nicht
// getestet: ob Arcinsys-Installationen anderer Bundesländer denselben
// Linktext/dieselbe URL-Struktur verwenden.
// ---------------------------------------------------------------------

function extractDfgViewerLinkFromHtml(html, baseUrl) {
  const re = /href=["']([^"']*dfg-viewer\.de[^"']*)["']/i;
  const m = re.exec(html);
  if (!m) return null;
  return absoluteUrl(stripHtmlEntities(m[1]), baseUrl);
}

function extractDigitalMediaViewerLinkFromHtml(html, baseUrl) {
  const re = /href=["']([^"']*digitalMediaViewer[^"']*)["']/i;
  const m = re.exec(html);
  if (!m) return null;
  return absoluteUrl(stripHtmlEntities(m[1]), baseUrl);
}

function extractMetsUrlFromDfgLink(dfgLinkUrl) {
  try {
    const u = new URL(dfgLinkUrl);
    return u.searchParams.get("tx_dlf[id]") || u.searchParams.get("set[mets]") || null;
  } catch (e) {
    return null;
  }
}

async function findDfgViewerLinkFromArcinsys(payload) {
  const { url, pageNumber } = payload;
  try {
    let res = await fetchWithTimeout(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} beim Laden der Arcinsys-Seite` };
    let html = await res.text();

    let dfgLink = extractDfgViewerLinkFromHtml(html, url);
    if (!dfgLink) {
      // Nicht direkt gefunden -> ggf. über eine "digitalMediaViewer"-
      // Unterseite verlinkt, die separat geladen werden muss.
      const viewerPageUrl = extractDigitalMediaViewerLinkFromHtml(html, url);
      if (viewerPageUrl) {
        const res2 = await fetchWithTimeout(viewerPageUrl, { credentials: "omit" });
        if (res2.ok) {
          html = await res2.text();
          dfgLink = extractDfgViewerLinkFromHtml(html, viewerPageUrl);
        }
      }
    }

    if (!dfgLink) {
      return { ok: false, reason: "Konnte auf der Arcinsys-Seite keinen \"In DFG-Viewer öffnen\"-Link finden." };
    }

    const metsUrl = extractMetsUrlFromDfgLink(dfgLink);
    if (!metsUrl) {
      return { ok: false, reason: `DFG-Viewer-Link gefunden, aber keine METS-URL darin erkannt (${dfgLink}).` };
    }

    const suggestedUrl =
      `https://dfg-viewer.de/show?tx_dlf%5Bid%5D=${encodeURIComponent(metsUrl)}` +
      (pageNumber ? `&tx_dlf%5Bpage%5D=${encodeURIComponent(String(pageNumber))}` : "");

    if (pageNumber) {
      // Seitenzahl bekannt -> gleich die bereits bewährte METS-Logik nutzen,
      // um direkt ein Bild mitzuliefern.
      const imageResult = await fetchImageFromDfgViewerLink(suggestedUrl);
      return { ok: imageResult.ok, suggestedUrl, ...imageResult };
    }

    return { ok: false, suggestedUrl, reason: "Passender DFG-Viewer-Link gefunden, aber keine Seitenzahl aus der Quellenbeschreibung bekannt - Quelle übernehmen und im Viewer die richtige Seite wählen." };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// ---------------------------------------------------------------------
// Landesarchiv Baden-Württemberg (plink): Formular-Submit als Fallback
// -----------------------------------------------------------------------
// Seit 0.16.0 wird für bild_zoom-Seiten zuerst die direkt im HTML
// gerenderte bild.php-Bildquelle benutzt (siehe extractLandesarchivBwBild-
// Source) - dort läuft Vorschau und Download ohne Formular. Dieser
// Formular-Weg bleibt als Fallback für BW-Links ohne bild.php-Quelle:
// Diese Seiten lösen den Download über ein per JavaScript abgeschicktes
// Formular aus
// (bestätigtes Beispiel: <a href="javascript:document.pdfForm.action=
// 'download.php';document.pdfForm.submit();">Bilddatei herunterladen</a>).
// Ein Formular-Submit ist selbst schon der eigentliche Download-Trigger -
// deshalb passiert der Submit hier bewusst erst beim expliziten
// "gemeinsam herunterladen"-Klick, nicht schon bei der reinen
// Bildvorschau-Prüfung (siehe content.js).
// ---------------------------------------------------------------------

async function submitFormAndDownload(plinkUrl, folder, suggestedNameBase) {
  let tab = null;
  let removeFilenameListener = null; // Cleanup für den onDeterminingFilename-Listener

  try {
    tab = await chrome.tabs.create({ url: plinkUrl, active: false });
    await waitForTabComplete(tab.id);

    const downloadPromise = new Promise((resolve) => {
      const createdListener = (item) => {
        chrome.downloads.onCreated.removeListener(createdListener);
        resolve(item);
      };
      chrome.downloads.onCreated.addListener(createdListener);
      setTimeout(() => {
        chrome.downloads.onCreated.removeListener(createdListener);
        resolve(null);
      }, 10000);
    });

    // WICHTIG (Bugfix 0.13.1, in 0.14.0 verfeinert): onDeterminingFilename
    // feuert typischerweise ERST NACH onCreated (Chrome muss dafür ggf.
    // erst Header wie Content-Disposition auswerten). Der Listener darf
    // deshalb nicht schon entfernt werden, sobald downloadPromise
    // (onCreated) aufgelöst ist - das hätte den eigenen Vorschlag nie
    // wirksam werden lassen und erklärt frühere Fehlschläge (Datei landete
    // unbenannt im Standard-Downloads-Ordner).
    //
    // Verfeinerung 0.14.0: Der Listener wird weiterhin VOR dem Submit
    // registriert, aber der 8-Sekunden-Sicherheitsnetz-Timeout startet jetzt
    // erst, wenn der Download tatsächlich registriert wurde - vorher hätte
    // der Timeout den Listener löschen können, während der Download bei
    // einem langsamen Server noch gar nicht anlief. Zusätzlich wird der
    // Listener auf ALLEN Abbruchwegen aufgeräumt (kein Formular, kein
    // Download, Fehler), damit er nicht unnötig registriert bleibt.
    let filenameListenerActive = true;
    let filenameTimeoutId = null;
    let resolveFilenameDetermination = null;
    const filenameDeterminedPromise = new Promise((resolve) => {
      resolveFilenameDetermination = resolve;
    });
    function onDeterminingFilename(item, suggest) {
      chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
      filenameListenerActive = false;
      if (filenameTimeoutId) clearTimeout(filenameTimeoutId);
      const extMatch = /\.[a-z0-9]{2,5}$/i.exec(item.filename || "");
      const ext = extMatch ? extMatch[0] : "";
      const safeFolder = sanitizeForFilesystem(folder);
      const safeBase = sanitizeForFilesystem(suggestedNameBase);
      suggest({ filename: `${safeFolder}/${safeBase}${ext}` });
      resolveFilenameDetermination(true);
    }
    chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
    removeFilenameListener = () => {
      if (filenameTimeoutId) clearTimeout(filenameTimeoutId);
      if (filenameListenerActive) {
        chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
        filenameListenerActive = false;
      }
    };

    const execResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const forms = Array.from(document.forms);
        const target = forms.find((f) => f.name === "pdfForm") || forms.find((f) => /download\.php/i.test(f.action || ""));
        if (!target) return { submitted: false };
        try {
          target.action = "download.php";
        } catch (e) {
          /* falls schreibgeschützt: ursprüngliche action beibehalten und trotzdem absenden */
        }
        target.submit();
        return { submitted: true };
      }
    });

    const submitted = !!(execResult && execResult[0] && execResult[0].result && execResult[0].result.submitted);
    if (!submitted) {
      removeFilenameListener();
      return { ok: false, reason: "Formular \"pdfForm\" (bzw. ein Formular mit download.php-Ziel) wurde auf der Seite nicht gefunden." };
    }

    const item = await downloadPromise;
    if (!item) {
      removeFilenameListener();
      return { ok: false, reason: "Formular wurde abgeschickt, aber innerhalb von 10 Sekunden wurde kein Download registriert." };
    }

    // Sicherheitsnetz-Timeout erst ab jetzt: Der Download ist registriert,
    // jetzt darf 8s lang auf die Dateinamens-Bestimmung gewartet werden.
    if (filenameListenerActive) {
      filenameTimeoutId = setTimeout(() => {
        if (filenameListenerActive) {
          chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
          filenameListenerActive = false;
        }
        resolveFilenameDetermination(false);
      }, 8000);
    }

    const filenameApplied = await filenameDeterminedPromise;
    if (filenameTimeoutId) clearTimeout(filenameTimeoutId);
    if (!filenameApplied) {
      return { ok: true, downloadId: item.id, reason: "Download gestartet, aber der Ordner-/Namensvorschlag griff nicht rechtzeitig - Datei liegt vermutlich im Standard-Downloads-Ordner mit Standard-Namen." };
    }
    return { ok: true, downloadId: item.id };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    if (removeFilenameListener) removeFilenameListener();
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e2) {
        /* Tab evtl. schon geschlossen */
      }
    }
  }
}

// Ein zentraler Message-Handler statt fünf separater addListener-Blöcke:
// gleiche Semantik (sendResponse + return true für die asynchrone Antwort),
// aber alle unterstützten Nachrichtentypen an einem Ort sichtbar.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  switch (msg.type) {
    case "FIND_IMAGE_FOR_URL":
      fetchAndFindImageGeneric(msg.url).then(sendResponse);
      return true;
    case "FIND_IMAGE_FOR_DFG_VIEWER":
      fetchImageFromDfgViewerLink(msg.url).then(sendResponse);
      return true;
    case "FIND_IMAGE_VIA_HIDDEN_TAB":
      fetchImageViaHiddenTab(msg.url).then(sendResponse);
      return true;
    case "BULK_DOWNLOAD":
      bulkDownload(msg.payload).then(sendResponse);
      return true;
    case "FIND_DFG_VIEWER_LINK_FROM_ARCINSYS":
      findDfgViewerLinkFromArcinsys(msg.payload).then(sendResponse);
      return true;
    case "SUBMIT_FORM_AND_DOWNLOAD": {
      const { url, folder, suggestedNameBase } = msg.payload || {};
      submitFormAndDownload(url, folder, suggestedNameBase).then(sendResponse);
      return true;
    }
    default:
      return undefined;
  }
});
