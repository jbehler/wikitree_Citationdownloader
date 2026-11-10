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

// Reine Parser/Hilfsfunktionen liegen in lib/parsers.js (per Node testbar).
// importScripts ist in MV3-Service-Workern ohne type:module erlaubt, läuft
// synchron und MUSS auf oberster Ebene beim ersten Start stehen (nicht in
// einem async-Callback) - und zwar vor allen Listener-Registrierungen weiter
// unten (u.a. chrome.downloads.onDeterminingFilename, das synchron beim
// Start registriert sein muss).
importScripts("lib/parsers.js");

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

// Hauptlogik fuer FIND_IMAGE_FOR_WBC_DLIBRA.
// payload: { url, pageNumber } - pageNumber kommt aus der Seitenzahl-
// Erkennung der Quellenbeschreibung (citedPageHint) oder ist null (=1).
async function findImageFromWbcDlibra(payload) {
  const url = payload && payload.url;
  const pageNumber = payload && payload.pageNumber;
  if (!isWbcPoznanDlibraUrl(url)) {
    return { ok: false, reason: "Keine dLibra-URL von wbc.poznan.pl erkannt." };
  }
  const editionId = extractWbcEditionId(url);
  if (!editionId) {
    return {
      ok: false,
      reason:
        "Keine Editions-ID in der dLibra-URL erkannt (erwartet: /dlibra/publication/<id>/edition/<edId>/content oder /Content/<edId>/...). Bitte den Quellen-Link auf die Inhaltsseite der Edition verwenden."
    };
  }
  const metsUrl = buildWbcOaiMetsUrl(editionId, url);
  if (!metsUrl) return { ok: false, reason: "Konnte die OAI-METS-URL nicht bauen." };

  let res;
  try {
    // credentials: "include" - der Server setzt gelegentlich ein Prüf-Cookie
    // (captcha_pow), das im Cookie-Jar des Nutzers liegt, sobald er die
    // Seite im Browser geöffnet hat. Damit läuft der Abruf wie im Browser.
    res = await fetchWithTimeout(metsUrl, { credentials: "include" });
  } catch (e) {
    return { ok: false, reason: `Fehler beim Laden der METS-Datei: ${String(e)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status} beim Laden der METS-Datei (${metsUrl})` };
  }
  const xml = await res.text();
  if (looksLikeWbcPowChallenge(xml)) {
    return {
      ok: false,
      reason:
        'Der Server von wbc.poznan.pl verlangt gerade eine JavaScript-Browserprüfung ("High Load - Verifying Browser"). Diese wird bewusst nicht automatisiert umgangen: Bitte die Quelle einmal normal im Browser öffnen (dabei setzt der Server sein Prüf-Cookie) und danach die Prüfung hier erneut starten.'
    };
  }
  // OAI-Fehler (z.B. idDoesNotExist) sauber abfangen statt still zu scheitern.
  const oaiError = /<error\s+code=["']([a-zA-Z]+)["']/i.exec(xml);
  if (oaiError) {
    return {
      ok: false,
      reason: `OAI-Fehler (${oaiError[1]}) für Edition ${editionId} - stimmt die Editions-ID im Quellen-Link?`
    };
  }
  if (!/<(?:\w+:)?mets\b/i.test(xml)) {
    return { ok: false, reason: `Keine METS-Daten für Edition ${editionId} erhalten (unerwartete Antwort).` };
  }
  const access = extractWbcPublicAccess(xml);
  if (access && /^false$/.test(access)) {
    return {
      ok: false,
      reason:
        'Diese Publikation ist bei wbc.poznan.pl als nicht öffentlich markiert (PublicAccess=false, "Secured publication", Zugang nur nach Anfrage/reCAPTCHA). Das wird bewusst nicht automatisiert umgangen - bitte im Browser öffnen bzw. beim Institut um Zugang bitten und manuell herunterladen.'
    };
  }
  const pages = extractWbcPageFilesFromMets(xml, res.url || metsUrl);
  const meta = extractWbcMetaFromMets(xml);
  const pageCount = pages.pageUrls.length;

  // Seitenwahl: pageNumber (aus der Quellenbeschreibung) oder Seite 1.
  const page = pageNumber && Number.isFinite(pageNumber) ? pageNumber : 1;
  let chosenUrl = page >= 1 && page <= pageCount ? pages.pageUrls[page - 1] : null;
  let usedWholeDocument = false;
  if (!chosenUrl && pageCount === 0 && pages.wholeDocumentUrl) {
    // Editionen ohne Einzelseiten (z.B. nur das Gesamtdokument als PDF/DjVu)
    chosenUrl = pages.wholeDocumentUrl;
    usedWholeDocument = true;
  }
  if (!chosenUrl) {
    return {
      ok: false,
      reason:
        pageCount > 0
          ? `Seite ${page} liegt außerhalb der Edition (die Edition enthält ${pageCount} Einzelseiten) - Link/Seitenzahl bitte prüfen.`
          : "In den METS-Daten der Edition wurden weder Einzelseiten noch eine Gesamtdokument-Datei gefunden."
    };
  }

  const base = {
    ok: true,
    imageUrl: chosenUrl,
    downloadUrl: chosenUrl,
    label: meta.title || null,
    pageNumber: usedWholeDocument ? null : page,
    pageCount,
    rightsHolder: meta.rights || null,
  };

  if (IMAGE_EXT_RE.test(chosenUrl)) {
    // JPEG/PNG/etc. -> Vorschau+Download wie bei den METS-Quellen des
    // DFG-Viewers (Weg 1).
    return { ...base, via: "dlibra-oai-mets" };
  }

  // DjVu (image/x.djvu, dLibra-Standard fuer gescannte Verlustlisten etc.):
  // Browser zeigen DjVu nativ NICHT an - eine <img>-Vorschau waere kaputt.
  // Bewusst ehrlich: keine Vorschau, dafuer Download der Zielseite.
  return {
    ...base,
    via: "dlibra-djvu",
    previewUnavailable: true,
    caveat:
      "Die Seite liegt als DjVu-Datei vor (kein vom Browser direkt anzeigbares Bildformat) - Vorschau im Panel daher nicht möglich. Der Download-Link liefert die .djvu-Datei der Zielseite (mit z.B. DjVuViewer oder GIMP öffnen und als JPEG speichern)."
  };
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
    if (!file || !isSafeExternalUrl(file.url, { allowDataImage: true })) {
      results.push({ ok: false, reason: `${safeName}: unzulässiges URL-Schema (nur http/https erlaubt)` });
      continue;
    }
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

// -----------------------------------------------------------------------
// Zentrale Dateinamen-Bestimmung für Formular-Downloads (persistent)
// -----------------------------------------------------------------------
// Chrome-Vertrag (developer.chrome.com, downloads.onDeterminingFilename):
//  - "Each extension may not register more than one listener for this
//    event."
//  - "Each listener must call suggest exactly once, either synchronously
//    or asynchronously. If the listener calls suggest asynchronously,
//    then it must return true. If the listener neither calls suggest
//    synchronously nor returns true, then suggest will be called
//    automatically."
// Der bisher dynamische, pro submitFormAndDownload-Lauf registrierte
// Listener verstieß in Randfällen gegen genau das: zwei überlappende
// Läufe registrierten zwei Listener (=> doppelter suggest-Aufruf) und
// verspätet ausgelieferte Ereignisse (schnelle Downloads, Service-Worker-
// Neustart) trafen einen bereits abgeschlossenen suggest-Zustand. Das
// ergab in der Konsole: "Unchecked runtime.lastError: Unexpected
// determineFilename call". Zusätzlich benannte der alte Listener JEDEN
// Download im Browser um, der während des Laufs startete - auch fremde.
//
// Seit 0.17.1: genau EIN persistenter Listener, synchron beim
// Service-Worker-Start registriert. Er greift nur für Downloads, die
// nachweislich aus einem unserer Formular-Läufe stammen:
//  1. ID-Abgleich - die Download-ID kam vorher über onCreated herein
//     (onDeterminingFilename feuert typischerweise ERST NACH onCreated,
//     Bugfix 0.13.1/0.14.0),
//  2. Fallback für den Fall "Bestimmung feuert VOR onCreated": der erste
//     noch erwartete Download desselben Hosts wie die geöffnete plink-
//     Seite.
// Downloads mit byExtensionId (eigene chrome.downloads.download-Aufrufe
// tragen ihren Dateinamen bereits als Parameter; auch fremde Extensions)
// werden nie angetastet. Für alle anderen Downloads wird suggest NICHT
// gerufen - Chrome ruft es dann automatisch ohne Argumente auf
// (Standard-Dateiname, kein lastError).

let activePlinkFormFlows = [];

function claimPlinkFormFlowForItem(item) {
  if (item.byExtensionId) return null;
  for (const flow of activePlinkFormFlows) {
    if (flow.itemIds.has(item.id)) return flow;
  }
  const expecting = activePlinkFormFlows.filter((f) => f.expectingFirstDownload);
  if (expecting.length === 1 && expecting[0].origin && item.url && item.url.indexOf(expecting[0].origin) === 0) {
    return expecting[0];
  }
  return null;
}

function onDeterminingFilenameGlobal(item, suggest) {
  const flow = claimPlinkFormFlowForItem(item);
  if (!flow) return; // kein eigener Download -> suggest() automatisch durch Chrome (Standard-Name)
  flow.itemIds.add(item.id);
  flow.expectingFirstDownload = false;
  const extMatch = /\.[a-z0-9]{2,5}$/i.exec(item.filename || "");
  const ext = extMatch ? extMatch[0] : "";
  suggest({ filename: `${sanitizeForFilesystem(flow.folder)}/${sanitizeForFilesystem(flow.suggestedNameBase)}${ext}` });
  if (flow.resolveFilenameDetermination) {
    const resolve = flow.resolveFilenameDetermination;
    flow.resolveFilenameDetermination = null;
    resolve(true);
  }
}

chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilenameGlobal);

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
  let flow = null;

  try {
    let plinkOrigin = "";
    try {
      plinkOrigin = new URL(plinkUrl).origin;
    } catch (e) {
      /* URL nicht parsebar -> Fallback der Bestimmung läuft nur über den ID-Abgleich */
    }

    tab = await chrome.tabs.create({ url: plinkUrl, active: false });
    await waitForTabComplete(tab.id);

    // WICHTIG (Bugfix 0.13.1, in 0.14.0 verfeinert, seit 0.17.1 global):
    // onDeterminingFilename feuert typischerweise ERST NACH onCreated
    // (Chrome muss dafür ggf. erst Header wie Content-Disposition
    // auswerten). Der Listener selbst ist jetzt persistent (siehe oben) -
    // hier wird nur der Anspruch für genau diesen Formular-Download
    // registriert. onCreated liefert die Download-ID, damit der globale
    // Listener den eigenen Download sicher erkennen kann; der 8-Sekunden-
    // Sicherheitsnetz-Timeout startet weiterhin erst, wenn der Download
    // tatsächlich registriert wurde.
    flow = {
      folder,
      suggestedNameBase,
      origin: plinkOrigin,
      itemIds: new Set(),
      expectingFirstDownload: true,
      resolveFilenameDetermination: null,
    };
    activePlinkFormFlows.push(flow);
    const filenameDeterminedPromise = new Promise((resolve) => {
      flow.resolveFilenameDetermination = resolve;
    });

    const downloadPromise = new Promise((resolve) => {
      const createdListener = (item) => {
        chrome.downloads.onCreated.removeListener(createdListener);
        // onCreated feuert für ALLE Downloads im Browser - übernommen wird
        // nur der eigene (gleicher Host wie die plink-Seite, nicht per
        // downloads-API gestartet); bei fremden wird weiter gewartet.
        // Gibt es MEHRERE noch erwartende Läufe (überlappende Aufrufe),
        // ist keine eindeutige Zuordnung möglich: der Lauf wird trotzdem
        // aufgelöst (ehrliche Meldung "Vorschlag griff nicht"), aber ohne
        // den Anspruch - kein falsches Umbenennen.
        if (flow) {
          if (item.byExtensionId) return;
          if (flow.origin && item.url && item.url.indexOf(flow.origin) !== 0) return;
          const expectingCount = activePlinkFormFlows.filter((f) => f.expectingFirstDownload).length;
          if (expectingCount === 1) {
            flow.itemIds.add(item.id);
            flow.expectingFirstDownload = false;
          }
        }
        resolve(item);
      };
      chrome.downloads.onCreated.addListener(createdListener);
      setTimeout(() => {
        chrome.downloads.onCreated.removeListener(createdListener);
        resolve(null);
      }, 10000);
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

    // Sicherheitsnetz-Timeout erst ab jetzt: Der Download ist registriert,
    // jetzt darf 8s lang auf die Dateinamens-Bestimmung gewartet werden.
    const filenameTimeoutId = setTimeout(() => {
      if (flow.resolveFilenameDetermination) {
        const resolve = flow.resolveFilenameDetermination;
        flow.resolveFilenameDetermination = null;
        resolve(false);
      }
    }, 8000);

    const filenameApplied = await filenameDeterminedPromise;
    clearTimeout(filenameTimeoutId);
    if (!filenameApplied) {
      return { ok: true, downloadId: item.id, reason: "Download gestartet, aber der Ordner-/Namensvorschlag griff nicht rechtzeitig - Datei liegt vermutlich im Standard-Downloads-Ordner mit Standard-Namen." };
    }
    return { ok: true, downloadId: item.id };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    if (flow) {
      activePlinkFormFlows = activePlinkFormFlows.filter((f) => f !== flow);
      if (flow.resolveFilenameDetermination) {
        const resolve = flow.resolveFilenameDetermination;
        flow.resolveFilenameDetermination = null;
        resolve(false);
      }
    }
    if (tab && tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e2) {
        /* Tab evtl. schon geschlossen */
      }
    }
  }
}

// ---------------------------------------------------------------------
// person_id per WikiTree-API
// ---------------------------------------------------------------------
// Die Upload-Seite (Special:UploadPhoto&person_id=<Id>) braucht die numerische
// Id, die auf der Profilseite nicht verlässlich im DOM steht. Die offizielle
// API liefert sie (getProfile, Feld "Id"). Der Abruf läuft im Service Worker
// (host_permissions api.wikitree.com), ohne Cookies (credentials "omit") und
// MIT appId (laut API-Doku Pflicht, sonst strenge Rate-Limits). Erfolge
// werden im Worker-Speicher gecacht (geht beim Neustart des Workers
// verloren - harmlos, ein Abruf kostet nur eine Anfrage). Fehler werden
// NICHT gecacht, damit z. B. "Limit exceeded." später erneut versucht wird.
const personIdCache = new Map();

async function getWikiTreePersonId(wikiTreeId) {
  const apiUrl = buildWikiTreeApiProfileUrl(wikiTreeId);
  if (!apiUrl) return { ok: false, reason: "Keine gültige WikiTree-ID" };
  if (personIdCache.has(wikiTreeId)) return { ok: true, personId: personIdCache.get(wikiTreeId) };
  try {
    const res = await fetchWithTimeout(apiUrl, { credentials: "omit" });
    if (!res.ok) return { ok: false, reason: `WikiTree-API: HTTP ${res.status}` };
    let json;
    try {
      json = await res.json();
    } catch (e) {
      return { ok: false, reason: "WikiTree-API: Antwort ist kein JSON" };
    }
    const parsed = parseWikiTreeApiPersonId(json);
    if (parsed.ok) personIdCache.set(wikiTreeId, parsed.personId);
    return parsed;
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------------
// Upload-Vorbelegung: "pending uploads" in chrome.storage.session
// ---------------------------------------------------------------------
// storage.session liegt nur im Arbeitsspeicher (weg beim Browser-Ende) und
// ist standardmäßig nur für vertrauenswürdige Kontexte (Service Worker)
// zugänglich: Der Background schreibt/liest, das Content Script fragt per
// Message. Key pro personId, Wert = Liste von Einträgen; Einträge älter
// als 1 h werden verworfen. Schreibzugriffe laufen seriell (Promise-Kette),
// damit zwei schnell aufeinanderfolgende Klicks sich nicht überschreiben
// (read-modify-write).
let pendingUploadQueue = Promise.resolve();

function withPendingLock(fn) {
  const run = pendingUploadQueue.then(fn, fn);
  pendingUploadQueue = run.catch(() => {});
  return run;
}

function pendingKey(personId) {
  return `pending:${personId}`;
}

async function readPendingList(personId) {
  const key = pendingKey(personId);
  const stored = await chrome.storage.session.get(key);
  return prunePendingUploads(stored[key], Date.now());
}

function isValidPersonId(personId) {
  return typeof personId === "string" && /^\d+$/.test(personId);
}

function storePendingUpload(msg) {
  const checked = validatePendingUploadInput(msg);
  if (!checked.ok) return Promise.resolve({ ok: false, reason: checked.reason });
  return withPendingLock(async () => {
    try {
      const list = await readPendingList(msg.personId);
      // Gleiche Bild-URL erneut: alten Eintrag ersetzen statt doppelt listen.
      const rest = list.filter((e) => e.url !== checked.entry.url);
      rest.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...checked.entry });
      const limited = rest.slice(-PENDING_UPLOAD_MAX_ENTRIES);
      await chrome.storage.session.set({ [pendingKey(msg.personId)]: limited });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  });
}

async function getPendingUploads(personId) {
  if (!isValidPersonId(personId)) return { ok: false, reason: "Ungültige personId", uploads: [] };
  try {
    const uploads = await withPendingLock(() => readPendingList(personId));
    return { ok: true, uploads };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e), uploads: [] };
  }
}

