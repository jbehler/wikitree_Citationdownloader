"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadContentScript, readContentScript } = require("./helpers.js");

const T = loadContentScript(readContentScript());
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "citation-cases.json"), "utf8"));
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "citation-golden.json"), "utf8"));
// Objekte aus dem vm-Kontext haben ein anderes Object-Prototype -> per JSON normalisieren.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("content.js lässt sich mit Fake-DOM laden und stellt den Test-Hook bereit", () => {
  assert.equal(typeof T.buildCitationText, "function");
  assert.equal(typeof T.classifyDomain, "function");
});

// Die Erwartungswerte in citation-golden.json wurden VOR dem Refactoring
// (Quelltyp-Registry) mit dem damaligen content.js (HEAD) erzeugt - die
// Zitattexte müssen zeichengenau gleich geblieben sein.
test("Zitattexte, Labels und Institutionen entsprechen zeichengenau dem Stand vor der Registry", () => {
  assert.equal(golden.length, cases.length);
  cases.forEach((c, i) => {
    const g = golden[i];
    assert.equal(g.name, c.name);
    assert.equal(T.buildCitationText(c.source, c.imageInfo).citation, g.citation, `Zitat: ${c.name}`);
    assert.equal(T.domainLabel(c.source), g.label, `Label: ${c.name}`);
    assert.deepEqual(plain(T.institutionInfoForSource(c.source)), g.institution, `Institution: ${c.name}`);
  });
});

test("Matricula-Zitat mit Seitenzahl (Klartext)", () => {
  const { citation } = T.buildCitationText(
    { url: "https://data.matricula-online.eu/x/?pg=1", domain: "matricula", citedPageHint: "197" },
    { ok: true, pageNumber: 197 }
  );
  assert.equal(
    citation,
    "* Digitalisat: [https://data.matricula-online.eu/x/?pg=1 Matricula Online (Seite 197)] – Kirchenbuch-Digitalisat. " +
      "Lizenz: [https://creativecommons.org/licenses/by-nc-nd/2.0/deed.de CC BY-NC-ND 2.0] (nicht-kommerziell, unverändert, " +
      "mit Namensnennung). Laut Matricula-Nutzungsbedingungen bitte das zuständige Diözesan-/Landesarchiv über die " +
      "Online-Veröffentlichung informieren; ein Link genügt dafür."
  );
});

test("Landesarchiv-BW-Zitat: Hinweis und Dokumentenseite weichen ab, Rechtekategorie UND", () => {
  const { citation } = T.buildCitationText(
    { url: "https://www.landesarchiv-bw.de/plink/?f=1-456", domain: "landesarchiv-bw-plink", citedPageHint: "12" },
    { ok: true, via: "bw-bild-php", pageNumber: 74, pageLabel: "Bild 74", rightsCategory: "UND" }
  );
  assert.equal(
    citation,
    "* Digitalisat: [https://www.landesarchiv-bw.de/plink/?f=1-456 Landesarchiv Baden-Württemberg (Seite 12, im Dokument Bild 74)] – " +
      "Bild automatisch aus der Digitalisat-Seite ermittelt und heruntergeladen (JPEG in voller Scan-Auflösung, wie auf der Seite angezeigt)." +
      " Auf der Digitalisat-Seite ist die Rechtekategorie UND gemäß rightsstatements.org ausgewählt (bei UND: Rechte unbestimmt) - " +
      "bitte vor einer Veröffentlichung trotzdem die Nutzungsbedingungen bei Landesarchiv Baden-Württemberg prüfen."
  );
});

test("classifyDomain klassifiziert nach Hostname, nicht nach URL-Inhalt", () => {
  const c = T.classifyDomain;
  assert.equal(c("https://data.matricula-online.eu/de/x/"), "matricula");
  assert.equal(c("https://matricula-online.eu/"), "matricula");
  assert.equal(c("https://example.com/?ref=matricula-online.eu"), "sonstige-quelle");
  assert.equal(c("https://evilmatricula-online.eu/"), "sonstige-quelle");
  assert.equal(c("https://dfg-viewer.de/show"), "dfg-viewer");
  assert.equal(c("https://www.landesarchiv-nrw.de/x"), "landesarchiv-nrw-direkt");
  assert.equal(c("https://arcinsys.hessen.de/x"), "arcinsys-direkt");
  assert.equal(c("https://www.arcinsys.niedersachsen.de/x"), "arcinsys-direkt");
  assert.equal(c("https://www.landesarchiv-bw.de/plink/?f=1"), "landesarchiv-bw-plink");
  assert.equal(c("https://www.wbc.poznan.pl/dlibra/publication/1/edition/2/content"), "wbc-dlibra");
  assert.equal(c("https://www.wbc.poznan.pl/Content/2/x.djvu"), "wbc-dlibra");
  assert.equal(c("https://www.wbc.poznan.pl/"), "sonstige-quelle");
  assert.equal(c("kein url"), "sonstige-quelle");
});

