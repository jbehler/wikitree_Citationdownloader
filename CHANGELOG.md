# Änderungsprotokoll

Alle Versionen, neueste zuerst. Die Installations- und Bedienungshinweise stehen in der README.md.

## 0.18.0

- **Upload-Vorbelegung (Special:UploadPhoto):**
  - Die numerische `person_id` für den Upload-Link wird auf der Profilseite per
    WikiTree-API (`getProfile`, Feld `Id`, mit `appId=QuellenbilderAssistent`)
    ermittelt, wenn die Seite sie nicht selbst liefert. Es wird nichts geraten;
    bei Fehlern gibt es wie bisher keinen Upload-Link.
  - „⬆ Bei WikiTree hochladen“ merkt sich Bild-URL, Dateinamen und Quellenangabe
    (`chrome.storage.session`, nur im Arbeitsspeicher, Einträge verfallen nach
    1 h) und öffnet die Upload-Seite. Dort erscheint ein Panel: Bild ins
    Dateifeld legen, Quellenangabe ins Beschreibungsfeld eintragen (hängt an,
    überschreibt nie) oder kopieren. Ist ein Feld nicht eindeutig erkennbar,
    wählt man es per Klick. **Das Formular wird nie automatisch abgesendet** –
    „Hochladen“ klickt der Nutzer selbst. DjVu-Bilder: keine Vorbelegung
    (erst konvertieren).
  - Die HTML-Struktur der Upload-Seite ist nicht verifiziert; die Erkennung der
    Felder ist daher bewusst generisch mit Zielwahl als Rückfall.
  - **Neue Berechtigungen:** `storage` (nur für `storage.session`: die
    vorbereiteten Uploads zwischen Profilseite und Upload-Seite) und der Host
    `https://api.wikitree.com/*` (nur Abruf der Personen-Id über die
    öffentliche WikiTree-API, ohne Cookies).
- Bugfix: Auf der Profilseite meldete 'In Editor einfügen' Erfolg, obwohl kein Bio-Editor offen war (Text landete in einem unsichtbaren Feld). Jetzt nur sichtbare Felder als Ziel, auf der Profilseite klarer Hinweis + Link zur Bearbeitungsseite (falls auf der Seite vorhanden).
- **Sicherheit:**
  - Allowlist für Bild- und Download-URLs: übernommen werden nur `http`/`https`
    sowie `data:image/png|jpeg|gif|webp` (kein SVG); siehe `isSafeExternalUrl`
    in `lib/parsers.js`.
  - Quellenerkennung erfolgt nach Hostname statt über Teilstrings der URL.
  - `extractCdataOrText` toleriert Namespace-Präfixe.
- **Struktur:**
  - Reine Parser und Hilfsfunktionen liegen in `lib/parsers.js`. Der Service
    Worker lädt sie per `importScripts`, Node per `module.exports`.
  - Die Quelltyp-Registry `SOURCE_TYPES` in `content.js` ersetzt die bisherigen
    if/else-Ketten. Die Zitattexte sind unverändert (Golden-Test gegen den
    Stand vor dem Refactoring).
- **Tests & CI:** Tests mit `node:test` und Fixtures (`npm test`), ESLint
  (`npm run lint`) und ein GitHub-Actions-Workflow (`.github/workflows/ci.yml`)
  mit Lint, Tests und Syntaxprüfung.
- **Bedienung:**
  - Meldungen erscheinen als Zeile im Panel statt in `alert()`.
  - Einfügen und Kopieren sind schon vor der Bildprüfung möglich.
  - Neuer Button „📋 Ausgewählte Zitate kopieren“.
  - Pausen gibt es nur noch bei echten Netzabrufen.
- **Bearbeitungsseite:**
  - Das Panel läuft jetzt auch auf `index.php?title=Special:EditPerson&u=<ID>`.
  - Quellen werden aus dem Bio-Wikitext gelesen.
  - Wortgleiche Zitate werden nicht doppelt eingefügt.
  - Neuer Link „⬆ Bei WikiTree hochladen“ (`Special:UploadPhoto&person_id=<ID>`).
    Er erscheint nur auf der Bearbeitungsseite, weil nur dort die numerische
    Personen-ID verlässlich in der URL steht.
  - Der Download-Ordner heißt `WikiTree-<ID>`.
- **Berechtigungen:** `tabs` und `activeTab` entfernt, weil sie nicht benötigt
  werden (geprüft per Codesuche). Verbleibend: `scripting` und `downloads`.
- **Version:** `manifest.json`, `package.json` und `package-lock.json` auf 0.18.0.

## 0.17.1

- **Bugfix Download-Umleitung (background.js):** Der `onDeterminingFilename`-
  Listener für die Landesarchiv-BW-Formular-Downloads wurde bisher pro Lauf
  dynamisch registriert und wieder entfernt. Chrome erlaubt für dieses
  Ereignis aber ausdrücklich nur **genau einen Listener pro Extension**, der
  `suggest()` genau einmal aufruft. Überlappende Läufe oder verspätet
  ausgelieferte Ereignisse (schnelle Downloads, Service-Worker-Neustart)
  führten deshalb zu `Unchecked runtime.lastError: Unexpected determineFilename
  call` in der Konsole. Jetzt: genau ein persistenter Listener, synchron beim
  Service-Worker-Start registriert, der nur Downloads übernimmt, die
  nachweislich aus einem eigenen Formular-Lauf stammen (ID-Abgleich über
  `onCreated`, Fallback: erster noch erwarteter Download desselben Hosts wie
  die geöffnete plink-Seite). Downloads mit `byExtensionId` – also auch alle
  eigenen `chrome.downloads.download`-Aufrufe – werden nie angetastet, und
  fremde Downloads, die zufällig während eines Laufs starten, behalten ihren
  Standardnamen statt umbenannt zu werden.
