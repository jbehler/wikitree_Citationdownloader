# WikiTree Quellenbilder-Assistent

Chrome/Edge-Extension (Manifest V3). Sucht auf einer geöffneten WikiTree-
Profilseite nach bereits im Text vorhandenen Links zu `matricula-online.eu`
und zu `dfg-viewer.de` (Landesarchiv NRW), prüft auf eine einbettbare
Bildvorschau und fügt eine korrekt formatierte Quellenangabe (inkl.
Lizenztext) in den Bio-Editor ein.

**Hinweis zu Landesarchiv NRW:** Die Digitalisate werden nicht direkt über
eine `archive.nrw.de`-Adresse angezeigt, sondern über den DFG-Viewer
(`dfg-viewer.de/show?...`). Der eigentliche Link zeigt per Parameter
`tx_dlf[id]` auf eine METS-XML-Datei bei `landesarchiv-nrw.de`, und per
`tx_dlf[page]` auf die Seitenzahl. Die Extension liest diese METS-Datei
direkt aus (offener Standard), um daraus die Bild-URL der jeweiligen Seite
zu bestimmen.

## Neu in Version 0.13.1

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

## Neu in Version 0.13.0

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

## Neu in Version 0.12.0

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

## Neu in Version 0.11.1

- **Bugfix Seitenzahl-Erkennung:** Das Muster für die Seitenzahl aus der
  Quellenbeschreibung (siehe 0.10.0) kannte weder das englische Wort
  „page“ noch „Blatt“/„Bl.“ - nur „S.“, „Seite“, „p.“, „pag.“, „fol.“.
  Beispiele wie „page 60, Certificate 60“ oder „Blatt 5, Zertifikat 5“
  wurden dadurch übersehen (und, wichtig, auch nicht mit der daneben-
  stehenden Zertifikatsnummer verwechselt - nur die echte Seiten-/
  Blattangabe wird erfasst).

## Neu in Version 0.11.0

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

## Neu in Version 0.10.0

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

## Neu in Version 0.9.1

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

## Neu in Version 0.9.0

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

## Neu in Version 0.8.0

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

## Neu in Version 0.7.0

- **Folgeseite laden (Landesarchiv NRW/DFG-Viewer):** Bei METS-basierten
  Quellen (DFG-Viewer, direkte Landesarchiv-NRW-Links) gibt es jetzt pro
  Zeile den Button „➕ Folgeseite auch laden“ - praktisch bei
  Heiratsregistern, die manchmal über zwei Seiten gehen. Klick fügt eine
  zusätzliche Quelle mit `tx_dlf[page]` + 1 (gleiche METS-Datei, nächste
  Seite) zur Liste hinzu; sie wird wie jede andere Quelle mitgeprüft,
  zitiert und heruntergeladen. Bei Matricula gibt es diesen Button nicht,
  da dort die Seitenzahl nicht einfach per URL-Parameter weiterzählt
  (siehe Abschnitt zur Matricula-Seitenzahl-Ermittlung oben).

## Neu in Version 0.6.0

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

## Neu in Version 0.5.0

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

## Neu in Version 0.4.0

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

## Installation (Chrome/Edge)

1. Ordner `wikitree-quellenbilder-assistent` irgendwo entpacken/speichern.
2. `chrome://extensions` (bzw. `edge://extensions`) öffnen.
3. „Entwicklermodus“ oben rechts aktivieren.
4. „Entpackte Erweiterung laden“ → diesen Ordner auswählen (bei einem
   Update: Reload-Icon auf der Extension-Karte klicken).
5. Ein WikiTree-Profil im **Edit**-Modus öffnen, das Matricula-/
   Landesarchiv-NRW-Links enthält.

## Benutzung

1. Unten rechts erscheint ein Button „📜 X Quelle(n) gefunden“.
2. Klick öffnet das Panel.
3. Oben im Panel „🎯 Zielfeld wählen“ klicken, dann im Editor einmal auf
   das Bio-Textfeld klicken (empfohlen, siehe oben).
4. „Bildvorschau prüfen“ – bei Matricula kann sich dabei kurz sichtbar
   ein großes, eigenes Fenster öffnen (für eine bessere Auflösung des
   Schnappschusses, siehe unten) und danach automatisch wieder
   schließen; dein vorheriges Fenster wird danach automatisch wieder
   fokussiert. Das kann bis zu ~12 Sekunden dauern.