test("Registry deckt genau die Domains von classifyDomain ab", () => {
  assert.deepEqual(Object.keys(T.SOURCE_TYPES).sort(), [
    "arcinsys-direkt",
    "dfg-viewer",
    "landesarchiv-bw-plink",
    "landesarchiv-nrw-direkt",
    "matricula",
    "sonstige-quelle",
    "wbc-dlibra"
  ]);
  for (const t of Object.values(T.SOURCE_TYPES)) {
    assert.equal(typeof t.label, "function");
    assert.equal(typeof t.requestImageInfo, "function");
    assert.equal(typeof t.buildCitation, "function");
  }
});

test("Fallback für unbekannte domain", async () => {
  const src = { url: "https://example.org/x", domain: "gibt-es-nicht", citedPageHint: null };
  assert.equal(T.domainLabel(src), "Quelle");
  assert.equal(T.institutionInfoForSource(src), null);
  assert.match(T.buildCitationText(src, null).citation, /unbekanntes Archiv\]/);
  assert.deepEqual(plain(await T.requestImageInfo(src)), { ok: false, reason: "Keine passende Abruf-Methode für diese Quelle bekannt." });
  // kein Prototype-Lookup
  assert.equal(T.domainLabel({ url: "x", domain: "constructor" }), "Quelle");
});

