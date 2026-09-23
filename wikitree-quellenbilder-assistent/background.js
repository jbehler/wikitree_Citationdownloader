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
 * 2) Matricula (und Fallback für andere Domains): zuerst ein einfacher
 *    HTML-Abruf mit Suche nach <img>-Tags (inkl. Kitodo/dlf-typischer
 *    id/class-Hinweise, auch ohne erkennbare Dateiendung in der URL).
 *    Schlägt das fehl, wird ein Tab mit der Seite geöffnet und kurz aktiv
 *    (!) im Vordergrund gehalten - ein rein im Hintergrund geöffneter Tab
 *    wird von Chrome bei requestAnimationFrame & Co. gedrosselt, wodurch
 *    Deep-Zoom-Viewer (Kachel-Rendering per <canvas>) oft gar nicht erst
 *    zeichnen. Nach der Auswertung wird automatisch zum vorher aktiven Tab
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
 *    - ein neueres, aktiv gepflegtes Projekt kommt rein über HTTP aus, ohne
 *    JS-Ausführung. Das spricht für ein serverseitig gerendertes <img> (nur
 *    vermutlich ohne erkennbare Dateiendung). Falls das nicht greift, zeigt
 *    Matricula in der Praxis einen Deep-Zoom-Viewer mit genau einem
 *    <canvas>-Element - der Hidden/Active-Tab-Snapshot ist der Versuch,
 *    das trotzdem auszulesen; ob das gelingt, hängt davon ab, ob der
 *    Viewer innerhalb der Wartezeit tatsächlich Kacheln zeichnet.
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

// Liest ein Attribut aus einem Attribut-String, tolerant gegenüber
// doppelten UND einfachen Anführungszeichen.
function getAttr(attrString, name) {
  const re = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i");
  const m = re.exec(attrString || "");
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
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
      const hrefMatch =
        /xlink:href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body) ||
        /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
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

function stripHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Best effort: liest die sichtbare Metadaten-Anzeige der DFG-Viewer-Seite
// aus (bestätigtes Element: <dd class="tx-dlf-title">...</dd>). Schlägt
// das fehl, wird einfach kein Label geliefert - kein Abbruch, da das
// Bild selbst schon über die METS-Datei gefunden wurde.
async function fetchDfgViewerTitleLabel(dfgUrl) {
  try {
    const res = await fetch(dfgUrl, { credentials: "omit" });
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
    const res = await fetch(parsed.metsUrl, { credentials: "omit" });
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
// Weg 2: generische HTML-Bild-Suche (z.B. Matricula, unverifiziert)
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

async function fetchAndFindImageGeneric(url) {
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();
    const meta = extractMatriculaMetaFromHtml(html);
    const label = combineMatriculaLabel(meta) || extractTitleTag(html);
    const pageNumber = meta.pageNumber !== null ? meta.pageNumber : extractPageNumberParam(url);
    const candidates = extractCandidateImageUrlsFromHtml(html, url);
    if (candidates.length === 0) {
      return { ok: false, reason: "keine Bild-URL im HTML gefunden (bei Matricula erwartbar, da dynamisch/verschlüsselt geladen)" };
    }
    candidates.sort((a, b) => b.length - a.length);
    return { ok: true, imageUrl: candidates[0], via: "html-guess", label, pageNumber };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FIND_IMAGE_FOR_URL") {
    fetchAndFindImageGeneric(msg.url).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "FIND_IMAGE_FOR_DFG_VIEWER") {
    fetchImageFromDfgViewerLink(msg.url).then(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------
// Weg 3: Matricula-Fallback über einen kurz aktiven Tab
// -----------------------------------------------------------------------
// Wird nur genutzt, wenn der einfache HTML-Abruf (Weg 2) nichts findet.
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FIND_IMAGE_VIA_HIDDEN_TAB") {
    fetchImageViaHiddenTab(msg.url).then(sendResponse);
    return true;
  }
});

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
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "") || "Quelle";
}

