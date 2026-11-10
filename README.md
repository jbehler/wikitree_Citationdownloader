# WikiTree Quellenbilder-Assistent

Chrome/Edge-Extension (Manifest V3). Sie sucht auf WikiTree-Profilseiten und
auf der Bearbeitungsseite (`Special:EditPerson`) nach Quellen-Links, prüft,
ob eine Bildvorschau möglich ist, und fügt eine formatierte Quellenangabe
(inkl. Lizenzhinweis, soweit verifiziert) in den Bio-Editor ein.

**Hinweis zu Landesarchiv NRW:** Die Digitalisate werden nicht direkt über
eine `archive.nrw.de`-Adresse angezeigt, sondern über den DFG-Viewer
(`dfg-viewer.de/show?...`). Der eigentliche Link zeigt per Parameter
`tx_dlf[id]` auf eine METS-XML-Datei bei `landesarchiv-nrw.de`, und per
`tx_dlf[page]` auf die Seitenzahl. Die Extension liest diese METS-Datei
direkt aus (offener Standard), um daraus die Bild-URL der jeweiligen Seite
zu bestimmen.

## Unterstützte Quellen

- **Matricula** (`matricula-online.eu`): Bildvorschau und Download.
- **DFG-Viewer / Landesarchiv NRW** (`dfg-viewer.de`, `landesarchiv-nrw.de`):
  Bildvorschau und Download über die METS-Datei.
- **Arcinsys** (`arcinsys.hessen.de`, `arcinsys.de`): Direktlinks werden
  zitiert. Findet sich auf der Arcinsys-Seite ein Link „In DFG-Viewer öffnen“,
  wird dieser vorgeschlagen.
- **Landesarchiv Baden-Württemberg** (`landesarchiv-bw.de`): Bildvorschau bei
  `bild_zoom`-Links. Ohne direkte Bildquelle bleibt es beim Formular-Download.
- **dLibra / Wielkopolska Digital Library** (`wbc.poznan.pl`): Bildvorschau nur
  bei frei zugänglichen Publikationen. Geschützte Publikationen werden nicht
  umgangen.
- **Weitere Links** aus der Quellenliste werden zitiert, ohne Bildabruf.

## Installation (Chrome/Edge)

1. Den Ordner der Extension entpacken bzw. speichern.
2. `chrome://extensions` (bzw. `edge://extensions`) öffnen.
3. „Entwicklermodus“ oben rechts aktivieren.
4. „Entpackte Erweiterung laden“ wählen und diesen Ordner auswählen. Bei einem
   Update auf dieser Karte das Reload-Symbol klicken.

Berechtigungen: `scripting`, `downloads` und `storage` (nur `storage.session`,
um vorbereitete Uploads kurz im Arbeitsspeicher zwischen Profil- und
Upload-Seite zu halten). Die Host-Rechte für WikiTree (inkl.
`api.wikitree.com` zum Ermitteln der Personen-Id), die unterstützten Archive
und die dafür nötigen Hosts stehen in `manifest.json` (`host_permissions`).

## Bedienung

### Profilseite

1. Unten rechts erscheint „📜 X Quelle(n) gefunden“. Ein Klick öffnet das Panel.
2. Optional „🎯 Zielfeld wählen“ klicken und danach das Bio-Textfeld im Editor
   anklicken. Ohne Auswahl versucht die Extension, das Feld selbst zu finden.
3. „Bildvorschau prüfen“: Die Prüfung läuft im Hintergrund per HTTP. Nur als
   letzter Fallback kann kurz ein Fenster erscheinen (Canvas-Schnappschuss).
4. Nicht gewünschte Quellen abwählen, dann „Ausgewählte in Editor einfügen“
   oder „📋 Ausgewählte Zitate kopieren“.
5. Bilder gesammelt herunterladen: „⬇ Ausgewählte Bilder gemeinsam
   herunterladen“. Die Dateien landen in einem Unterordner des
   Download-Verzeichnisses, zusammen mit einer `Quellenangaben.txt`.
6. Bei Bedarf „➕ Folgeseite auch laden“ (DFG-Viewer-Quellen).

Meldungen erscheinen als Zeile im Panel. Es wird nichts automatisch
gespeichert: Vorschau im Editor prüfen und selbst bei WikiTree auf „Save“
klicken. Gelingt das automatische Einfügen nicht, erscheint ein Textfeld mit
Kopieren-Button.

### Bearbeitungsseite

- Das Panel liest die Quellen aus dem Bio-Wikitext. Wortgleiche Zitate, die
  schon im Text stehen, werden nicht doppelt eingefügt.