5. Checkboxen abwählen, falls einzelne Quellen nicht übernommen werden
   sollen.
6. „Ausgewählte in Editor einfügen“.
7. **Wichtig:** Es wird nichts automatisch gespeichert. Im Editor die
   Vorschau prüfen und danach selbst bei WikiTree auf „Save“ klicken.
8. Klappt das automatische Einfügen trotz Zielfeld-Auswahl nicht,
   erscheint automatisch ein Textfeld mit Copy-Button – nichts geht
   verloren.

## Bilder bei WikiTree: Direkt-Einbettung vs. Upload

WikiTree erlaubt kein direktes Einbinden fremder, extern gehosteter
Bild-URLs in der Bio (kein "Hotlinking") – Bilder müssen dort zunächst
hochgeladen und danach über WikiTrees eigene Upload-/Referenzsyntax
eingebunden werden (bestätigt). Deshalb fügt die Extension **kein**
`<img src="…">` mehr in den Wikitext ein. Stattdessen:

- Der Editor-Text enthält nur die saubere **Quellenangabe mit Link und
  Lizenzhinweis** – das ist laut den jeweiligen Nutzungsbedingungen für
  eine Online-Veröffentlichung ohnehin ausreichend.
- Wurde eine Bild-URL gefunden, zeigt das Panel eine Vorschau **und einen
  Download-Button** ("⬇ Bild herunterladen"). Damit kannst du das Bild
  lokal speichern und anschließend selbst über WikiTrees Upload-Dialog
  hochladen und in der Bio referenzieren. Das automatische Hochladen zu
  WikiTree ist nicht Teil dieser Extension (unverifizierter Zugriff auf
  das Upload-Formular in dieser Session).

## Was verifiziert ist – und was nicht

Diese Extension wurde **nicht gegen die echten Live-Seiten getestet**
(wikitree.com blockiert automatisierten Zugriff über robots.txt, der
Editor ist nur eingeloggt sichtbar, und matricula-online.eu /
landesarchiv-nrw.de waren aus der Entwicklungsumgebung heraus nicht
direkt abrufbar). Konkret unsicher/experimentell:

- **Bio-Feld-Einfügung:** Durch die Zielfeld-Auswahl per Klick (siehe
  oben) deutlich zuverlässiger als reine Selektor-Rateversuche. Die
  automatische Erkennung (mehrere plausible Selektoren + größtes
  `<textarea>` als Fallback) bleibt als Komfortfunktion bestehen, falls
  kein Zielfeld manuell gewählt wurde.