- **Seitenangabe im Zitat: Dokumentenseite vs. Beschreibungs-Hinweis
  (content.js):** Im Zitat gibt es je nach Quelltyp zwei mögliche
  Seitenzahlen: den Hinweis aus der Quellenbeschreibung („S. 12“ im
  Textumfeld des Links) und die tatsächlich ermittelte Dokumentenseite des
  Digitalisats (gewählte Seite bei dLibra, „Bild 74“ bei Landesarchiv BW,
  aktiver Seiten-Link bei Matricula, `tx_dlf[page]` bei METS/DFG-Viewer).
  Künftig gilt: **Beide werden angezeigt, wenn sie abweichen** – z. B.
  „(Seite 12, im Dokument Bild 74)“; so bleibt erkennbar, was die
  Beschreibung angibt und wo es im Digitalisat tatsächlich liegt. Stimmen
  beide überein, genügt „(Seite N)“ – der Hinweis ist dann durch das
  Digitalisat bestätigt. Ist nur eine Angabe bekannt, wird nur diese
  gezeigt; ein alleiniger Beschreibungs-Hinweis bleibt ausdrücklich als
  „vermutlich“ gekennzeichnet (bei Landesarchiv BW stand er bisher ohne
  diesen Vorbehalt als feste Seite im Zitat). Matricula- und DFG-Viewer-
  Zitate zeigen eine ermittelte Seite jetzt überhaupt erst an; für dLibra
  (wbc.poznan.pl) ändert sich nichts, weil die gewählte Seite dort immer
  der Beschreibungs-Hinweis ist, wenn einer vorhanden war.

## 0.17.0

- **dLibra-Links (wbc.poznan.pl) werden jetzt automatisiert verarbeitet
  (background.js, content.js).** Bisher (seit 0.12.0) wurden
  wbc.poznan.pl-Links bewusst nicht automatisiert, weil die damalige
  Beispiel-Publikation den Hinweis „Secured publication" zeigte. Neu
  nachgeprüft: Dieser Text ist Teil der allgemeinen Dialog-Templates der
  dLibra-Seiten und erscheint auch bei frei zugänglichen Publikationen –
  daraus lässt sich keine verlässliche Aussage ableiten. Die Zugänglichkeit
  steht stattdessen maschinenlesbar im METS (`dlibra_avs:PublicAccess`):
  `true` = frei (Beispielpublikation 147448/156210, live geprüft), `false` =
  geschützt → dann ehrliche Meldung statt Umgehungsversuch.
- **Weg 3 (wbc.poznan.pl): METS über den OAI-Endpunkt.** dLibra liefert für
  jede Edition METS-XML über `/dlibra/oai-pmh-repository.xml?verb=GetRecord
  &metadataPrefix=mets&identifier=oai:<host>:<editionId>` (Muster steht im
  `data-oaiurl`-Attribut der Content-Seite, live verifiziert). Aus den METS
  kommen: Titel (mets LABEL/dc:title), dc:date, dc:rights und der fileSec
  mit allen Seiten-Dateien (`DjVu_original<N>` = Seite N+1; die
  Gesamtdokument-Datei `index.djvu` wird ausgeklammert). Seitenreihenfolge
  über die ID-Suffixe – die structMap enthält kein ORDER-Attribut.
- **DjVu-Ehrlichkeit:** dLibra-Holdings sind häufig DjVu-Dateien
  (`image/x.djvu`, live geprüft: HTTP 200, ~1 MB/Seite). DjVu ist kein
  `<img>`-fähiges Format – statt eines kaputten Vorschaubilds erscheint der
  Status „Quelle geprüft – Bildvorschau hier nicht möglich" mit klarer
  Erklärung, und der Download-Link liefert die `.djvu`-Datei der Zielseite
  (z.B. mit DjVuViewer/GIMP öffnen und als JPEG speichern). Bei
  JPEG-/PNG-Holdings funktioniert Vorschau+Download wie bei den METS-Quellen
  des DFG-Viewers.
