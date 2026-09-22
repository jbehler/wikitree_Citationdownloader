/**
 * content.js
 * -----------------------------------------------------------------------
 * Läuft auf https://www.wikitree.com/wiki/*
 *
 * Erkennt Links zu Matricula Online und zu Landesarchiv NRW (direkt oder
 * über DFG-Viewer), baut daraus Quellenangaben inkl. Lizenztext, versucht
 * eine Bildvorschau zu finden, und fügt den Text ins Bio-Feld des
 * WikiTree-Editors ein.
 *
 * Zum Einfügen: Da die genaue Feldstruktur von WikiTrees Editor nicht
 * verifiziert werden konnte (robots.txt + Login), gibt es zusätzlich zur
 * automatischen Erkennung eine "Zielfeld anklicken"-Funktion: Man klickt
 * einmal auf das echte Bio-Feld, die Extension merkt sich genau dieses
 * DOM-Element (egal ob <textarea> oder ein contenteditable-Editor) für
 * den Rest der Sitzung. Das ersetzt Rate-Selektoren durch eine sichere,
 * direkte Zuordnung.
 *
 * Gespeichert wird nie automatisch - das bleibt immer ein bewusster Klick
 * auf WikiTrees eigenen "Save"-Button.
 */

(function () {
  const SOURCE_LINK_RE = /(matricula-online\.eu|dfg-viewer\.de|landesarchiv-nrw\.de)/i;
  let manualTarget = null; // per Klick ausgewähltes Editor-Feld (Textarea oder contenteditable)

  // Bekannte Institutionen mit verifizierten Lizenzangaben. Für alles
  // andere (z.B. Arcinsys Hessen) wird NICHT einfach dieselbe Lizenz
  // unterstellt - unbekannte Archive bekommen stattdessen eine
  // Aufforderung, die Lizenz selbst zu prüfen, statt einer möglicherweise
  // falschen rechtlichen Behauptung.
  const KNOWN_INSTITUTIONS = {
    "landesarchiv-nrw.de": {
      name: "Landesarchiv Nordrhein-Westfalen",
      citationLicenseNote:
        "Lizenz: [https://creativecommons.org/licenses/by-sa/4.0/deed.de CC BY-SA 4.0] gemäß den offiziellen " +
        "[https://www.landesarchiv-nrw.de/digitalisate/LAV_NRW_Nutzungsbedingungen_Digitalisate.pdf Nutzungsbedingungen] " +
        "des Landesarchivs NRW. Bitte bei Weiterverwertung: Archivsignatur nennen, den/die Autor*in bzw. Urheber*in " +
        "nennen (falls bekannt), und bei Online-Nutzung zusätzlich den beständigen Verweis (Permalink) zur Fundstelle " +
        "in den Findmitteln angeben. Gilt für Digitalisate aus dem Online-Findmittelsystem; bei separat bestellten " +
        "Digitalisaten ggf. abweichende Bedingungen erfragen."
    }
  };

  function getMetsHostFromDfgUrl(url) {
    try {
      const u = new URL(url);
      const metsUrl = u.searchParams.get("tx_dlf[id]");
      if (!metsUrl) return null;
      return new URL(metsUrl).hostname;
    } catch (e) {
      return null;
    }
  }

  function humanizeHost(host) {
    if (!host) return null;
    let parts = host.split(".").filter(Boolean);
    if (parts[0] === "www" || parts[0] === "data") parts = parts.slice(1);
    if (parts.length > 1 && /^[a-z]{2,3}$/i.test(parts[parts.length - 1])) {
      parts = parts.slice(0, -1);
    }
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ") || null;
  }

  function institutionInfoForSource(source) {
    if (source.domain === "dfg-viewer") {
      const host = getMetsHostFromDfgUrl(source.url);
      const known = host && KNOWN_INSTITUTIONS[host];
      return {
        name: (known && known.name) || humanizeHost(host) || "unbekanntes Archiv",
        citationLicenseNote: known ? known.citationLicenseNote : null
      };
    }
    if (source.domain === "landesarchiv-nrw-direkt") {
      const known = KNOWN_INSTITUTIONS["landesarchiv-nrw.de"];
      return { name: known.name, citationLicenseNote: known.citationLicenseNote };
    }
    return null;
  }

  function classifyDomain(href) {
    if (/dfg-viewer\.de/i.test(href)) return "dfg-viewer";
    if (/matricula-online\.eu/i.test(href)) return "matricula";
    if (/landesarchiv-nrw\.de/i.test(href)) return "landesarchiv-nrw-direkt";
    return "unbekannt";
  }

  function findSourceLinks() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const seen = new Set();
    const results = [];
    for (const a of anchors) {
      const href = a.href;
      if (SOURCE_LINK_RE.test(href) && !seen.has(href)) {
        seen.add(href);
        results.push({
          url: href,
          domain: classifyDomain(href),
          linkText: (a.textContent || "").trim().slice(0, 80)
        });
      }
    }
    return results;
  }

  function buildCitationText(source, imageInfo) {
    let citation;
    if (source.domain === "matricula") {
      citation =
        `* Digitalisat: [${source.url} Matricula Online] – ` +
        `Kirchenbuch-Digitalisat. Lizenz: [https://creativecommons.org/licenses/by-nc-nd/2.0/deed.de CC BY-NC-ND 2.0] ` +
        `(nicht-kommerziell, unverändert, mit Namensnennung). Laut Matricula-Nutzungsbedingungen bitte das ` +
        `zuständige Diözesan-/Landesarchiv über die Online-Veröffentlichung informieren; ein Link genügt dafür.`;
    } else if (source.domain === "dfg-viewer" || source.domain === "landesarchiv-nrw-direkt") {
      const info = institutionInfoForSource(source);
      const viaSuffix = source.domain === "dfg-viewer" ? ", via DFG-Viewer" : "";
      if (info.citationLicenseNote) {
        citation = `* Digitalisat: [${source.url} ${info.name}${viaSuffix}] – ${info.citationLicenseNote}`;
      } else {
        citation =
          `* Digitalisat: [${source.url} ${info.name}${viaSuffix}] – ` +
          `Lizenz-/Nutzungsbedingungen nicht bekannt (nicht automatisch geprüft). Bitte vor einer Veröffentlichung ` +
          `direkt bei ${info.name} nachsehen, unter welchen Bedingungen die Nutzung erlaubt ist.`;
      }
    } else {
      citation =
        `* Digitalisat: [${source.url} unbekanntes Archiv] – ` +
        `Lizenz-/Nutzungsbedingungen nicht bekannt (nicht automatisch geprüft). Bitte vor einer Veröffentlichung ` +
        `direkt bei der Institution nachsehen, unter welchen Bedingungen die Nutzung erlaubt ist.`;
    }

    // Kein <img src="externe-URL">-Einfügen: WikiTree bindet fremde,
    // extern gehostete Bild-URLs nicht direkt ein - Bilder müssen dort
    // zuerst hochgeladen und dann über WikiTrees eigene Syntax referenziert
    // werden (vom Nutzer bestätigt). Die gefundene Bild-URL wird daher nur
    // als Vorschau/Download angeboten, nicht in den Wikitext eingefügt.
    return { citation };
  }

  function getWikiTreeIdFromUrl() {
    const segments = location.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "profil";
    try {
      return decodeURIComponent(last);
    } catch (e) {
      return last; // falls fehlerhaft kodiert -> unverändert übernehmen
    }
  }

  function getPersonNameFromPage() {
    const el = document.querySelector('[data-cy="person-name"]');
    return el ? el.textContent.trim() : null;
  }

  function buildFolderName() {
    const id = getWikiTreeIdFromUrl();
    const name = getPersonNameFromPage();
    return name ? `${id} - ${name}` : id;
  }

  function cleanLabel(text) {
    if (!text) return null;
    // Grobe Bereinigung typischer Seitentitel-Anhänge, z.B.
    // " | Matricula Online" oder " - DFG-Viewer". Best effort, kein
    // Anspruch auf Vollständigkeit für jede Variante.
    return text
      .replace(/\s*[|\u2013-]\s*(Matricula( Online)?|DFG-?Viewer)\s*$/i, "")
      .trim();
  }

  function guessExtension(imageInfo) {
    if (imageInfo && imageInfo.via === "canvas-snapshot") return "png";
    const url = (imageInfo && imageInfo.imageUrl) || "";
    const m = /\.(jpe?g|png|webp|tiff?)(?:[?#]|$)/i.exec(url);
    if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
    return "jpg"; // plausibler Standard für Archiv-/Kirchenbuch-Scans
  }

  function buildFileLabel(source, imageInfo) {
    const cleaned = cleanLabel(imageInfo && imageInfo.label);
    const base = cleaned || domainLabel(source);
    const page = imageInfo && imageInfo.pageNumber;
    return page ? `${base} - Seite ${page}` : base;
  }

  async function requestImageInfo(source) {
    if (source.domain === "dfg-viewer" || source.domain === "landesarchiv-nrw-direkt") {
      return chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_DFG_VIEWER", url: source.url });
    }
    if (source.domain === "matricula") {
      // Erst die günstige Methode (einfacher HTML-Abruf, jetzt mit
      // gelockertem Filter für Kitodo-typische <img>-Tags ohne
      // erkennbare Dateiendung). Nur wenn das nichts findet, der
      // aufwändigere Hidden-Tab-Versuch (inkl. Canvas-Snapshot) als
      // Fallback.
      const quick = await chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_URL", url: source.url });
      if (quick && quick.ok) return quick;
      return chrome.runtime.sendMessage({ type: "FIND_IMAGE_VIA_HIDDEN_TAB", url: source.url });
    }
    return chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_URL", url: source.url });
  }

  // ---------------------------------------------------------------------
  // Zielfeld-Auswahl per Klick (ersetzt Rate-Selektoren)
  // ---------------------------------------------------------------------

  function isUsableTarget(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function startPickingTarget(onPicked) {
    document.body.classList.add("qba-picking");

    function highlightHandler(e) {
      document.querySelectorAll(".qba-hover-candidate").forEach((n) => n.classList.remove("qba-hover-candidate"));
      if (isUsableTarget(e.target)) e.target.classList.add("qba-hover-candidate");
    }

    function clickHandler(e) {
      if (!isUsableTarget(e.target)) return; // weiter auf brauchbares Ziel warten
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mouseover", highlightHandler, true);
      document.body.classList.remove("qba-picking");
      document.querySelectorAll(".qba-hover-candidate").forEach((n) => n.classList.remove("qba-hover-candidate"));
      manualTarget = e.target;
      onPicked(e.target);
    }

    document.addEventListener("mouseover", highlightHandler, true);
    document.addEventListener("click", clickHandler, true);
  }

  function tryFindBioTextareaAuto() {
    const candidateSelectors = [
      "textarea#wpTextbox1",
      'textarea[name="bio"]',
      "#bioTextArea",
      "textarea.bioEdit",
      "textarea[name*=bio i]"
    ];
    for (const sel of candidateSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const textareas = Array.from(document.querySelectorAll("textarea"));
    if (textareas.length === 0) return null;
    textareas.sort((a, b) => (b.rows || 0) * (b.cols || 0) - (a.rows || 0) * (a.cols || 0));
    return textareas[0];
  }

  function insertTextIntoElement(el, fullText) {
    const marker = "== Sources ==";
    if (el.tagName === "TEXTAREA") {
      const current = el.value;
      const newValue = current.includes(marker)
        ? current.replace(marker, `${marker}\n${fullText}`)
        : current.replace(/\s*$/, "") + `\n\n${marker}\n${fullText}\n`;
      el.value = newValue;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.scrollTop = el.scrollHeight;
      return true;
    }
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // ans Ende springen
      sel.addRange(range);
      const textToInsert = `\n\n${marker}\n${fullText}\n`;
      const inserted = document.execCommand && document.execCommand("insertText", false, textToInsert);
      if (!inserted) {
        el.textContent = (el.textContent || "") + textToInsert;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  function insertIntoEditorOrFallback(fullText) {
    const target = manualTarget && document.contains(manualTarget) ? manualTarget : tryFindBioTextareaAuto();
    if (!target) {
      return { inserted: false, reason: "Kein Bio-Feld gefunden. Bist du im Edit-Modus? Alternativ oben 'Zielfeld wählen' benutzen." };
    }
    try {
      const ok = insertTextIntoElement(target, fullText);
      if (!ok) return { inserted: false, reason: "Gefundenes Element ist weder <textarea> noch contenteditable." };
      return { inserted: true };
    } catch (e) {
      return { inserted: false, reason: String(e) };
    }
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  function domainLabel(source) {
    if (source.domain === "matricula") return "Matricula";
    if (source.domain === "dfg-viewer" || source.domain === "landesarchiv-nrw-direkt") {
      const info = institutionInfoForSource(source);
      return source.domain === "dfg-viewer" ? `${info.name} (DFG-Viewer)` : info.name;
    }
    return "Quelle";
  }

  function createPanel(sources) {
    const panel = document.createElement("div");
    panel.id = "qba-panel";
    panel.innerHTML = `
      <div id="qba-header">
        <span>📜 Quellenbilder-Assistent</span>
        <button id="qba-close" title="Schließen">✕</button>
      </div>
      <div id="qba-body">
        <div id="qba-target-row">
          <span id="qba-target-status">Ziel-Editor-Feld: nicht ausgewählt (Auto-Erkennung wird versucht)</span>
          <button id="qba-pick-target">🎯 Zielfeld wählen</button>
        </div>
        <p class="qba-hint">Gefundene Links zu Matricula / Landesarchiv NRW auf dieser Seite:</p>
        <div id="qba-list"></div>
        <div id="qba-actions">
          <button id="qba-check-images">Bildvorschau prüfen</button>
          <button id="qba-insert" disabled>Ausgewählte in Editor einfügen</button>
        </div>
        <div id="qba-actions-download">
          <button id="qba-download-all" disabled>⬇ Ausgewählte Bilder gemeinsam herunterladen</button>
        </div>
        <div id="qba-fallback" style="display:none;">
          <p class="qba-hint">Automatisches Einfügen hat nicht geklappt. Text zum manuellen Einfügen:</p>
          <textarea id="qba-fallback-text" readonly></textarea>
          <button id="qba-copy">In Zwischenablage kopieren</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#qba-pick-target").addEventListener("click", () => {
      panel.querySelector("#qba-target-status").textContent = "Bitte jetzt auf das Bio-Textfeld im Editor klicken …";
      startPickingTarget((el) => {
        const desc = el.tagName === "TEXTAREA" ? `<textarea>${el.id ? "#" + el.id : ""}` : `contenteditable-Element${el.id ? " #" + el.id : ""}`;
        panel.querySelector("#qba-target-status").textContent = `Zielfeld ausgewählt: ${desc} ✓`;
      });
    });

    const list = panel.querySelector("#qba-list");

    function isMetsBased(domain) {
      return domain === "dfg-viewer" || domain === "landesarchiv-nrw-direkt";
    }

    function buildNextPageUrl(url) {
      try {
        const u = new URL(url);
        const current = u.searchParams.get("tx_dlf[page]");
        const currentNum = current ? parseInt(current, 10) : 1;
        u.searchParams.set("tx_dlf[page]", String(currentNum + 1));
        return u.toString();
      } catch (e) {
        return null;
      }
    }

    function renderRow(i) {
      const s = sources[i];
      const row = document.createElement("div");
      row.className = "qba-row";
      row.innerHTML = `
        <label>
          <input type="checkbox" class="qba-check" data-idx="${i}" checked>
          <span class="qba-domain">${domainLabel(s)}</span>
          <a href="${s.url}" target="_blank" rel="noopener">${s.linkText || s.url}</a>
        </label>
        ${isMetsBased(s.domain) ? `<button class="qba-nextpage" data-idx="${i}" title="Lädt dieselbe Quelle mit Seite+1 - praktisch bei Heiratsregistern über zwei Seiten">➕ Folgeseite auch laden</button>` : ""}
        <div class="qba-status" id="qba-status-${i}">noch nicht geprüft</div>
        <div class="qba-preview" id="qba-preview-${i}"></div>
      `;
      list.appendChild(row);

      const nextBtn = row.querySelector(".qba-nextpage");
      if (nextBtn) {
        nextBtn.addEventListener("click", () => {
          const idx = parseInt(nextBtn.dataset.idx, 10);
          const nextUrl = buildNextPageUrl(sources[idx].url);
          if (!nextUrl) {
            alert("Konnte den Folgeseiten-Link nicht aus der URL bauen.");
            return;
          }
          sources.push({
            url: nextUrl,
            domain: sources[idx].domain,
            linkText: `${sources[idx].linkText || sources[idx].url} (Folgeseite)`
          });
          renderRow(sources.length - 1);
          nextBtn.disabled = true;
          nextBtn.textContent = "Folgeseite hinzugefügt ✓";
        });
      }
    }

    sources.forEach((s, i) => renderRow(i));

    function renderResult(i) {
      const statusEl = panel.querySelector(`#qba-status-${i}`);
      const previewEl = panel.querySelector(`#qba-preview-${i}`);
      previewEl.innerHTML = ""; // wichtig: verhindert doppelte Bilder bei erneutem Prüfen
      const info = sources[i].imageInfo;
      if (info && info.ok) {
        const viaLabel =
          info.via === "mets"
            ? "über METS-Datei"
            : info.via === "hidden-tab"
            ? "über Hintergrund-Tab"
            : info.via === "canvas-snapshot"
            ? "Canvas-Schnappschuss"
            : "Heuristik, experimentell";
        statusEl.textContent = `Bild gefunden (${viaLabel})`;
        const img = document.createElement("img");
        img.src = info.imageUrl;
        img.className = "qba-thumb";
        previewEl.appendChild(img);

        if (info.caveat) {
        const note = document.createElement("div");
        note.className = "qba-caveat";
        note.textContent = `⚠ ${info.caveat}`;
        previewEl.appendChild(note);
      }
      const dl = document.createElement("a");
        dl.href = info.imageUrl;
        dl.download = `${buildFileLabel(sources[i], info)}.${guessExtension(info)}`;
        dl.target = "_blank";
        dl.rel = "noopener";
        dl.className = "qba-download";
        dl.textContent = "⬇ Bild herunterladen (danach manuell bei WikiTree hochladen)";
        previewEl.appendChild(dl);
      } else {
        statusEl.textContent = `kein Bild automatisch gefunden – es wird nur der Link zitiert (${(info && info.reason) || "unbekannt"})`;
      }
    }

    panel.querySelector("#qba-check-images").addEventListener("click", async () => {
      for (let i = 0; i < sources.length; i++) {
        if (sources[i].imageInfo) {
          // Bereits geprüft -> aus Cache erneut anzeigen statt neu zu laden
          // (verhindert unnötige Doppel-Anfragen bei wiederholtem Klick).
          renderResult(i);
          continue;
        }
        const statusEl = panel.querySelector(`#qba-status-${i}`);
        statusEl.textContent = "prüfe …";
        try {
          sources[i].imageInfo = await requestImageInfo(sources[i]);
        } catch (e) {
          sources[i].imageInfo = { ok: false, reason: String(e) };
        }
        renderResult(i);
        // Kleine Pause zwischen aufeinanderfolgenden Prüfungen - falls die
        // Ursache für Fehlschläge bei mehreren Matricula-Quellen ein
        // serverseitiges Rate-Limit oder eine Race Condition beim
        // Fenster-Fokus-Wechsel ist, mindert das die Wahrscheinlichkeit.
        if (i < sources.length - 1) {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      panel.querySelector("#qba-insert").disabled = false;
      panel.querySelector("#qba-download-all").disabled = false;
    });

    panel.querySelector("#qba-insert").addEventListener("click", () => {
      const checks = Array.from(panel.querySelectorAll(".qba-check"));
      const chosen = checks.filter((c) => c.checked).map((c) => sources[parseInt(c.dataset.idx, 10)]);
      if (chosen.length === 0) return;

      const blocks = chosen.map((s) => buildCitationText(s, s.imageInfo).citation);
      const fullText = blocks.join("\n");

      const result = insertIntoEditorOrFallback(fullText);
      const fallbackBox = panel.querySelector("#qba-fallback");
      const fallbackText = panel.querySelector("#qba-fallback-text");
      if (result.inserted) {
        fallbackBox.style.display = "none";
        alert("Eingefügt. Bitte im Editor prüfen (Vorschau!) und danach selbst bei WikiTree speichern.");
      } else {
        fallbackText.value = fullText;
        fallbackBox.style.display = "block";
        alert(result.reason || "Automatisches Einfügen nicht möglich - Text bitte unten kopieren.");
      }
    });

    panel.querySelector("#qba-download-all").addEventListener("click", async () => {
      const checks = Array.from(panel.querySelectorAll(".qba-check"));
      const chosen = checks.filter((c) => c.checked).map((c) => sources[parseInt(c.dataset.idx, 10)]);
      const withImages = chosen.filter((s) => s.imageInfo && s.imageInfo.ok && s.imageInfo.imageUrl);

      if (withImages.length === 0) {
        alert("Für keine der ausgewählten Quellen wurde ein Bild gefunden - nichts zum Herunterladen.");
        return;
      }

      const folderName = buildFolderName();
      const files = withImages.map((s, i) => {
        const ext = guessExtension(s.imageInfo);
        const num = String(i + 1).padStart(2, "0");
        return { url: s.imageInfo.imageUrl, suggestedName: `${num}-${buildFileLabel(s, s.imageInfo)}.${ext}` };
      });
      const citationsText = chosen.map((s) => buildCitationText(s, s.imageInfo).citation).join("\n\n");

      const btn = panel.querySelector("#qba-download-all");
      const originalLabel = btn.textContent;
      btn.textContent = "Lade herunter …";
      btn.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({
          type: "BULK_DOWNLOAD",
          payload: { folderName, files, citationsText }
        });
        const failed = (result.results || []).filter((r) => !r.ok);
        if (failed.length > 0) {
          alert(`Ordner "${result.folder}": ${result.results.length - failed.length} von ${result.results.length} Dateien heruntergeladen. Fehler: ${failed.map((f) => f.reason).join("; ")}`);
        } else {
          alert(`Fertig: ${files.length} Bild(er) + Quellenangaben in den Download-Unterordner "${result.folder}" gespeichert.`);
        }
      } catch (e) {
        alert(`Download fehlgeschlagen: ${String(e)}`);
      } finally {
        btn.textContent = originalLabel;
        btn.disabled = false;
      }
    });

    panel.querySelector("#qba-copy").addEventListener("click", async () => {
      const text = panel.querySelector("#qba-fallback-text").value;
      try {
        await navigator.clipboard.writeText(text);
        panel.querySelector("#qba-copy").textContent = "Kopiert ✓";
      } catch (e) {
        // Clipboard-API evtl. blockiert -> Text ist im Feld ohnehin markierbar
      }
    });

    panel.querySelector("#qba-close").addEventListener("click", () => panel.remove());
  }

  function createLaunchButton(sources) {
    const btn = document.createElement("button");
    btn.id = "qba-launch";
    btn.textContent = `📜 ${sources.length} Quelle(n) gefunden`;
    btn.addEventListener("click", () => {
      btn.remove();
      createPanel(sources);
    });
    document.body.appendChild(btn);
  }

  const sources = findSourceLinks();
  if (sources.length > 0) {
    createLaunchButton(sources);
  }
})();