- **Bild-URL-Erkennung (Matricula):** Neue Erkenntnis: Matricula läuft
  laut öffentlichen Quellen auf **Kitodo.Presentation** – demselben
  METS-Ökosystem wie der DFG-Viewer. Ein aktiv gepflegtes, rein
  HTTP-basiertes Scraper-Projekt (`matricula-online-scraper` von lsg551,
  auf PyPI) kommt inzwischen ganz ohne JavaScript-Ausführung aus, im
  Gegensatz zu einem älteren Projekt, das dafür `js2py` brauchte. Das legt
  nahe, dass zumindest eine Standardauflösung serverseitig als normales
  `<img>`-Tag ausgeliefert wird, vermutlich über eine URL ohne erkennbare
  Dateiendung (Kitodo-typisch, z. B. `/Rendering/...`). Deshalb versucht
  die Extension bei Matricula jetzt **zuerst** die günstige HTML-Methode
  (mit gelockertem Filter: `<img>`-Tags mit Kitodo/dlf-typischen
  id/class-Hinweisen zählen jetzt auch ohne `.jpg`-Endung in der URL) und
  **nur wenn das nichts findet**, den aufwändigeren Hidden-Tab-Versuch mit
  Canvas-Snapshot als Fallback (siehe unten). Nicht verifiziert: Ich
  konnte die tatsächliche HTML-Struktur einer Matricula-Seite in dieser
  Session nicht direkt einsehen (robots.txt blockiert meinen Fetch-Zugriff
  auch auf einzelne Seiten) - die id/class-Muster sind daher plausible,
  aber ungetestete Annahmen.

  Falls auch das nichts findet, greift weiterhin ein Fallback-Versuch:
  Die Seite wird bewusst in einem eigenen, **großen, fokussierten**
  Fenster (1920×1200) geöffnet - das kostet einen kurzen, sichtbaren
  Fenster-Wechsel, ist aber **notwendig**: Ein unfokussiertes Fenster
  wurde getestet und genauso stark gedrosselt wie ein reiner
  Hintergrund-Tab (Canvas blieb leer). Chrome drosselt
  `requestAnimationFrame` & Co. offenbar am tatsächlichen
  OS-Fensterfokus, nicht nur daran, ob eine Seite der aktive Tab
  innerhalb ihres Fensters ist. Zusätzlich füllen Deep-Zoom-Viewer ihr
  Canvas meist proportional zur verfügbaren Fenstergröße - daher das
  große Format für eine bessere Auflösung. Die Extension merkt sich dein
  vorheriges Fenster und fokussiert es danach automatisch wieder. Danach
  wird per Stichproben aktiv gewartet (bis zu 12s auf Bildinhalt, davor
  bis zu 6s auf das Erscheinen des Canvas-Elements selbst), bevor der
  Schnappschuss gemacht wird - bei Fehlschlag liefert das Panel jetzt
  Diagnosedaten (readyState, visibilityState, Seitentitel,
  Elementanzahl im body).

  **Einordnung/Empfehlung:** Falls auch der verbesserte Ansatz nichts
  findet, würde ich bei Matricula empfehlen, es bei der automatisch
  erzeugten Quellenangabe (Link + Lizenz) zu belassen - deren eigene
  Nutzungsbedingungen lassen das für Online-Veröffentlichungen
  ausdrücklich genügen.
- **Bild-URL-Erkennung (Landesarchiv NRW / DFG-Viewer):** Liest die
  METS-XML-Datei direkt aus (`fileSec`/`fileGrp` + `structMap`/`fptr`).
  Eine erste Version hatte einen Regex-Fehler bei verschachtelten
  `<div>`-Elementen, der ausgerechnet Seite 1 systematisch übersehen hat
  – das ist behoben (Div-Grenzen werden jetzt über Tag-Positionen
  bestimmt statt über einen einzelnen verschachtelten Regex-Treffer).
  **Bestätigt funktionierend** (vom Nutzer getestet).
- **Bild-Einbettung in WikiTree:** Siehe eigener Abschnitt oben – WikiTree
  erwartet vermutlich hochgeladene Bilder statt externer `<img src>`.

Wenn etwas nicht passt: Das Panel zeigt jeweils den konkreten Grund an
(z. B. „Es wurden 0 Seiten-Divs gefunden“, „Bild vermutlich über
Canvas-Elemente“) – das sind echte Diagnosedaten aus deiner Sitzung, mit
denen sich gezielt nachbessern lässt, statt weiter zu raten.

## Neue Berechtigungen (seit 0.3.0)

- `tabs` und `scripting`: nötig für den Hintergrund-Tab-Ansatz bei
  Matricula (Seite kurz unsichtbar laden lassen, Ergebnis auslesen,
  Tab wieder schließen).

## Rechtliche Hinweise (Kurzfassung, keine Rechtsberatung)

- **matricula-online.eu:** Digitalisate stehen unter CC BY-NC-ND 2.0
  (nicht-kommerziell, unverändert, Namensnennung). Für
  Online-Veröffentlichungen reicht laut den Nutzungsbedingungen ein Link
  zur Quelle.
- **Landesarchiv NRW:** Digitalisate aus dem Online-Findmittelsystem
  stehen unter CC BY-SA 4.0 (auch kommerziell, mit Namensnennung und
  Weitergabe unter gleicher Lizenz). Separat bestellte Digitalisate
  können abweichenden Bedingungen unterliegen – im Zweifel beim
  Landesarchiv NRW nachfragen.
- Beide automatisch generierten Zitate enthalten die jeweilige
  Lizenzangabe. Bitte vor Veröffentlichung trotzdem selbst gegenprüfen,
  ob die konkrete Quelle wirklich unter der angenommenen Lizenz steht.
