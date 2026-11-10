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
  let manualTarget = null; // per Klick ausgewähltes Editor-Feld (Textarea oder contenteditable)
  let activePickingCancel = null; // Cleanup-Funktion, solange der Ziel-Auswahlmodus läuft

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
    },
    "www.wbc.poznan.pl": { name: "Wielkopolska Digital Library (Poznań)" },
    "wbc.poznan.pl": { name: "Wielkopolska Digital Library (Poznań)" }
  };

  // Quellen, bei denen bewusst KEIN automatischer Bildabruf versucht wird,
  // weil eine explizite Zugangssperre (CAPTCHA, Login, "secured publication")
  // vorliegt - anders als bei einfach nur "noch nicht unterstützt", ist das
  // hier eine bewusste Entscheidung, keine technische Absicherung zu
  // umgehen.
  // Seit 0.17.0 gilt wbc.poznan.pl NICHT mehr pauschal als geschützt:
  // dLibra nennt die Zugänglichkeit pro Objekt im METS
  // (dlibra_avs:PublicAccess). Öffentliche Publikationen werden normal
  // verarbeitet; nicht-öffentliche meldet der Resolver ehrlich (siehe
  // background.js, Weg 3). Serverseitige Browser-Prüfungen (PoW-Challenge)
  // werden ebenfalls erkannt und gemeldet, nicht umgangen.
  const PROTECTED_NO_AUTOMATION = {};

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

  // Defensive Allowlist (Gegenstück zu background.js sanitizeFindResult):
  // nur http(s) und data:image/ in img.src bzw. a.href übernehmen.
  function isSafeUrl(url, allowDataImage) {
    if (typeof url !== "string" || !url) return false;
    if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp)[;,]/i.test(url)) return true;
    return /^https?:\/\//i.test(url);
  }

  // Klassifiziert nach HOSTNAME, nicht per Regex über die ganze URL: sonst
  // würde z.B. https://example.com/?ref=matricula-online.eu als Matricula
  // erkannt. Suffix-Match auf Label-Grenze ((^|\.)host$).
  function classifyDomain(href) {
    let u = null;
    try {
      u = new URL(href);
    } catch (e) {
      return "sonstige-quelle";
    }
    const host = u.hostname.toLowerCase();
    const hostIs = (d) => host === d || host.endsWith("." + d);
    if (hostIs("dfg-viewer.de")) return "dfg-viewer";
    if (hostIs("matricula-online.eu")) return "matricula";
    if (hostIs("landesarchiv-nrw.de")) return "landesarchiv-nrw-direkt";
    // arcinsys.hessen.de, arcinsys.de, www.arcinsys.niedersachsen.de, ...:
    // ein Hostname-Label "arcinsys" genügt
    if (/(^|\.)arcinsys(\.|$)/.test(host)) return "arcinsys-direkt";
    if (hostIs("landesarchiv-bw.de")) return "landesarchiv-bw-plink";
    // dLibra (wbc.poznan.pl, Wielkopolska Digital Library, DInGO 6.x; seit
    // 0.17.0 automatisiert per METS über OAI statt pauschal als "geschützt"
    // abzulehnen - siehe background.js, Weg 3):
    // /dlibra/publication/.../edition/.../content sowie direkte
    // Datei-/Download-URLs /Content/<id>/...
    if (hostIs("wbc.poznan.pl")) {
      if (/\/dlibra\//i.test(u.pathname) || /\/Content\/\d+/i.test(u.pathname)) return "wbc-dlibra";
    }
    return "sonstige-quelle";
  }

  function extractPageHintFromContext(anchor) {
    // Rein informativ: sucht im nahen Textumfeld des Links nach einer
    // Seitenangabe wie "S. 123", "Seite 123", "page 123", "Blatt 5",
    // "Bl. 5", "p. 123", "fol. 123" - so, wie sie oft schon in der
    // ursprünglichen Quellenbeschreibung auf WikiTree steht. Keine
    // Grundlage für automatischen Bildabruf, nur eine Orientierungshilfe
    // für die manuelle Navigation. "Certificate"/"Zertifikat"-Nummern
    // werden bewusst NICHT erfasst, auch wenn sie danebenstehen - nur
    // die tatsächliche Seiten-/Blattangabe.
    const container = anchor.closest("li, p, div") || anchor.parentElement;
    const text = container ? container.textContent : "";
    const m = /\b(?:S\.?|Seite|Blatt|Bl\.?|page|pages|picture|p\.?|pag\.?|fol\.?)\s*(\d+)\b/i.exec(text || "");
    return m ? m[1] : null;
  }

  function findSourceLinks() {
    // Bevorzugt: nur externe Links innerhalb von WikiTrees eigener
    // Quellenliste (<li class="x-src">, die Fußnoten unter "Sources").
    // Das erlaubt, JEDEN dort zitierten externen Archiv-/Bibliothekslink
    // zu erkennen - unabhängig davon, ob mir das jeweilige System schon
    // bekannt ist -, ohne bei irrelevanten Links auf der restlichen Seite
    // (Navigation, Werbung, WikiTree-eigene Verlinkungen) Rauschen zu
    // erzeugen. Findet sich keine solche Liste (z.B. weil WikiTree die
    // Struktur mal ändert), wird ersatzweise auf das alte, engere Muster
    // zurückgefallen (nur bekannte Archiv-Domains, ganze Seite).
    const sourceItems = document.querySelectorAll("li.x-src");
    const scopedToKnownSourceList = sourceItems.length > 0;
    const anchors = scopedToKnownSourceList
      ? Array.from(sourceItems).flatMap((li) => Array.from(li.querySelectorAll("a[href]")))
      : Array.from(document.querySelectorAll("a[href]"));

    const seen = new Set();
    const results = [];
    for (const a of anchors) {
      const href = a.href;
      if (!/^https?:\/\//i.test(href)) continue; // interne Anker wie #_ref-1 überspringen
      if (seen.has(href)) continue;

      const domain = classifyDomain(href);
      // Im Fallback-Modus (ganze Seite, keine Quellenliste gefunden) nur
      // bereits bekannte Archiv-Domains akzeptieren, um Seiten-Rauschen
      // zu vermeiden - "sonstige-quelle" gibt es dort bewusst nicht.
      if (!scopedToKnownSourceList && domain === "sonstige-quelle") continue;

      seen.add(href);
      results.push({
        url: href,
        domain,
        linkText: (a.textContent || "").trim().slice(0, 80),
        citedPageHint: extractPageHintFromContext(a)
      });
    }
    return results;
  }

  // ---------------------------------------------------------------------
  // Seitenangabe im Zitat: Dokumentenseite vs. Beschreibungs-Hinweis
  // ---------------------------------------------------------------------
  // Je nach Quelltyp kennt die Extension zwei mögliche Seitenzahlen:
  //  a) den Seitenzahl-Hinweis aus der Quellenbeschreibung ("S. 12" im
  //     Textumfeld des Links, citedPageHint - reine Orientierung; er kann
  //     sich auf eine bedruckte Seite beziehen, die im Digitalisat so
  //     nicht existiert), und
  //  b) die tatsächlich ermittelte Dokumentenseite des Digitalisats
  //     (gewählte Seite bei dLibra, "Bild 74" bei Landesarchiv BW,
  //     aktiver Seiten-Link bei Matricula, tx_dlf[page] bei METS/DFG).
  // Regel: Beide anzeigen, wenn sie abweichen - z.B.
  // "(Seite 12, im Dokument Bild 74)". Stimmen sie überein, genügt
  // "(Seite N)" - der Hinweis ist dann durch das Digitalisat bestätigt.
  // Ist nur eine Angabe bekannt, wird nur diese gezeigt; ein alleiniger
  // Beschreibungs-Hinweis bleibt ausdrücklich als Vermutung gekennzeichnet.
  function citationDocPage(imageInfo) {
    if (!imageInfo || !imageInfo.ok || imageInfo.pageNumber == null) return null;
    // Formular-Download-Stub (Landesarchiv BW): pageNumber ist dort nur
    // der Beschreibungs-Hinweis als Zahl, keine verifizierte Angabe des
    // Digitalisats - zählt daher nicht als ermittelte Dokumentenseite.
    if (imageInfo.via === "form-download-pending") return null;
    if (imageInfo.via === "bw-bild-php") {
      // Landesarchiv BW: "Bild N" ist die Position im Digitalisat
      // (Zählung des Betrachters), nicht die bedruckte Seite - im Zitat
      // deshalb klar als Dokumentangabe gekennzeichnet (auch als
      // Einzelangabe, weil "Bild 74" ohne Kontext missverständlich wäre).
      const docLabel = imageInfo.pageLabel || `Bild ${imageInfo.pageNumber}`;
      return {
        number: imageInfo.pageNumber,
        docLabel,
        docOnlyLabel: `im Dokument ${docLabel}`
      };
    }
    // dLibra/METS/Matricula: Die ermittelte Zahl ist tatsächlich eine
    // Seite des Dokuments, darf also als "(Seite N)" allein stehen. Im
    // Kombinationsfall mit abweichendem Hinweis wird sie zur
    // Unterscheidung mit "im Dokument" markiert.
    return {
      number: imageInfo.pageNumber,
      docLabel: `Seite ${imageInfo.pageNumber}`,
      docOnlyLabel: `Seite ${imageInfo.pageNumber}`
    };
  }

  function buildCitationPageSuffix(docPage, citedPageHint) {
    if (docPage) {
      if (citedPageHint) {
        // Abweichung: Hinweis (z.B. bedruckte Seite) und tatsächlich
        // ermittelte Dokumentenseite sind verschieden - beide angeben.
        // Ohne vergleichbare Zahl (Label nicht als "Bild N" geparst)
        // lieber beide zeigen als etwas wegzulassen.
        const differs =
          docPage.number == null || Number(citedPageHint) !== docPage.number;
        return differs
          ? ` (Seite ${citedPageHint}, im Dokument ${docPage.docLabel})`
          : ` (Seite ${citedPageHint})`;
      }
      return ` (${docPage.docOnlyLabel})`;
    }
    if (citedPageHint) return ` (vermutlich Seite ${citedPageHint})`;
    return "";
  }

  // ---------------------------------------------------------------------
  // Quelltyp-Registry
  // ---------------------------------------------------------------------
  // Pro source.domain (Ergebnis von classifyDomain) gibt es genau einen
  // Eintrag mit allem, was sich je Quelltyp unterscheidet - vorher waren
  // das vier verstreute if/else-Ketten (institutionInfoForSource,
  // domainLabel, requestImageInfo, buildCitationText), bei denen ein neuer
  // Quelltyp an vier Stellen ergänzt werden musste:
  //   label(source)                  -> Kurzname fürs Panel/Dateinamen
  //   institution(source)            -> { name, citationLicenseNote, … }
  //                                     (fehlt = null, z.B. Matricula)
  //   requestImageInfo(source)       -> Promise mit dem Bild-Ergebnis
  //   buildCitation(source, imgInfo) -> Zitattext (String)
  // Unbekannte domain-Werte fallen in den Dispatch-Funktionen weiter unten
  // auf die bisherigen Fallbacks zurück.

  // Gemeinsame Zitat-Logik von DFG-Viewer-Links und direkten Landesarchiv-
  // NRW-Links (nur der "via DFG-Viewer"-Zusatz unterscheidet sich).
  function buildMetsCitation(source, imageInfo) {
    const info = institutionInfoForSource(source);
    const viaSuffix = source.domain === "dfg-viewer" ? ", via DFG-Viewer" : "";
    const pageSuffix = buildCitationPageSuffix(citationDocPage(imageInfo), source.citedPageHint);
    if (info.citationLicenseNote) {
      return `* Digitalisat: [${source.url} ${info.name}${viaSuffix}${pageSuffix}] – ${info.citationLicenseNote}`;
    }
    return (
      `* Digitalisat: [${source.url} ${info.name}${viaSuffix}${pageSuffix}] – ` +
      `Lizenz-/Nutzungsbedingungen nicht bekannt (nicht automatisch geprüft). Bitte vor einer Veröffentlichung ` +
      `direkt bei ${info.name} nachsehen, unter welchen Bedingungen die Nutzung erlaubt ist.`
    );
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return null;
    }
  }

  const SOURCE_TYPES = {
    "matricula": {
      label() {
        return "Matricula";
      },
      // bewusst keine institution(): Matricula hat keine Institutions-Info
      async requestImageInfo(source) {
        // Erst die günstige Methode (einfacher HTML-Abruf, jetzt mit
        // gelockertem Filter für Kitodo-typische <img>-Tags ohne
        // erkennbare Dateiendung). Nur wenn das nichts findet, der
        // aufwändigere Hidden-Tab-Versuch (inkl. Canvas-Snapshot) als
        // Fallback.
        const quick = await chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_URL", url: source.url });
        if (quick && quick.ok) return quick;
        return chrome.runtime.sendMessage({ type: "FIND_IMAGE_VIA_HIDDEN_TAB", url: source.url });
      },
      buildCitation(source, imageInfo) {
        const pageSuffix = buildCitationPageSuffix(citationDocPage(imageInfo), source.citedPageHint);
        return (
          `* Digitalisat: [${source.url} Matricula Online${pageSuffix}] – ` +
          `Kirchenbuch-Digitalisat. Lizenz: [https://creativecommons.org/licenses/by-nc-nd/2.0/deed.de CC BY-NC-ND 2.0] ` +
          `(nicht-kommerziell, unverändert, mit Namensnennung). Laut Matricula-Nutzungsbedingungen bitte das ` +
          `zuständige Diözesan-/Landesarchiv über die Online-Veröffentlichung informieren; ein Link genügt dafür.`
        );
      }
    },

    "dfg-viewer": {
      label(source) {
        return `${institutionInfoForSource(source).name} (DFG-Viewer)`;
      },
      institution(source) {
        const host = getMetsHostFromDfgUrl(source.url);
        const known = host && KNOWN_INSTITUTIONS[host];
        return {
          name: (known && known.name) || humanizeHost(host) || "unbekanntes Archiv",
          citationLicenseNote: known ? known.citationLicenseNote : null
        };
      },
      requestImageInfo(source) {
        return chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_DFG_VIEWER", url: source.url });
      },
      buildCitation: buildMetsCitation
    },

    "landesarchiv-nrw-direkt": {
      label(source) {
        return institutionInfoForSource(source).name;
      },
      institution() {
        const known = KNOWN_INSTITUTIONS["landesarchiv-nrw.de"];
        return { name: known.name, citationLicenseNote: known.citationLicenseNote };
      },
      requestImageInfo(source) {
        return chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_DFG_VIEWER", url: source.url });
      },
      buildCitation: buildMetsCitation
    },

    "arcinsys-direkt": {
      label(source) {
        return `${institutionInfoForSource(source).name} (Gesamtdokument)`;
      },
      institution(source) {
        const host = hostnameOf(source.url);
        const known = host && KNOWN_INSTITUTIONS[host];
        return {
          name: (known && known.name) || humanizeHost(host) || "Arcinsys",
          citationLicenseNote: known ? known.citationLicenseNote : null
        };
      },
      async requestImageInfo(source) {
        const pageNumber = source.citedPageHint ? parseInt(source.citedPageHint, 10) : null;
        const result = await chrome.runtime.sendMessage({
          type: "FIND_DFG_VIEWER_LINK_FROM_ARCINSYS",
          payload: { url: source.url, pageNumber }
        });
        if (result && result.suggestedUrl) {
          source.suggestedUrl = result.suggestedUrl; // für "Quelle übernehmen"-Button im Panel
        }
        if (result && result.ok) {
          return result; // enthält bereits imageUrl/label/pageNumber über die METS-Logik
        }
        const pageHint = pageNumber ? "" : source.citedPageHint ? ` Laut Quellenbeschreibung vermutlich Seite ${source.citedPageHint}.` : "";
        return {
          ok: false,
          reason: (result && result.reason) || `Link verweist nur auf das Gesamtdokument, nicht auf eine einzelne Seite.${pageHint}`,
          suggestedUrl: result && result.suggestedUrl
        };
      },
      buildCitation(source, imageInfo) {
        const info = institutionInfoForSource(source);
        // Wenn die Extension über den gefundenen DFG-Viewer-Link bereits ein
        // Bild (METS-Logik) ermittelt hat, ist die Dokumentenseite bekannt und
        // der "bitte selbst navigieren"-Hinweis wäre falsch.
        const docPage = citationDocPage(imageInfo);
        const pageHint = buildCitationPageSuffix(docPage, source.citedPageHint);
        const navigation = docPage
          ? "Bild wurde über den auf der Seite gefundenen DFG-Viewer-Link ermittelt (METS-Logik)."
          : "Link verweist auf das Gesamtdokument, bitte im Dokument selbst zur passenden Seite navigieren.";
        return (
          `* Digitalisat: [${source.url} ${info.name}${pageHint}] – ${navigation} Lizenz-/Nutzungsbedingungen nicht bekannt ` +
          `(nicht automatisch geprüft); bitte vor einer Veröffentlichung direkt bei ${info.name} nachsehen.`
        );
      }
    },

    "landesarchiv-bw-plink": {
      label(source) {
        return institutionInfoForSource(source).name;
      },
      institution() {
        return { name: "Landesarchiv Baden-Württemberg", citationLicenseNote: null };
      },
      async requestImageInfo(source) {
        // Zuerst der direkte Weg: bild_zoom-Seiten rendern die URL des
        // angezeigten JPEGs (bild.php) ins HTML - Vorschau und Download
        // ohne Nebenwirkung, wie bei Matricula dv1 (seit 0.16.0). Nur wenn
        // das nichts liefert, bleibt es beim Formular-Download: Dessen
        // Formular-Submit ist selbst schon der Download-Trigger, deshalb
        // darf er erst beim "gemeinsam herunterladen"-Klick passieren -
        // die reinen Prüfung signalisiert nur, dass diese Quelle so
        // verarbeitet werden kann.
        const quick = await chrome.runtime.sendMessage({ type: "FIND_IMAGE_FOR_URL", url: source.url });
        if (quick && quick.ok) return quick;
        if (quick && !quick.ok && /antwortet leer/.test(quick.reason || "")) {
          // Ehrlich bleiben: toter ?i-Link (das Format ?i=<id> wird nicht mehr aufgelöst - für JEDEN eine leere Seite; das ?f=<archiv>-<bestand>-<bild>-Format funktioniert noch). Grund als Status zeigen statt dem falschen Formular-Download-Versprechen.
          return quick;
        }
        const pageNumber = source.citedPageHint ? parseInt(source.citedPageHint, 10) : null;
        return { ok: true, via: "form-download-pending", label: "Landesarchiv Baden-Württemberg", pageNumber };
      },
      buildCitation(source, imageInfo) {
        const info = institutionInfoForSource(source);
        // Seitenangabe: Die ermittelte Dokumentenseite ("Bild N" der
        // Digitalisat-Seite) hat Vorrang; weicht der Beschreibungs-Hinweis
        // davon ab, stehen beide im Zitat (s. Helper-Kommentar oben).
        const pageHint = buildCitationPageSuffix(citationDocPage(imageInfo), source.citedPageHint);
        const deadLink =
          imageInfo && !imageInfo.ok && /antwortet leer/.test(imageInfo.reason || "");
        const direct = deadLink
          ? "Link veraltet: das plink-Format mit ?i=<id> wird von Landesarchiv BW nicht mehr aufgelöst (Link liefert eine leere Seite) - das plink-Format ?f=<archiv>-<bestand>-<bild> funktioniert noch; bitte den Quellen-Link aktualisieren; Bilddownload nicht möglich."
          : imageInfo && imageInfo.ok && imageInfo.via === "bw-bild-php"
          ? "Bild automatisch aus der Digitalisat-Seite ermittelt und heruntergeladen (JPEG in voller Scan-Auflösung, wie auf der Seite angezeigt)."
          : "Bilddownload über ein Formular auf der Seite.";
        const rightsNote =
          imageInfo && imageInfo.rightsCategory
            ? ` Auf der Digitalisat-Seite ist die Rechtekategorie ${imageInfo.rightsCategory} gemäß ` +
              `rightsstatements.org ausgewählt (bei UND: Rechte unbestimmt) - bitte vor einer Veröffentlichung ` +
              `trotzdem die Nutzungsbedingungen bei ${info.name} prüfen.`
            : ` Lizenz-/Nutzungsbedingungen nicht bekannt (nicht automatisch geprüft); bitte vor einer Veröffentlichung ` +
              `direkt bei ${info.name} nachsehen.`;
        return `* Digitalisat: [${source.url} ${info.name}${pageHint}] – ${direct}${rightsNote}`;
      }
    },

    "wbc-dlibra": {
      label(source) {
        return institutionInfoForSource(source).name;
      },
      institution() {
        // Wielkopolska Digital Library (dLibra). Konkrete Titel-/Rechteangaben
        // kommen seit 0.17.0 dynamisch aus den METS-Daten (imageInfo.label,
        // imageInfo.rightsHolder) - hier nur der Institutionsname. Eine
        // Lizenz wird bewusst NICHT behauptet (nicht verifiziert).
        return { name: "Wielkopolska Digital Library (Poznań)", citationLicenseNote: null };
      },
      requestImageInfo(source) {
        // dLibra: METS-Datei der Edition über den OAI-Endpunkt auswerten
        // (Titel, Seiten, Rechte; PublicAccess-Prüfung gegen Sperren). Die
        // Seitenzahl kommt aus der Quellenbeschreibung, falls vorhanden.
        return chrome.runtime.sendMessage({
          type: "FIND_IMAGE_FOR_WBC_DLIBRA",
          payload: {
            url: source.url,
            pageNumber: source.citedPageHint ? parseInt(source.citedPageHint, 10) : null,
          },
        });
      },
      buildCitation(source, imageInfo) {
        const info = institutionInfoForSource(source);
        const title = imageInfo && imageInfo.label ? cleanLabel(imageInfo.label) : null;
        // Über den gemeinsamen Helper (gleiche Regel wie bei den anderen
        // Quelltypen). Für dLibra ändert sich das Ergebnis praktisch nicht:
        // Die gewählte Seite IST der Beschreibungs-Hinweis, wenn einer
        // vorhanden war, sonst gab es ihn eben nicht.
        const page = buildCitationPageSuffix(citationDocPage(imageInfo), source.citedPageHint);
        const rights = imageInfo && imageInfo.rightsHolder ? ` Rechteangabe des Objekts: ${imageInfo.rightsHolder}.` : "";
        const djvuNote =
          imageInfo && imageInfo.previewUnavailable
            ? ` Die zitierte Seite liegt als DjVu-Datei vor (kein direkt anzeigbares Bildformat) - Download über den Panel-Link, danach selbst konvertieren und hochladen.`
            : "";
        return (
          `* Digitalisat: [${source.url} ${info.name}${page}] – ` +
          (title ? `${title}. ` : "") +
          `Digitalisat über ${info.name} (dLibra-Digitalbibliothek).${rights}${djvuNote} ` +
          `Lizenz-/Nutzungsbedingungen nicht automatisch geprüft; bitte vor einer Veröffentlichung direkt bei ${info.name} bzw. der im Objekt genannten Einrichtung nachsehen.`
        );
      }
    },

    "sonstige-quelle": {
      label(source) {
        return institutionInfoForSource(source).name;
      },
      institution(source) {
        const host = hostnameOf(source.url);
        const known = host && KNOWN_INSTITUTIONS[host];
        return {
          name: (known && known.name) || humanizeHost(host) || "unbekannte Quelle",
          citationLicenseNote: known ? known.citationLicenseNote : null,
          protectedReason: host ? PROTECTED_NO_AUTOMATION[host] : null
        };
      },
      async requestImageInfo(source) {
        // Unbekanntes System (z.B. ein anderes Landesarchiv-System, ein
        // Bibliothekskatalog o.ä.; dLibra wird seit 0.17.0 unterstützt) -
        // kein Fetch-Versuch, da weder host_permissions noch eine
        // passende Extraktionslogik dafür existieren. Lieber ehrlich sofort
        // sagen, dass das (noch) nicht unterstützt wird, statt einen
        // sicher fehlschlagenden Netzwerk-Versuch zu starten.
        const info = institutionInfoForSource(source);
        const pageHint = source.citedPageHint ? ` Laut Quellenbeschreibung vermutlich Seite ${source.citedPageHint}.` : "";
        return {
          ok: false,
          reason: info.protectedReason || `Dieses System wird von der Extension noch nicht unterstützt - bitte manuell öffnen und herunterladen.${pageHint}`
        };
      },
      buildCitation(source, imageInfo) {
        const info = institutionInfoForSource(source);
        // Für unbekannte Systeme gibt es bisher keine ermittelte
        // Dokumentenseite - der Helper liefert daher nur den ehrlichen
        // "vermutlich"-Hinweis (oder nichts).
        const pageHint = buildCitationPageSuffix(citationDocPage(imageInfo), source.citedPageHint);
        const reason = info.protectedReason
          ? info.protectedReason
          : "Automatischer Bildabruf für diese Quelle ist (noch) nicht implementiert; bitte manuell öffnen und ggf. herunterladen.";
        return (
          `* Digitalisat: [${source.url} ${info.name}${pageHint}] – ${reason} Lizenz-/` +
          `Nutzungsbedingungen nicht bekannt (nicht automatisch geprüft); bitte vor einer Veröffentlichung ` +
          `direkt bei ${info.name} nachsehen.`
        );
      }
    }
  };

  function getSourceType(source) {
    const domain = source && source.domain;
    return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, domain) ? SOURCE_TYPES[domain] : null;
  }

  function institutionInfoForSource(source) {
    const type = getSourceType(source);
    return type && type.institution ? type.institution(source) : null;
  }

  function domainLabel(source) {
    const type = getSourceType(source);
    return type ? type.label(source) : "Quelle";
  }

  async function requestImageInfo(source) {
    const type = getSourceType(source);
    if (type) return type.requestImageInfo(source);
    return { ok: false, reason: "Keine passende Abruf-Methode für diese Quelle bekannt." };
  }

  function buildCitationText(source, imageInfo) {
    const type = getSourceType(source);
    const citation = type
      ? type.buildCitation(source, imageInfo)
      : `* Digitalisat: [${source.url} unbekanntes Archiv] – ` +
        `Lizenz-/Nutzungsbedingungen nicht bekannt (nicht automatisch geprüft). Bitte vor einer Veröffentlichung ` +
        `direkt bei der Institution nachsehen, unter welchen Bedingungen die Nutzung erlaubt ist.`;

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
    if (imageInfo && imageInfo.via === "bw-bild-php") return "jpg"; // bild.php-URL endet nicht auf .jpg
    const url = (imageInfo && imageInfo.imageUrl) || "";
    const m = /\.(jpe?g|png|webp|tiff?|djvu)(?:[?#]|$)/i.exec(url);
    if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
    if (imageInfo && imageInfo.via === "dlibra-djvu") return "djvu"; // URLs ohne erkennbare Endung
    return "jpg"; // plausibler Standard für Archiv-/Kirchenbuch-Scans
  }

  function buildFileLabel(source, imageInfo) {
    const cleaned = cleanLabel(imageInfo && imageInfo.label);
    const base = cleaned || domainLabel(source);
    const page = imageInfo && imageInfo.pageNumber;
    return page ? `${base} - Seite ${page}` : base;
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
      cleanup();
      manualTarget = e.target;
      onPicked(e.target);
    }

    function keyHandler(e) {
      if (e.key === "Escape") {
        cleanup();
        onPicked(null); // Abbruch an den Aufrufer signalisieren
      }
    }

    function cleanup() {
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mouseover", highlightHandler, true);
      document.removeEventListener("keydown", keyHandler, true);
      document.body.classList.remove("qba-picking");
      document.querySelectorAll(".qba-hover-candidate").forEach((n) => n.classList.remove("qba-hover-candidate"));
    }

    document.addEventListener("mouseover", highlightHandler, true);
    document.addEventListener("click", clickHandler, true);
    document.addEventListener("keydown", keyHandler, true);
    return cleanup; // zum externen Aufräumen (z. B. beim Schließen des Panels)
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

  // Zeilenbasierte Erkennung des Sources-Headers: matcht "== Sources ==",
  // "==Sources==", "=== Sources ===" usw. Der bisherige einfache
  // String-Replace von "== Sources ==" hätte z. B. in "=== Sources ==="
  // das Teil-Stück mittendrin ersetzt und den Header zerlegt.
  const SOURCES_HEADER_RE = /^[ \t]*(={2,4})[ \t]*Sources[ \t]*\1[ \t]*$/im;

  function insertTextIntoElement(el, fullText) {
    const marker = "== Sources ==";
    if (el.tagName === "TEXTAREA") {
      const current = el.value;
      const headerMatch = SOURCES_HEADER_RE.exec(current);
      let newValue;
      if (headerMatch) {
        // Direkt unter den vorhandenen Sources-Header einfügen.
        const insertAt = headerMatch.index + headerMatch[0].length;
        newValue = current.slice(0, insertAt) + "\n" + fullText + current.slice(insertAt);
      } else {
        newValue = current.replace(/\s*$/, "") + `\n\n${marker}\n${fullText}\n`;
      }
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
        <p class="qba-hint">Externe Quellen-Links auf dieser Seite (z. B. Matricula, Landesarchive, DFG-Viewer):</p>
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
      if (activePickingCancel) activePickingCancel(); // laufenden Auswahlmodus sauber beenden
      const statusEl = panel.querySelector("#qba-target-status");
      statusEl.textContent = "Bitte jetzt auf das Bio-Textfeld im Editor klicken (Esc bricht ab) …";
      activePickingCancel = startPickingTarget((el) => {
        activePickingCancel = null;
        if (!el) {
          statusEl.textContent = "Zielfeld-Auswahl abgebrochen - Auto-Erkennung wird weiterhin versucht.";
          return;
        }
        const desc = el.tagName === "TEXTAREA" ? `<textarea>${el.id ? "#" + el.id : ""}` : `contenteditable-Element${el.id ? " #" + el.id : ""}`;
        statusEl.textContent = `Zielfeld ausgewählt: ${desc} ✓`;
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

      // Bewusst DOM-API statt innerHTML: Linktext und URL stammen 1:1 aus
      // der WikiTree-Seite (Nutzer-Inhalt in den Quellenangaben). Über
      // innerHTML interpoliert könnte solcher Text HTML in das Panel
      // einschleusen oder das Markup zerstören - textContent und per
      // DOM-API gesetzte Attribute sind dagegen immer sicher.
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "qba-check";
      checkbox.dataset.idx = String(i);
      checkbox.checked = true;
      const domainSpan = document.createElement("span");
      domainSpan.className = "qba-domain";
      domainSpan.textContent = domainLabel(s);
      const link = document.createElement("a");
      link.href = s.url; // findSourceLinks lässt nur https?://-URLs durch
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = s.linkText || s.url;
      label.append(checkbox, domainSpan, link);
      row.appendChild(label);

      if (isMetsBased(s.domain)) {
        const nextBtn = document.createElement("button");
        nextBtn.className = "qba-nextpage";
        nextBtn.dataset.idx = String(i);
        nextBtn.title = "Lädt dieselbe Quelle mit Seite+1 - praktisch bei Heiratsregistern über zwei Seiten";
        nextBtn.textContent = "➕ Folgeseite auch laden";
        row.appendChild(nextBtn);
      }
      if (s.domain === "arcinsys-direkt" && s.citedPageHint) {
        const pageHint = document.createElement("div");
        pageHint.className = "qba-pagehint";
        pageHint.textContent = `Laut Quellenbeschreibung vermutlich Seite ${s.citedPageHint}`;
        row.appendChild(pageHint);
      }
      const statusEl = document.createElement("div");
      statusEl.className = "qba-status";
      statusEl.id = `qba-status-${i}`;
      statusEl.textContent = "noch nicht geprüft";
      row.appendChild(statusEl);
      const previewEl = document.createElement("div");
      previewEl.className = "qba-preview";
      previewEl.id = `qba-preview-${i}`;
      row.appendChild(previewEl);
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
      if (info && info.ok && info.via === "form-download-pending") {
        statusEl.textContent = "Bereit für Formular-Download (wird beim gemeinsamen Herunterladen ausgelöst)";
      } else if (info && info.ok) {
        const viaLabel =
          info.via === "mets"
            ? "über METS-Datei"
            : info.via === "dlibra-oai-mets"
            ? "über dLibra-METS (OAI)"
            : info.via === "dlibra-djvu"
            ? "über dLibra-METS (OAI)"
            : info.via === "dv1-html"
            ? "direkt aus Matricula-Seite (Original-JPEG)"
            : info.via === "bw-bild-php"
            ? "direkt aus Landesarchiv-BW-Seite (bild.php)"
            : info.via === "hidden-tab"
            ? "über Hintergrund-Tab"
            : info.via === "canvas-snapshot"
            ? "Canvas-Schnappschuss"
            : "Heuristik, experimentell";
        if (info.previewUnavailable) {
          // z.B. dLibra-DjVu-Seiten: kein <img>-fähiges Format. Statt eines
          // kaputten Bilds ehrlich erklären und nur den Download anbieten.
          statusEl.textContent = `Quelle geprüft (${viaLabel}) – Bildvorschau hier nicht möglich`;
        } else if (!isSafeUrl(info.imageUrl, true)) {
          statusEl.textContent = "Bild-URL verworfen (unzulässiges URL-Schema)";
        } else {
          statusEl.textContent = `Bild gefunden (${viaLabel})`;
          const img = document.createElement("img");
          img.src = info.imageUrl;
          img.className = "qba-thumb";
          img.addEventListener("error", () => {
            // z.B. gesperrte Seite ("aus gesetzlichen Gründen gesperrt")
            // oder Server-Problem - der Download-Link kann trotzdem greifen
            const note = document.createElement("div");
            note.className = "qba-caveat";
            note.textContent =
              "⚠ Vorschau konnte nicht geladen werden (evtl. gesperrte Seite oder Server-Problem) - Download-Link unten kann trotzdem funktionieren.";
            previewEl.insertBefore(note, img.nextSibling);
          });
          previewEl.appendChild(img);
        }

        if (info.caveat) {
          const note = document.createElement("div");
          note.className = "qba-caveat";
          note.textContent = `⚠ ${info.caveat}`;
          previewEl.appendChild(note);
        }
        const dlUrl = info.downloadUrl || info.imageUrl;
        const dl = document.createElement("a");
        if (isSafeUrl(dlUrl, true)) dl.href = dlUrl;
        dl.download = `${buildFileLabel(sources[i], info)}.${guessExtension(info)}`;
        dl.target = "_blank";
        dl.rel = "noopener";
        dl.className = "qba-download";
        dl.textContent = "⬇ Bild herunterladen (danach manuell bei WikiTree hochladen)";
        previewEl.appendChild(dl);
      } else {
        statusEl.textContent = `kein Bild automatisch gefunden – es wird nur der Link zitiert (${(info && info.reason) || "unbekannt"})`;
      }

      if (info && info.suggestedUrl && isSafeUrl(info.suggestedUrl, false)) {
        const applyBtn = document.createElement("button");
        applyBtn.className = "qba-apply-suggestion";
        applyBtn.textContent = "💡 Quelle auf gefundenen DFG-Viewer-Link umstellen";
        applyBtn.addEventListener("click", () => {
          sources[i].url = info.suggestedUrl;
          sources[i].domain = "dfg-viewer";
          sources[i].imageInfo = null;
          sources[i].linkText = info.suggestedUrl;
          const oldRow = rowForIndex(i);
          if (oldRow) oldRow.remove();
          renderRow(i);
        });
        previewEl.appendChild(applyBtn);
      }
    }

    function rowForIndex(i) {
      return list.querySelector(`.qba-check[data-idx="${i}"]`)?.closest(".qba-row") || null;
    }

    const checkBtn = panel.querySelector("#qba-check-images");
    let checking = false;
    checkBtn.addEventListener("click", async () => {
      if (checking) return; // Doppelklick: keine parallelen Prüfläufe (doppelte Anfragen/Fenster)
      checking = true;
      checkBtn.disabled = true;
      try {
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
      } finally {
        checking = false;
        checkBtn.disabled = false;
        panel.querySelector("#qba-insert").disabled = false;
        panel.querySelector("#qba-download-all").disabled = false;
      }
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
      const formDownloads = chosen.filter((s) => s.imageInfo && s.imageInfo.ok && s.imageInfo.via === "form-download-pending");

      if (withImages.length === 0 && formDownloads.length === 0) {
        alert("Für keine der ausgewählten Quellen wurde ein Bild gefunden - nichts zum Herunterladen.");
        return;
      }

      const folderName = buildFolderName();
      const files = withImages.map((s, i) => {
        const ext = guessExtension(s.imageInfo);
        const num = String(i + 1).padStart(2, "0");
        return { url: s.imageInfo.downloadUrl || s.imageInfo.imageUrl, suggestedName: `${num}-${buildFileLabel(s, s.imageInfo)}.${ext}` };
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

        // Formular-basierte Downloads (Landesarchiv BW) separat behandeln:
        // jeder öffnet kurz einen eigenen Tab und schickt das Formular ab.
        const formResults = [];
        for (let i = 0; i < formDownloads.length; i++) {
          const s = formDownloads[i];
          const num = String(withImages.length + i + 1).padStart(2, "0");
          const nameBase = `${num}-${buildFileLabel(s, s.imageInfo)}`;
          btn.textContent = `Formular-Download ${i + 1}/${formDownloads.length} …`;
          const r = await chrome.runtime.sendMessage({
            type: "SUBMIT_FORM_AND_DOWNLOAD",
            payload: { url: s.url, folder: folderName, suggestedNameBase: nameBase }
          });
          formResults.push(r);
        }
        const formFailed = formResults.filter((r) => !r.ok);

        const totalOk = result.results.length - failed.length + (formResults.length - formFailed.length);
        const totalCount = result.results.length + formResults.length;
        if (failed.length > 0 || formFailed.length > 0) {
          const reasons = [...failed.map((f) => f.reason), ...formFailed.map((f) => f.reason)].join("; ");
          alert(`Ordner "${result.folder}": ${totalOk} von ${totalCount} Dateien heruntergeladen. Fehler: ${reasons}`);
        } else {
          alert(`Fertig: ${totalCount} Datei(en) + Quellenangaben in den Download-Unterordner "${result.folder}" gespeichert.`);
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

    panel.querySelector("#qba-close").addEventListener("click", () => {
      if (activePickingCancel) activePickingCancel(); // laufenden Auswahlmodus sauber beenden
      panel.remove();
    });
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

  // Nur für Tests (test/content.test.js): Der Test setzt vor dem Laden
  // globalThis.__QBA_TEST__ und bekommt dann die reinen Funktionen. Im
  // Browser ist die Variable nie gesetzt - dort ändert sich nichts.
  if (globalThis.__QBA_TEST__) {
    globalThis.__QBA_TEST__ = {
      SOURCE_TYPES,
      classifyDomain,
      isSafeUrl,
      citationDocPage,
      buildCitationPageSuffix,
      buildCitationText,
      institutionInfoForSource,
      domainLabel,
      requestImageInfo,
      cleanLabel,
      humanizeHost
    };
  }
})();