- „⬆ Bei WikiTree hochladen“ öffnet die Upload-Seite (`Special:UploadPhoto`)
  für diese Person.

### Upload-Seite (Vorbelegung)

- Auf der Profilseite wird die Personen-Id bei Bedarf per WikiTree-API geholt;
  danach erscheint bei jedem gefundenen Bild „⬆ Bei WikiTree hochladen“.
- Der Klick merkt sich Bild, Dateinamen und Quellenangabe (1 h, nur im
  Arbeitsspeicher) und öffnet die Upload-Seite in einem neuen Tab. Dort zeigt
  ein Panel die vorbereiteten Bilder: „Bild ins Dateifeld legen“,
  „Bild + Angaben ins Formular übernehmen“ (Datei, Quelle als Kurzfassung bis
  800 Zeichen, Titel falls leer, Bildtyp „Source“) sowie Einzel-Buttons und
  „Quellenangabe kopieren“. Vorhandener Text wird nie überschrieben. Ist ein
  Feld nicht erkennbar, das Feld einfach anklicken.
- Die Extension sendet das Formular **nie** ab: Felder prüfen und selbst auf
  „Upload Image“ klicken. „Erledigt – aus Liste entfernen“ räumt den Eintrag auf.
- DjVu-Bilder (dLibra) werden nicht vorbelegt: erst in JPEG/PNG umwandeln.
  Erlaubt sind JPEG, PNG, GIF und WebP (wird nach JPEG umgewandelt), höchstens 10 MB.

### Bilder bei WikiTree

WikiTree erlaubt kein Einbinden externer Bild-URLs. Die Extension fügt deshalb
kein `<img>` in den Wikitext ein. Bilder herunterladen und über den
WikiTree-Upload hochladen, danach in der Bio referenzieren.

## Entwicklung

```
npm ci          # Abhängigkeiten installieren
npm test        # Tests (node:test, Fixtures in test/fixtures)
npm run lint    # ESLint
```

GitHub Actions (`.github/workflows/ci.yml`) führt Lint, Tests und eine
Syntaxprüfung der Skripte aus.

Projektstruktur:

- `manifest.json`: Manifest V3, Berechtigungen, Host-Rechte, Content-Script
- `background.js`: Service Worker mit Abrufen, Bildsuche und Downloads
- `lib/parsers.js`: reine Parser (METS, Matricula, Landesarchiv BW, dLibra) und
  URL-Allowlist. Wird vom Service Worker per `importScripts` und in Node geladen
- `content.js`: Panel auf WikiTree, Quelltyp-Registry `SOURCE_TYPES`, Erzeugung
  der Zitate
- `styles.css`: Styles des Panels
- `test/`: Tests, Hilfsfunktionen und Fixtures

Die Versionshistorie steht in [CHANGELOG.md](CHANGELOG.md).

## Einschränkungen

- Auf WikiTree selbst wurde nicht automatisiert getestet: wikitree.com
  verbietet automatisierten Zugriff über `robots.txt`, und der Editor ist nur
  eingeloggt sichtbar.
- Die Quellenseiten der Archive ändern ihren Aufbau gelegentlich. Das Panel
  zeigt dann den konkreten Grund an.
- Einzelne Matricula-Scans sind „aus gesetzlichen Gründen gesperrt“. Die
  Vorschau lädt dann nicht, die Quellenangabe bleibt korrekt.
- dLibra-Dateien im DjVu-Format lassen sich nicht als Bild anzeigen. Die
  Extension bietet dann den Download der Datei an.

## Rechtliche Hinweise (Kurzfassung, keine Rechtsberatung)

- **matricula-online.eu:** Digitalisate stehen unter CC BY-NC-ND 2.0
  (nicht-kommerziell, unverändert, Namensnennung). Für
  Online-Veröffentlichungen reicht laut den Nutzungsbedingungen ein Link
  zur Quelle.
- **Landesarchiv NRW:** Digitalisate aus dem Online-Findmittelsystem stehen
  unter CC BY-SA 4.0 (auch kommerziell, mit Namensnennung und Weitergabe unter
  gleicher Lizenz). Separat bestellte Digitalisate können abweichenden
  Bedingungen unterliegen.
- **Landesarchiv Baden-Württemberg:** Die verlinkte Rechtekategorie wird ins
  Zitat übernommen, ersetzt aber keine eigene Prüfung der
  Nutzungsbedingungen.
- **Andere Institutionen:** Es wird keine Lizenz behauptet. Die Bedingungen
  bitte direkt bei der Institution prüfen.
- Vor einer Veröffentlichung bitte selbst prüfen, ob die konkrete Quelle
  unter der angenommenen Lizenz steht.