- **Quellenangabe mit Objekt-Metadaten:** Titel (aus METS), Seitenzahl (aus
  der Quellenbeschreibung oder gewählter Seite) und Rechteangabe
  (dc:rights, z.B. „Biblioteka Uniwersytecka w Poznaniu") werden ins Zitat
  übernommen; eine Lizenz wird bewusst NICHT behauptet (nicht verifiziert).
- **Server-Browserprüfung (PoW-Challenge) ehrlich gemeldet:** Bei
  Nicht-Browser-UAs antwortet wbc.poznan.pl zeitweise mit „High Load –
  Verifying Browser" (JS-Proof-of-Work, Cookie `captcha_pow`). Die
  Extension umgeht das bewusst nicht: Wird die Challenge erkannt, erscheint
  der Hinweis, die Quelle einmal normal im Browser zu öffnen (der Server
  setzt dabei sein Prüf-Cookie) und die Prüfung danach zu wiederholen. Im
  Extension-Fetch (Browser-UA + Cookie-Jar) läuft der Abruf sonst wie im
  Browser.
- **manifest.json:** Version 0.17.0; neue `host_permissions`:
  `https://*.wbc.poznan.pl/*` und `https://wbc.poznan.pl/*`.

## 0.16.1

- **Bugfix: Landesarchiv-BW-Vorschau nach Server-Update (background.js):**
  Seit dem BW-Server-Update rendert der GET-Abruf der
  `ofs21/bild_zoom/zoom.php`-Seiten (ohne Cookies, wie die Extension
  abfragt) oft den JS-getriebenen Legacy-Betrachter: Die Bilddatei wird
  erst per Inline-JS aus den Formularfeldern gebaut, es steht keine
  statische `imageSource` mit `bild.php`-Quelle im HTML. Die Extension
  repliziert jetzt den Formular-Submit des Betrachters selbst (POST der
  Felder mit `originalBilddatei` – live am Beispiel-Link verifiziert: die
  Antwort rendert serverseitig die `bild.php`-Quelle) und liest daraus die
  Bild-URL. Der Versuch läuft still beim „Bildvorschau prüfen“ – es öffnet
  sich kein Tab/Fenster, nichts wird dauerhaft am Server geändert; es ist
  derselbe POST, den der Betrachter beim Blättern selbst abschickt.
  Scheitern alle Versuche, verhält sich der BW-Link wie bisher („bereit
  für Formular-Download“).
- **Robustheits-Fixes derselben Stelle (background.js):**
  - Attribute werden jetzt auch **unquoted** gelesen (`value=…` ohne
    Anführungszeichen) – die Legacy-Variante nutzt teils Legacy-HTML;
    vorher gingen dort `name`/`value` der Betrachter-Formularfelder und
    der `originalBilddatei`-Optionen verloren und der POST-Renderversuch
    lief nie an.
  - Relative `bild.php`-URLs werden gegen die **finale Antwort-URL** (nach
    Server-Weiterleitung, z. B. `www` → `www2` oder `plink` →
    `bild_zoom/zoom.php`) aufgelöst, nicht gegen den ursprünglich
    gerenderten Link – sonst landet `bild.php` im falschen Pfad (z. B.
    `/bild.php` statt `/ofs21/bild_zoom/bild.php`).
  - Die `imageSource` wird tolerant gegen Pfad-Präfixe gelesen (z. B.
    `/ofs21/bild_zoom/bild.php?…` statt nur direkt `bild.php?…`), und
    gerenderte `&amp;`/`&#38;`/`&#x26;`/`\u0026`-Kodierungen werden dekodiert –
    sonst übernimmt `&amp;zoom=…` als Parameter-NAME und der Server
    liefert Fehler statt des Scans.
  - Bild-URLs (Vorschau UND Download) werden wie bei Matricula bewusst
    auf https hochgestuft – http-Vorschauen wären in der
    https-WikiTree-Seite als Mixed Content blockiert.
  - Seitenauswahl-Optionen („Bild N“) werden über denselben toleranten
    Attribut-Reader gelesen – unquoted Optionen der Legacy-Variante
    liefern sonst keine Seitenzahl.
  - Letzter Versuch mit Cookies (`credentials: "include"`): Der
    browserseitige Session-/Consent-Cookie kann dafür sorgen, dass der
    Server die moderne Variante mit statischer `imageSource` direkt
    rendert; dieser erneute GET läuft nur, wenn alle cookie-freien
    Versuche scheitern.
- **plink-Format ?f=... auflösen + ehrliche Diagnose für tote ?i-Links (background.js/content.js):**
  Live-Probe über beide plink-Formate: Das Format
  `plink/?f=<archiv>-<bestand>-<bild>` lebt noch - es leitet auf
  `bild_zoom/plink_screen.php?bestand=…&id=…&gewaehlteSeite=…jpg`
  weiter; diese Seite ist ein JS-Weiterleitungs-Stub
  (`self.location.href = "zoom.php?…"`) zum eigentlichen zoom.php-
  Betrachter. Die Extension repliziert jetzt diese Kette: aus der
  plink_screen-Antwort-URL wird der zoom.php-Abruf gebaut (gleiche
  Query-Parameter, `plink_screen.php` -> `zoom.php`; screenbreite/
  screenhoehe sind optional - zoom.php antwortet auch ohne sie mit
  der statischen bild.php-Quelle, live geprüft) und dort normal
  extrahiert (inkl. POST-Renderversuch für die Legacy-Variante).
  Das Format `plink/?i=<id>` ist dagegen tot: der Server antwortet
  für JEDEN (auch mit Browser-UA und allen Browser-Headern) mit
  HTTP 200 ohne Inhalt (leere Seite), www2/ofs21-Varianten 404.
  Die Extension erkennt die leere ?i-Antwort und zeigt beim
  „Bildvorschau prüfen“ den Grund „Link antwortet leer …“ statt
  dem falschen „bereit für Formular-Download“-Versprechen; das
  Zitat nennt den Link als veraltet. Alte Quellen-Links mit
  ?i=<id> müssen auf eine aktuelle Landesarchiv-BW-Digitalisat-
  Seite (z. B. www2.landesarchiv-bw.de/ofs21/bild_zoom/zoom.php?…
  ) aktualisiert werden - mit einem aktuellen Link liefert 0.16.1
  die Vorschau (unquoted-HTML + POST-Renderversuch).
- **manifest.json:** Version auf 0.16.1 erhöht; Host-Permissions decken
  die Bild-Hosts bereits ab, eine Änderung war nicht nötig.

## 0.16.0

- **Bildvorschau für Landesarchiv Baden-Württemberg (bild_zoom-Links):**
  Die `ofs21/bild_zoom/zoom.php`-Seiten des Landesarchivs BW rendern
  serverseitig die URL des angezeigten JPEGs in die Konfiguration des
  Zoom-Viewers ins HTML
  (`$("#imageViewerContainer…").verySimpleImageViewer({ imageSource:
  'bild.php?drehen=&zoom=100&…&originalBilddatei=%2Fdata%2Fbildcms%2F…' })`).
  Die Extension liest diese `imageSource` jetzt direkt aus (rein per HTTP,
  kein JavaScript nötig, kein Session-Cookie nötig) und zeigt das Scan-
  Bild in der Vorschau an – der Seitenzähler („Bild N“) wird aus der
  `selected`-Option der Seitenauswahl ermittelt, der Dokumenttitel
  (z. B. „456 C Nr. 1792, 2 cm“) aus `<div id="titel">`.
- **Download in voller Qualitätsstufe:** Für den Download wird dieselbe
  `bild.php`-URL mit `jpegQualitaetZoombild=100` benutzt (live bestätigt:
  3496×3098 px, ~4,1 MB statt ~1 MB bei der Viewer-Einstellung 60 und
  statt ~985 KB beim bisherigen Formular-Download `download.php`, der
  zusätzlich einen Text-/Typenschild-Balken anhängt).
- **Rechtekategorie ins Zitat:** Auf den BW-Seiten ist eine
  Rechtekategorie-Badge verlinkt (z. B. UND = „Rechte unbestimmt“ auf
  rightsstatements.org). Wenn vorhanden, nimmt das Zitat diese Angabe
  jetzt mit; sonst bleibt es beim bisherigen Hinweis.
- **Formular-Download bleibt als Fallback:** BW-Links, die keine
  `bild.php`-Quelle enthalten (z. B. Strukturansicht), verhalten sich wie
  bisher („bereit für Formular-Download“, Submit erst beim gemeinsamen
  Herunterladen). Bewusst wird für BW-Seiten **keine** generische
  `<img>`-Heuristik mehr durchlaufen – die Seiten enthalten viele
  UI-Grafiken (Logos, Buttons), die sonst als falsches „Bild“ enden
  könnten.
- **manifest.json:** Version auf 0.16.0 erhöht; Host-Permissions
  (`https://*.landesarchiv-bw.de/*`) decken den Bild-Host bereits ab,
  eine Änderung war nicht nötig.
- **Hinweis robots.txt (Landesarchiv BW):** `www2.landesarchiv-bw.de`
  verbietet in der robots.txt automatisierten Zugriff für alle Crawler
  außer Googlebot/Yahoo (`Disallow: /`). Die Extension ist kein Crawler:
  Sie ruft genau die eine Seite ab, deren Link du im Profil anklickst bzw.
  deren Prüfung du per Klick startest (gleiche Situation wie beim
  bereits vorhandenen Formular-Download) – kein Blättern, kein Sammeln
  ganzer Bestände. Das Bild bleibt trotzdem eine manuelle
  Download-und-Upload-Aufgabe für dich, wie bei allen Quellen.

## 0.15.0

- **Bildvorschau für Matricula funktioniert jetzt wie bei Landesarchiv
  NRW (background.js, content.js):** Die Direkt-URLs der Scans stehen
  base64-kodiert in der JavaScript-Variable `dv1` im HTML jeder
  Matricula-Registerseite (`dv1 = new arc.imageview.MatriculaDocView(
  "document", { "labels": [...], "files": ["/image/<base64>/", ...] })`).
  Die Extension dekodiert diese Einträge nun per HTTP und zeigt das
  Original-JPEG in Scan-Auflösung an (bestätigt: HTTP 200,
  `image/jpeg`, ~1 MB pro Scan; http **und** https erreichbar - die
  Vorschau-URL wird bewusst auf https hochgestuft, damit sie in der
  https-WikiTree-Seite nicht als Mixed Content blockiert wird).
  Der `?pg=N`-Parameter des Links entspricht dabei `files[N-1]`;
  liegt die Seitenzahl außerhalb des Kirchenbuchs, erscheint eine
  klare Fehlermeldung. Es öffnet sich **kein** sichtbares Fenster
  mehr, und auch für das gemeinsame Herunterladen werden jetzt die
  Original-JPEGs statt eines Canvas-Schnappschusses verwendet.
  Der Hidden-Tab-Canvas-Schnappschuss bleibt nur noch als letzter
  Fallback, falls die `dv1`-Extraktion scheitert.
- **Hinweis bei gesperrten Seiten:** Einige Scans sind bei Matricula
  „aus gesetzlichen Gründen gesperrt". Lädt die Vorschau nicht,
  erscheint jetzt ein verständlicher Hinweis statt eines kaputten
  Bilds (background.js, content.js).
- **manifest.json:** Version auf 0.15.0 erhöht; Host-Permissions
  (`https://*.matricula-online.eu/*`) decken den Bild-Host
  bereits ab, eine Änderung war nicht nötig.

## 0.14.0

- **Stabilität/Robustheit (background.js):** Alle externen HTTP-Abrufe
  laufen jetzt über einen gemeinsamen Fetch-Helper mit 20-Sekunden-Timeout
  (`AbortController`). Hängende Server blockieren die Bildersuche nicht
  mehr unbegrenzt; stattdessen erscheint eine verständliche
  Fehlermeldung.
- **Landesarchiv-BW-Download nochmal präzisiert:** Der Sicherheitsnetz-
  Timeout für die Dateinamens-Umleitung startet jetzt erst, wenn der
  Download tatsächlich registriert wurde - bei langsamen Servern wird der
  vorgeschlagene Ordner-/Dateiname nun zuverlässiger angewendet. Der
  Listener wird zudem auf allen Abbruchwegen (kein Formular gefunden,
  kein Download, Fehler) aufgeräumt.
- **Windows-Dateinamen:** Reservierte Namen wie `CON`, `NUL`, `COM1` …
  als Ordner-/Dateiname bekommen jetzt ein `_` vorangestellt, statt
  einen ungültigen Download-Namen zu erzeugen.
- **Sicherheitsfix im Panel:** Linktexte und URLs aus den
  Quellenangaben werden nur noch über sichere DOM-APIs ins Panel
  geschrieben - dort eingeschleustes HTML (z. B. über
  `<script>`-Text in einer Quelle) kann die Extension-UI nicht mehr
  manipulieren.
- **Zielfeld-Auswahl:** Der Auswahlmodus lässt sich jetzt mit `Esc`
  abbrechen und wird sauber aufgeräumt (auch bei erneutem Klick oder
  beim Schließen des Panels).
- **Sources-Header:** Vorhandene Überschriften wie `== Sources ==`
  oder `=== Sources ===` werden zeilengenau erkannt - sie bleiben beim
  Einfügen unverändert, die neuen Quellenzeilen landen direkt darunter
  (zuvor konnte der einfache String-Ersatz solche Header zerlegen).
- **„Bildvorschau prüfen“:** Doppelklick startet keinen zweiten
  Prüflauf mehr; bereits geprüfte Quellen werden aus dem Cache
  angezeigt statt erneut angefragt.
- **Aufräumarbeiten:** Ein zentraler Message-Handler statt fünf
  separater Listener; `unescape()` durch `TextEncoder`-basierte
  Base64-Kodierung ersetzt (kein Deprecated-API mehr).

## 0.13.1

- **Bugfix Landesarchiv-BW-Download (Ordner/Dateiname wurden ignoriert):**
  Der `onDeterminingFilename`-Listener wurde bisher entfernt, sobald der
  Download registriert war (`onCreated`) - `onDeterminingFilename`
  feuert aber typischerweise ERST danach (Chrome muss dafür u.a.
  Content-Disposition-Header auswerten). Der Listener war also schon
  weg, bevor er je die Chance hatte, Ordner/Dateinamen vorzuschlagen -
  die Datei landete deshalb unbenannt im normalen Downloads-Ordner
  statt im gewünschten Unterordner. Jetzt wird explizit auf das
  tatsächliche Feuern von `onDeterminingFilename` gewartet (mit
  8-Sekunden-Timeout als Sicherheitsnetz), bevor der Tab geschlossen und
  das Ergebnis zurückgegeben wird.

## 0.13.0

- **Landesarchiv Baden-Württemberg: Formular-basierter Bilddownload.**
  Diese Seiten bieten keinen direkten Bild-Link, sondern lösen den
  Download über ein per JavaScript abgeschicktes Formular aus
  (`document.pdfForm.action='download.php';document.pdfForm.submit();`).
  Beim „Bildvorschau prüfen“ passiert hier bewusst noch nichts (kein
  Tab, kein Fetch) - erst beim expliziten Klick auf „gemeinsam
  herunterladen“ öffnet die Extension kurz einen Tab, schickt das
  Formular ab und leitet den ausgelösten Download automatisch in den
  benannten Zielordner um (`chrome.downloads.onDeterminingFilename`).
  Keine Bildvorschau möglich (es gibt keine direkt referenzierbare
  Bild-URL vorab) - im Panel erscheint stattdessen der Status „Bereit
  für Formular-Download“. Neue `host_permissions`: `landesarchiv-bw.de`
  (auch `http://`, da der Beispiel-Link kein `https` nutzt).
- **wbc.poznan.pl (dLibra, Polen): bewusst NICHT automatisiert.** Die
  geprüfte Beispielpublikation ist explizit captcha-/zugangsgeschützt
  ("Secured publication", reCAPTCHA-Hinweis). Das wird nicht umgangen -
  die generierte Quellenangabe benennt das jetzt auch explizit, statt
  nur "noch nicht unterstützt" zu sagen.
- „picture“ als weiteres Wort für die Seitenzahl-Erkennung aus der
  Quellenbeschreibung ergänzt (Beispiel: „picture 74“ bei Landesarchiv
  BW).

## 0.12.0

- **Generische Quellenerkennung statt Domain-Liste.** Bisher musste jede
  Archiv-Domain einzeln im Erkennungsmuster ergänzt werden (Matricula,
  Landesarchiv NRW, Arcinsys, …) - das skaliert nicht, wenn ständig neue
  Systeme auftauchen (z. B. Landesarchiv Baden-Württemberg mit eigenem
  `plink`-Permalink-System, oder die polnische Digitalbibliothek
  `wbc.poznan.pl` auf Basis von dLibra - beides komplett andere Systeme
  als die bisher unterstützten). Die Extension durchsucht jetzt
  stattdessen **alle externen Links innerhalb von WikiTrees eigener
  Quellenliste** (`<li class="x-src">`, also die Fußnoten unter
  "Sources") - unabhängig von der Domain. Das ist sicher genug, um kein
  Rauschen von Navigation/Werbung/WikiTree-eigenen Links aufzunehmen,
  erkennt aber jetzt jede zitierte externe Quelle.
- Für bisher unbekannte Systeme („sonstige-quelle“): Link wird korrekt
  zitiert (inkl. abgeleitetem Institutionsnamen aus der Domain und
  Seitenzahl-Hinweis aus der Quellenbeschreibung, falls vorhanden), aber
  **kein** automatischer Bildabruf-Versuch (dafür fehlen sowohl
  `host_permissions` als auch eine passende Extraktionslogik) und
  **keine** Lizenzbehauptung - stattdessen der Hinweis, dass dieses
  System noch nicht unterstützt wird.
- Findet sich auf einer Seite gar keine `<li class="x-src">`-Struktur
  (z. B. weil WikiTree das Layout mal ändert), fällt die Extension auf
  das alte, engere Verhalten zurück (nur bekannte Archiv-Domains, ganze
  Seite durchsucht) - so bleibt zumindest die bisherige Funktionalität
  erhalten.

## 0.11.1

- **Bugfix Seitenzahl-Erkennung:** Das Muster für die Seitenzahl aus der
  Quellenbeschreibung (siehe 0.10.0) kannte weder das englische Wort
  „page“ noch „Blatt“/„Bl.“ - nur „S.“, „Seite“, „p.“, „pag.“, „fol.“.
  Beispiele wie „page 60, Certificate 60“ oder „Blatt 5, Zertifikat 5“
  wurden dadurch übersehen (und, wichtig, auch nicht mit der daneben-
  stehenden Zertifikatsnummer verwechselt - nur die echte Seiten-/
  Blattangabe wird erfasst).

## 0.11.0

- **Arcinsys-Direktlinks: passender DFG-Viewer-Link wird vorgeschlagen.**
  Solche Links zeigen nur auf das Gesamtdokument (siehe 0.10.0). Jetzt
  sucht die Extension zusätzlich auf der Arcinsys-Seite selbst nach dem
  dort oft vorhandenen Link „In DFG-Viewer öffnen“ (ggf. über eine
  verlinkte „digitalMediaViewer“-Unterseite). Wird er gefunden, baut die
  Extension daraus einen normalen `tx_dlf[id]`/`tx_dlf[page]`-Permalink -
  bei bekannter Seitenzahl (aus der Quellenbeschreibung, siehe 0.10.0)
  direkt inklusive Bildabruf über die bereits bewährte METS-Logik.
  Im Panel erscheint dann der Button „💡 Quelle auf gefundenen
  DFG-Viewer-Link umstellen“ - ein Klick ersetzt die Quelle durch den
  gefundenen Link (inkl. „Folgeseite“-Funktion, korrekter Institutions-
  erkennung usw., wie bei jedem anderen DFG-Viewer-Link).
- Nicht verifiziert: ob andere Arcinsys-Länder-Installationen denselben
  Linktext/dieselbe URL-Struktur für "In DFG-Viewer öffnen" verwenden.
  Schlägt die Suche fehl, bleibt es beim bisherigen Verhalten (Link
  zitieren, manuell navigieren).

## 0.10.0

- **Direkte Arcinsys-Links (Gesamtdokument statt Einzelseite) werden
  jetzt erkannt.** Bisher wurden Links wie
  `arcinsys.hessen.de/arcinsys/showArchivalDescriptionDetails?...` gar
  nicht erst gefunden (fehlte im Erkennungs-Muster). Solche Links zeigen
  auf das ganze Dokument, nicht auf eine bestimmte Seite - eine
  automatische Bildsuche würde hier nur raten. Deshalb bewusst **kein**
  automatischer Abruf für diesen Link-Typ: Die Extension zitiert den
  Link (inkl. Institutionsname, ohne Lizenzbehauptung) und weist im
  Panel klar darauf hin, im Dokument selbst zur passenden Seite zu
  navigieren und das Bild manuell herunterzuladen.
- **Seitenzahl-Hinweis aus der Quellenbeschreibung:** Falls im
  unmittelbaren Textumfeld des Links auf WikiTree bereits eine
  Seitenangabe steht (z. B. „S. 123“, „Seite 46“, „fol. 12“), wird das
  erkannt und sowohl in der Zeile im Panel als auch im generierten Zitat
  angezeigt („vermutlich Seite …“) - rein informativ zur Orientierung
  beim manuellen Navigieren, keine Grundlage für einen automatischen
  Bildabruf.

## 0.9.1

- **Bugfix Arcinsys Hessen:** Die eigentlichen Bild-/METS-Dateien liegen
  auf einer dritten Domain, `digitalisate-he.arcinsys.de` (Teil der
  `arcinsys.de`-Familie, nicht `arcinsys.hessen.de`). Ohne diese Domain
  in `host_permissions` konnte für Arcinsys-Hessen-Quellen gar nichts
  geladen werden. Jetzt ergänzt: `*.arcinsys.de` (https und http, da die
  METS-URLs dort teils noch per `http://` referenziert werden). Das
  deckt vermutlich auch andere Arcinsys-Länder ab, falls die dortigen
  Digitalisate ähnlich benannten Subdomains von `arcinsys.de` folgen
  (ungetestet für Niedersachsen/Schleswig-Holstein).
- **Lizenzrecherche Arcinsys Hessen (Ergebnis: nichts Konkretes
  gefunden).** Geprüft: die allgemeine Arcinsys-Bedienungsanleitung
  (keine Aussage zu Bildrechten), die 2021 unterzeichnete „Open Access
  Policy der Kulturerbe-Einrichtungen in Hessen“ (Hessisches
  Landesarchiv ist Unterzeichner, aber es ist eine Selbstverpflichtung
  zu „so offen wie möglich“ mit einem Stufenplan - **kein** konkretes
  "alle Digitalisate = CC-BY-SA" wie bei Landesarchiv NRW), sowie eine
  echte Arcinsys-Hessen-Objektdetailseite (kein Lizenz-/Rechtehinweis
  auf der Seite selbst). Ergebnis: Arcinsys Hessen bleibt in der
  Extension bewusst ohne konkrete Lizenzangabe - die generierte
  Quellenangabe fordert stattdessen weiterhin auf, die Bedingungen
  direkt bei der Institution zu prüfen.

## 0.9.0

- **Landesarchiv-NRW-Lizenz jetzt mit verifizierter, aktueller Quelle
  belegt.** Die Zitat-Vorlage verlinkt jetzt direkt auf
  `https://www.landesarchiv-nrw.de/digitalisate/LAV_NRW_Nutzungsbedingungen_Digitalisate.pdf`
  (vom Nutzer gefunden und von mir inhaltlich geprüft) statt nur die
  Lizenz zu behaupten. Zusätzlich ergänzt: Auflage, den/die Autor*in
  bzw. Urheber*in zu nennen (falls bekannt), und bei Online-Nutzung den
  beständigen Verweis (Permalink) zur Fundstelle in den Findmitteln
  anzugeben - beides steht so in den offiziellen Nutzungsbedingungen.
  Ein früher gefundenes, inhaltsgleiches PDF unter `lav.nrw.de` (Stand
  2022) ist inzwischen offline (Redirect zur Startseite) - das neue PDF
  liegt direkt auf der Digitalisate-Domain, für die ohnehin schon
  `host_permissions` besteht.

## 0.8.0

- **Institution wird dynamisch erkannt statt fest "Landesarchiv NRW"
  anzunehmen.** Bei DFG-Viewer-Links liest die Extension jetzt die Domain
  der referenzierten METS-Datei (`tx_dlf[id]`) aus und leitet daraus den
  Institutionsnamen ab - für bekannte Archive (aktuell: Landesarchiv NRW)
  mit dem korrekten Namen, für alle anderen (z. B. Arcinsys Hessen) über
  eine einfache Ableitung aus dem Domainnamen (`arcinsys.hessen.de` →
  „Arcinsys Hessen“). Betrifft die Anzeige im Panel und die Dateinamen
  beim Download.
- **Wichtig, rechtlich:** Für unbekannte Institutionen (alles außer
  Landesarchiv NRW) wird **nicht** automatisch „CC BY-SA 4.0“ oder eine
  andere Lizenz behauptet - das wäre reine Vermutung und könnte rechtlich
  falsch sein. Stattdessen enthält die generierte Quellenangabe für
  unbekannte Archive den Hinweis, die Nutzungsbedingungen selbst direkt
  bei der jeweiligen Institution zu prüfen. Nur für Institutionen mit
  tatsächlich verifizierten Bedingungen (siehe `KNOWN_INSTITUTIONS` in
  `content.js`) wird eine konkrete Lizenz genannt.
- Für Arcinsys Hessen ist `arcinsys.hessen.de` neu in `host_permissions`
  ergänzt, damit die METS-Datei überhaupt abgerufen werden kann. Taucht
  ein weiteres Archiv über den DFG-Viewer auf, dessen Domain noch nicht
  in `host_permissions` steht, schlägt der METS-Abruf fehl (Diagnose im
  Panel) - dann einfach die Domain analog ergänzen (oder mir die Domain
  nennen).

## 0.7.0

- **Folgeseite laden (Landesarchiv NRW/DFG-Viewer):** Bei METS-basierten
  Quellen (DFG-Viewer, direkte Landesarchiv-NRW-Links) gibt es jetzt pro
  Zeile den Button „➕ Folgeseite auch laden“ - praktisch bei
  Heiratsregistern, die manchmal über zwei Seiten gehen. Klick fügt eine
  zusätzliche Quelle mit `tx_dlf[page]` + 1 (gleiche METS-Datei, nächste
  Seite) zur Liste hinzu; sie wird wie jede andere Quelle mitgeprüft,
  zitiert und heruntergeladen. Bei Matricula gibt es diesen Button nicht,
  da dort die Seitenzahl nicht einfach per URL-Parameter weiterzählt
  (siehe Abschnitt zur Matricula-Seitenzahl-Ermittlung oben).

## 0.6.0

- **Matricula: präzise Metadaten statt Seitentitel-Behelf.** Mit der vom
  Nutzer bestätigten Struktur umgesetzt:
  - Pfarre/Ort, Signatur und Buchtyp werden aus der Tabelle
    `<table class="table table-register-data">` gelesen (Zeilen
    `<tr><th>Feldname</th><td>Wert</td></tr>`).
  - Die tatsächliche Kirchenbuch-Seitenzahl kommt **weder** aus dem
    `pg`-URL-Parameter **noch** aus dem `data-pg`-Attribut (beide können
    von der "echten" Seitenzahl abweichen, z. B. durch Titel-/Deckblätter
    im Scan), sondern aus dem Text des aktiven Seiten-Links
    (`<a class="docview-pagelink … active" data-pg="…">T_197</a>` →
    Seite 197; ein Präfix wie "T_" wird abgeschnitten).
  - Ergebnis-Dateiname z. B.: `01-Ibbenbüren, St. Mauritius, Taufen,
    KB012 - Seite 197.jpg`.
  - Funktioniert sowohl bei der schnellen HTML-Methode (Regex) als auch
    beim Fenster-Fallback (dort per echtem DOM ausgelesen, zuverlässiger
    als Regex). Ist die Tabelle bei einer bestimmten Matricula-Variante
    nicht vorhanden, fällt die Extension auf den Seitentitel zurück
    (siehe 0.5.0).

## 0.5.0

- **Sprechende Dateinamen statt generischem Domain-Label:**
  - **Landesarchiv NRW / DFG-Viewer:** Liest zusätzlich zur METS-Datei die
    sichtbare Metadaten-Anzeige der DFG-Viewer-Seite aus (bestätigtes
    Element: `<dd class="tx-dlf-title">…</dd>`), z. B. „Abteilung
    Ostwestfalen-Lippe, P 9 / 15 (Standesämter Kreis Tecklenburg), Nr.
    1146“, plus die Seitenzahl aus dem Link. Dafür ist `dfg-viewer.de`
    neu in `host_permissions` nötig.
  - **Matricula:** Da mir die genaue HTML-Struktur (Pfarre/Ort, Buchtyp,
    Signatur) nicht vorliegt und ich sie nicht raten wollte, wird
    ersatzweise der Seitentitel (`<title>`) sowie die Seitenzahl aus dem
    `pg`-URL-Parameter verwendet - das ist ein Best-Effort-Ersatz, kein
    Garant für exakt die gewünschten Felder. Falls der Titel nicht
    aussagekräftig genug ist: Bitte die relevante HTML-Stelle (Klasse/
    Struktur, die Pfarre/Ort, Buchtyp, Signatur und Seite enthält)
    schicken, dann lässt sich das genauso präzise umsetzen wie beim
    Landesarchiv.
  - Betrifft sowohl den einzelnen „⬇ Bild herunterladen“-Link als auch
    die Dateien im gemeinsamen Download-Ordner.

## 0.4.0

- **Gemeinsamer Download aller Bilder:** Neuer Button „⬇ Ausgewählte Bilder
  gemeinsam herunterladen“. Liest den Personennamen von der Seite
  (`[data-cy="person-name"]`) und die WikiTree-ID aus der URL, und legt
  einen Unterordner im Standard-Download-Verzeichnis an, benannt nach dem
  Muster `WikiTree-ID - Personenname` (z. B. `Feldkämper-2 - Johann
  Joseph Feldkämper`). Dort landen alle gefundenen Bilder der
  ausgewählten Quellen, durchnummeriert mit Quellenname
  (`01-Matricula.png`, `02-Landesarchiv NRW (DFG-Viewer).jpg`, …), sowie
  eine `Quellenangaben.txt` mit den zugehörigen Zitaten/Lizenztexten.
  Sonderzeichen, die in Datei-/Ordnernamen unter Windows/macOS/Linux
  nicht erlaubt sind (`< > : " / \ | ? *`), werden automatisch ersetzt;
  Umlaute und andere Unicode-Zeichen bleiben erhalten. Dafür ist die
  neue Berechtigung `downloads` nötig.
- Chrome legt den Unterordner relativ zum Standard-Download-Verzeichnis
  an (aus API-Sicherheitsgründen nicht frei wählbar) - der genaue
  Ordnername lässt sich aber vorgeben, siehe oben.

## Bisherige Änderungen (0.2.0–0.3.0)

- **Bugfix:** Erneutes Klicken auf „Bildvorschau prüfen“ hat das Bild pro
  Quelle dupliziert (mehrfach untereinander eingefügt). Ergebnisse werden
  jetzt pro Quelle zwischengespeichert; ein erneuter Klick zeigt den
  Cache erneut an, statt neu zu laden und zusätzlich anzuhängen.
- **Matricula, Versuch 2:** Ein einfacher HTML-Abruf funktioniert bei
  Matricula nachweislich nicht (siehe Abschnitt unten) – neu wird die
  Matricula-Seite kurz in einem unsichtbaren Hintergrund-Tab geöffnet,
  damit der Browser deren JavaScript wirklich ausführt, und danach das
  fertig gerenderte Bild ausgelesen. Dafür sind die Berechtigungen
  `tabs` und `scripting` neu in `manifest.json` nötig.
- **Zielfeld-Auswahl per Klick:** Statt nur auf geratene Selektoren zu
  vertrauen, gibt es jetzt oben im Panel den Button „🎯 Zielfeld wählen“.
  Damit klickst du einmal auf das echte Bio-Feld im WikiTree-Editor
  (egal ob `<textarea>` oder ein contenteditable-Editor) – die Extension
  merkt sich genau dieses Element für den Rest der Sitzung und nutzt es
  beim Einfügen. Das sollte das bisherige Problem lösen, dass der Text
  nicht eingefügt werden konnte.