test("requestImageInfo: sonstige-quelle ohne Netzabruf; dfg-viewer sendet Nachricht", async () => {
  const sent = [];
  const T2 = loadContentScript(readContentScript(), {
    sendMessage: async (m) => {
      sent.push(m);
      return { ok: true };
    }
  });
  const r = await T2.requestImageInfo({ url: "https://example.org/", domain: "sonstige-quelle", citedPageHint: "4" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /noch nicht unterstützt.*vermutlich Seite 4/);
  assert.equal(sent.length, 0);
  await T2.requestImageInfo({ url: "https://dfg-viewer.de/x", domain: "dfg-viewer" });
  assert.deepEqual(plain(sent), [{ type: "FIND_IMAGE_FOR_DFG_VIEWER", url: "https://dfg-viewer.de/x" }]);
});

test("citationDocPage", () => {
  const f = T.citationDocPage;
  assert.equal(f(null), null);
  assert.equal(f({ ok: false, pageNumber: 3 }), null);
  assert.equal(f({ ok: true }), null);
  assert.equal(f({ ok: true, via: "form-download-pending", pageNumber: 5 }), null);
  assert.deepEqual(plain(f({ ok: true, via: "bw-bild-php", pageNumber: 74 })), {
    number: 74,
    docLabel: "Bild 74",
    docOnlyLabel: "im Dokument Bild 74"
  });
  assert.deepEqual(plain(f({ ok: true, via: "bw-bild-php", pageNumber: 74, pageLabel: "Bild 074" })).docLabel, "Bild 074");
  assert.deepEqual(plain(f({ ok: true, pageNumber: 9 })), { number: 9, docLabel: "Seite 9", docOnlyLabel: "Seite 9" });
});

test("buildCitationPageSuffix", () => {
  const f = T.buildCitationPageSuffix;
  const bw = { number: 74, docLabel: "Bild 74", docOnlyLabel: "im Dokument Bild 74" };
  const pg = { number: 9, docLabel: "Seite 9", docOnlyLabel: "Seite 9" };
  assert.equal(f(bw, "12"), " (Seite 12, im Dokument Bild 74)");
  assert.equal(f(bw, "74"), " (Seite 74)");
  assert.equal(f(bw, null), " (im Dokument Bild 74)");
  assert.equal(f(pg, null), " (Seite 9)");
  assert.equal(f({ number: null, docLabel: "X", docOnlyLabel: "X" }, "3"), " (Seite 3, im Dokument X)");
  assert.equal(f(null, "12"), " (vermutlich Seite 12)");
  assert.equal(f(null, null), "");
});

test("isSafeUrl: Rastertypen ja, svg+xml und Skript-Schemata nein", () => {
  const f = T.isSafeUrl;
  assert.equal(f("https://a.de/x"), true);
  assert.equal(f("javascript:1"), false);
  assert.equal(f("data:image/png;base64,AA", true), true);
  assert.equal(f("data:image/webp;base64,AA", true), true);
  assert.equal(f("data:image/svg+xml;base64,AA", true), false);
  assert.equal(f("data:image/png;base64,AA", false), false);
  assert.equal(f("data:text/html,x", true), false);
});

test("SOURCE_TYPES: needsNetwork ist boolean, nur sonstige-quelle braucht keinen Netzabruf", () => {
  for (const [name, type] of Object.entries(T.SOURCE_TYPES)) {
    assert.equal(typeof type.needsNetwork, "boolean", name);
    assert.equal(type.needsNetwork, name !== "sonstige-quelle", name);
  }
});

test("buildCitationText kommt ohne imageInfo (Einfügen vor Prüfung) bei jedem Quelltyp klar", () => {
  for (const name of Object.keys(T.SOURCE_TYPES)) {
    const url = "https://example.org/x";
    for (const info of [undefined, null]) {
      const { citation } = T.buildCitationText({ url, domain: name, linkText: "x" }, info);
      assert.match(citation, /^\* /, name);
    }
  }
});

// ---- Block E2: Bearbeitungsseite ----

test("getEditPersonId erkennt nur Special:EditPerson mit numerischem u", () => {
  assert.equal(T.getEditPersonId("/index.php", "?title=Special:EditPerson&u=27173607"), "27173607");
  assert.equal(T.getEditPersonId("/index.php", "?u=5&title=Special:EditPerson"), "5");
  assert.equal(T.getEditPersonId("/index.php", "?title=Special:EditPerson&u=abc"), null);
  assert.equal(T.getEditPersonId("/index.php", "?title=Special:EditPerson"), null);
  assert.equal(T.getEditPersonId("/index.php", "?title=Special:UploadPhoto&u=1"), null);
  assert.equal(T.getEditPersonId("/wiki/Test-1", "?title=Special:EditPerson&u=1"), null);
  assert.equal(T.getEditPersonId("/index.php", ""), null);
});

test("findEditPersonIdInAnchors findet den ersten gültigen Bearbeiten-Link", () => {
  const base = "https://www.wikitree.com/index.php";
  assert.equal(T.findEditPersonIdInAnchors([base + "?title=Special:EditPerson&u=123"]), "123");
  assert.equal(T.findEditPersonIdInAnchors([base + "?title=Special:UploadPhoto&u=123"]), null);
  assert.equal(T.findEditPersonIdInAnchors([base + "?title=Special:EditPerson&u=abc"]), null);
  assert.equal(T.findEditPersonIdInAnchors(["https://www.wikitree.com/wiki/Test-1?title=Special:EditPerson&u=5"]), null);
  assert.equal(
    T.findEditPersonIdInAnchors([
      "nicht-absolut",
      base + "?title=Special:EditPerson&u=x",
      base + "?title=Special:EditPerson&u=7",
      base + "?title=Special:EditPerson&u=8"
    ]),
    "7"
  );
  assert.equal(T.findEditPersonIdInAnchors([]), null);
});

test("buildUploadPhotoUrl baut die Upload-URL nur für numerische IDs", () => {
  assert.equal(
    T.buildUploadPhotoUrl("27173607"),
    "https://www.wikitree.com/index.php?title=Special%3AUploadPhoto&person_id=27173607"
  );
  assert.equal(T.buildUploadPhotoUrl("12x"), null);
  assert.equal(T.buildUploadPhotoUrl(null), null);
});

test("extractPageHintFromText findet Seitenangaben, keine Certificate-Nummern", () => {
  assert.equal(T.extractPageHintFromText("Taufbuch, S. 123"), "123");
  assert.equal(T.extractPageHintFromText("Blatt 5"), "5");
  assert.equal(T.extractPageHintFromText("kein Hinweis"), null);
  assert.equal(T.extractPageHintFromText(""), null);
});

test("extractSourceLinksFromWikitext: Wiki-Links, nackte URLs, Satzzeichen, Entities, Filter", () => {
  const wt = [
    "== Sources ==",
    "<references />",
    "Er wurde geboren.<ref>Taufbuch, S. 42, [https://data.matricula-online.eu/de/x/?pg=42 Matricula Taufbuch]</ref>",
    "Siehe (https://example.org/a?x=1&amp;y=2).",
    "* [https://www.wikitree.com/wiki/Test-1 Profil]",
    "* https://www.wikitree.com/wiki/Test-2",
    "* https://example.org/a?x=1&y=2,",
    "* [https://example.org/b]"
  ].join("\n");
  const r = JSON.parse(JSON.stringify(T.extractSourceLinksFromWikitext(wt)));
  assert.deepEqual(r.map((x) => x.url), [
    "https://data.matricula-online.eu/de/x/?pg=42",
    "https://example.org/a?x=1&y=2",
    "https://example.org/b"
  ]);
  assert.equal(r[0].linkText, "Matricula Taufbuch");
  assert.equal(r[0].domain, "matricula");
  assert.equal(r[0].citedPageHint, "42");
  assert.equal(r[1].linkText, "");
  assert.equal(r[1].citedPageHint, null);
  assert.deepEqual(plain(T.extractSourceLinksFromWikitext("")), []);
});