function removePendingUpload(personId, id) {
  if (!isValidPersonId(personId) || typeof id !== "string") {
    return Promise.resolve({ ok: false, reason: "Ungültige Anfrage" });
  }
  return withPendingLock(async () => {
    try {
      const list = await readPendingList(personId);
      await chrome.storage.session.set({ [pendingKey(personId)]: list.filter((e) => e.id !== id) });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  });
}

// Lädt die Bilddatei für das Dateifeld der Upload-Seite. Das Content Script
// (Seite wikitree.com) könnte fremde Archive wegen CORS nicht selbst laden;
// der Worker darf das dank host_permissions. Es wird nur geladen, was als
// pending upload der personId gespeichert wurde (kein offener Proxy für
// beliebige URLs). Strenge Prüfung: nur Rasterbilder, max. 10 MB.
async function fetchUploadFile(msg) {
  const url = msg && msg.url;
  if (!isSafeExternalUrl(url, { allowDataImage: true })) return { ok: false, reason: "Unzulässige Bild-URL" };
  const pending = await getPendingUploads(msg.personId);
  if (!pending.ok || !pending.uploads.some((e) => e.url === url)) {
    return { ok: false, reason: "Bild ist nicht (mehr) in der Upload-Liste" };
  }
  try {
    const res = await fetchWithTimeout(url, { credentials: "include" }, 60000);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} beim Laden der Bilddatei` };
    const type = normalizeUploadContentType(res.headers.get("content-type"));
    if (!type) {
      return { ok: false, reason: `Kein unterstütztes Bildformat (Content-Type: ${res.headers.get("content-type") || "unbekannt"}; erlaubt: JPEG, PNG, GIF, WebP)` };
    }
    const declared = parseInt(res.headers.get("content-length") || "", 10);
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
      return { ok: false, reason: "Datei größer als 10 MB" };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > UPLOAD_MAX_BYTES) return { ok: false, reason: "Datei größer als 10 MB" };
    return { ok: true, contentType: type, base64: arrayBufferToBase64(buf) };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// Ein zentraler Message-Handler statt fünf separater addListener-Blöcke:
// gleiche Semantik (sendResponse + return true für die asynchrone Antwort),
// aber alle unterstützten Nachrichtentypen an einem Ort sichtbar.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  switch (msg.type) {
    case "FIND_IMAGE_FOR_URL":
      fetchAndFindImageGeneric(msg.url).then((r) => sendResponse(sanitizeFindResult(r)));
      return true;
    case "FIND_IMAGE_FOR_WBC_DLIBRA":
      findImageFromWbcDlibra(msg.payload || {}).then((r) => sendResponse(sanitizeFindResult(r)));
      return true;
    case "FIND_IMAGE_FOR_DFG_VIEWER":
      fetchImageFromDfgViewerLink(msg.url).then((r) => sendResponse(sanitizeFindResult(r)));
      return true;
    case "FIND_IMAGE_VIA_HIDDEN_TAB":
      fetchImageViaHiddenTab(msg.url).then((r) => sendResponse(sanitizeFindResult(r)));
      return true;
    case "BULK_DOWNLOAD":
      bulkDownload(msg.payload).then(sendResponse);
      return true;
    case "FIND_DFG_VIEWER_LINK_FROM_ARCINSYS":
      findDfgViewerLinkFromArcinsys(msg.payload).then((r) => sendResponse(sanitizeFindResult(r)));
      return true;
    case "SUBMIT_FORM_AND_DOWNLOAD": {
      const { url, folder, suggestedNameBase } = msg.payload || {};
      submitFormAndDownload(url, folder, suggestedNameBase).then(sendResponse);
      return true;
    }
    case "GET_WIKITREE_PERSON_ID":
      getWikiTreePersonId(msg.wikiTreeId).then(sendResponse);
      return true;
    case "STORE_PENDING_UPLOAD":
      // URL-Feld wird in validatePendingUploadInput über die Allowlist geprüft.
      storePendingUpload(msg).then(sendResponse);
      return true;
    case "GET_PENDING_UPLOADS":
      getPendingUploads(msg.personId).then((r) => {
        // Antworten mit URL-Feldern ebenfalls über die Allowlist.
        r.uploads = r.uploads.filter((e) => isSafeExternalUrl(e.url, { allowDataImage: true }));
        sendResponse(r);
      });
      return true;
    case "REMOVE_PENDING_UPLOAD":
      removePendingUpload(msg.personId, msg.id).then(sendResponse);
      return true;
    case "FETCH_UPLOAD_FILE":
      fetchUploadFile(msg).then(sendResponse);
      return true;
    default:
      return undefined;
  }
});