async function bulkDownload(payload) {
  const folder = sanitizeForFilesystem(payload.folderName || "WikiTree-Quellen");
  const results = [];

  if (payload.citationsText) {
    try {
      const b64 = btoa(unescape(encodeURIComponent(payload.citationsText)));
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "BULK_DOWNLOAD") {
    bulkDownload(msg.payload).then(sendResponse);
    return true;
  }
});

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
    let res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} beim Laden der Arcinsys-Seite` };
    let html = await res.text();

    let dfgLink = extractDfgViewerLinkFromHtml(html, url);
    if (!dfgLink) {
      // Nicht direkt gefunden -> ggf. über eine "digitalMediaViewer"-
      // Unterseite verlinkt, die separat geladen werden muss.
      const viewerPageUrl = extractDigitalMediaViewerLinkFromHtml(html, url);
      if (viewerPageUrl) {
        const res2 = await fetch(viewerPageUrl, { credentials: "omit" });
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "FIND_DFG_VIEWER_LINK_FROM_ARCINSYS") {
    findDfgViewerLinkFromArcinsys(msg.payload).then(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------
// Landesarchiv Baden-Württemberg (plink): Formular-Submit statt Link
// -----------------------------------------------------------------------
// Diese Seiten bieten keinen direkten Bild-Link, sondern lösen den
// Download über ein per JavaScript abgeschicktes Formular aus
// (bestätigtes Beispiel: <a href="javascript:document.pdfForm.action=
// 'download.php';document.pdfForm.submit();">Bilddatei herunterladen</a>).
// Es gibt hier keinen "Vorschau"-Schritt ohne Nebenwirkung - entweder man
// öffnet einen Tab und lässt das Formular NICHT abschicken (dann weiß man
// nicht, ob der Download klappen wird), oder man schickt es ab und löst
// damit den echten Download aus. Deshalb wird hier bewusst NICHT beim
// "Bildvorschau prüfen" etwas getan (siehe content.js) - der eigentliche
// Formular-Submit passiert erst beim expliziten "gemeinsam
// herunterladen"-Klick, wie bei jedem anderen Download auch.
// ---------------------------------------------------------------------

async function submitFormAndDownload(plinkUrl, folder, suggestedNameBase) {
  let tab = null;

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

    // WICHTIG (Bugfix): onDeterminingFilename feuert typischerweise ERST
    // NACH onCreated (Chrome muss dafür ggf. erst Header wie
    // Content-Disposition auswerten). Der Listener darf deshalb nicht
    // schon entfernt werden, sobald downloadPromise (onCreated) aufgelöst
    // ist - das hätte den eigenen Vorschlag nie wirksam werden lassen und
    // erklärt frühere Fehlschläge (Datei landete unbenannt im
    // Standard-Downloads-Ordner). Stattdessen wird separat auf das
    // tatsächliche Feuern von onDeterminingFilename gewartet (mit
    // Timeout als Sicherheitsnetz, damit der Listener nicht unbegrenzt
    // hängen bleibt, falls der Download aus irgendeinem Grund keinen
    // Dateinamen bestimmt).
    let listenerActive = true;
    const filenameDeterminedPromise = new Promise((resolve) => {
      function onDeterminingFilename(item, suggest) {
        chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
        listenerActive = false;
        const extMatch = /\.[a-z0-9]{2,5}$/i.exec(item.filename || "");
        const ext = extMatch ? extMatch[0] : "";
        const safeFolder = sanitizeForFilesystem(folder);
        const safeBase = sanitizeForFilesystem(suggestedNameBase);
        suggest({ filename: `${safeFolder}/${safeBase}${ext}` });
        resolve(true);
      }
      chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
      setTimeout(() => {
        if (listenerActive) {
          chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
          listenerActive = false;
        }
        resolve(false);
      }, 8000);
    });

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
      return { ok: false, reason: "Formular \"pdfForm\" (bzw. ein Formular mit download.php-Ziel) wurde auf der Seite nicht gefunden." };
    }

    const item = await downloadPromise;
    if (!item) {
      return { ok: false, reason: "Formular wurde abgeschickt, aber innerhalb von 10 Sekunden wurde kein Download registriert." };
    }

    const filenameApplied = await filenameDeterminedPromise;
    if (!filenameApplied) {
      return { ok: true, downloadId: item.id, reason: "Download gestartet, aber der Ordner-/Namensvorschlag griff nicht rechtzeitig - Datei liegt vermutlich im Standard-Downloads-Ordner mit Standard-Namen." };
    }
    return { ok: true, downloadId: item.id };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e2) {
        /* Tab evtl. schon geschlossen */
      }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "SUBMIT_FORM_AND_DOWNLOAD") {
    const { url, folder, suggestedNameBase } = msg.payload || {};
    submitFormAndDownload(url, folder, suggestedNameBase).then(sendResponse);
    return true;
  }
});
