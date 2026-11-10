"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const P = require("../lib/parsers.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

// ---------------------------------------------------------------------
// DFG-Viewer / METS
// ---------------------------------------------------------------------
test("parseDfgViewerUrl liest METS-URL und Seite", () => {
  const r = P.parseDfgViewerUrl("https://dfg-viewer.de/show?tx_dlf[id]=https%3A%2F%2Fa.de%2Fm.xml&tx_dlf[page]=7");
  assert.deepEqual(r, { metsUrl: "https://a.de/m.xml", page: 7 });
});

test("parseDfgViewerUrl: ohne Seite -> 1, ohne id -> null", () => {
  assert.equal(P.parseDfgViewerUrl("https://dfg-viewer.de/show?tx_dlf[id]=https%3A%2F%2Fa.de%2Fm.xml").page, 1);
  assert.equal(P.parseDfgViewerUrl("https://dfg-viewer.de/show"), null);
  assert.equal(P.parseDfgViewerUrl("kein url"), null);
});

test("extractFileIdsForPage findet Seite 1 trotz verschachteltem physSequence-Div (historischer Bug)", () => {
  const xml = fixture("mets-dfg.xml");
  assert.deepEqual(P.extractFileIdsForPage(xml, 1), { ids: ["DEF1", "MAX1"], diag: null });
  assert.deepEqual(P.extractFileIdsForPage(xml, 2).ids, ["DEF2", "MAX2"]);
  assert.deepEqual(P.extractFileIdsForPage(xml, 3).ids, ["DEF3", "MAX3"]);
});

test("extractFileIdsForPage: unbekannte Seite liefert Diagnose", () => {
  const r = P.extractFileIdsForPage(fixture("mets-dfg.xml"), 99);
  assert.deepEqual(r.ids, []);
  assert.match(r.diag, /3 Seiten-Divs/);
  assert.match(r.diag, /ORDER-Werten: 1, 2, 3/);
});

test("extractFileGroups: FLocat-Kinder UND selbstschließende file-Elemente", () => {
  const map = P.extractFileGroups(fixture("mets-dfg.xml"), "https://archiv.example/mets/m.xml");
  // FLocat-Variante, relativer href wird gegen die METS-URL aufgelöst
  assert.equal(map.DEF1.DEFAULT, "https://archiv.example/images/default/0001.jpg");
  // selbstschließende Variante (früher stillschweigend übergangen)
  assert.equal(map.MAX2.MAX, "https://img.example-archiv.de/max/0002.jpg");
  assert.equal(Object.keys(map).length, 6);
});

test("pickBestUrl bevorzugt MAX vor DEFAULT", () => {
  const xml = fixture("mets-dfg.xml");
  const map = P.extractFileGroups(xml, "https://archiv.example/mets/m.xml");
  const { ids } = P.extractFileIdsForPage(xml, 1);
  assert.equal(P.pickBestUrl(map, ids), "https://img.example-archiv.de/max/0001.jpg");
  // Nur DEFAULT vorhanden -> DEFAULT
  assert.equal(P.pickBestUrl(map, ["DEF1"]), "https://archiv.example/images/default/0001.jpg");
  assert.equal(P.pickBestUrl(map, ["gibtsnicht"]), null);
  // Unbekannte USE-Werte: erstbeste Variante
  assert.equal(P.pickBestUrl({ X: { FOO: "u" } }, ["X"]), "u");
});

test("getAttr / findAllTagOpenings / findAllClosingTagPositions", () => {
  assert.equal(P.getAttr('a="1" b=\'2\' c=3', "b"), "2");
  assert.equal(P.getAttr('a="1" b=\'2\' c=3', "c"), "3");
  assert.equal(P.getAttr("", "x"), null);
  const xml = '<m:div A="1"><div B="2"/></m:div>';
  const open = P.findAllTagOpenings(xml, "div");
  assert.equal(open.length, 2);
  assert.equal(open[0].selfClosing, false);
  assert.equal(open[1].selfClosing, true);
  assert.deepEqual(P.findAllClosingTagPositions(xml, "div"), [xml.indexOf("</m:div>")]);
});

test("absoluteUrl", () => {
  assert.equal(P.absoluteUrl("/a/b", "https://x.de/c/"), "https://x.de/a/b");
  assert.equal(P.absoluteUrl("a", "kein-url"), null);
});

// ---------------------------------------------------------------------
// Matricula
// ---------------------------------------------------------------------
test("extractMatriculaImageUrlsFromDv1 dekodiert base64-URLs, Index pg=N -> files[N-1]", () => {
  const html = fixture("matricula.html");
  const base = "https://data.matricula-online.eu/de/deutschland/aachen/aachen-hl-kreuz/KB+001/?pg=2";
  const r = P.extractMatriculaImageUrlsFromDv1(html, base);
  assert.equal(r.imageUrls.length, 3);
  assert.deepEqual(r.labels, ["001_0001", "001_0002", "001_0003"]);
  assert.equal(
    r.imageUrls[0],
    "http://hosted-images.matricula-online.eu/images/matricula/DE-BDAA/images/17%20Matricula/DE_2187_KB_001/DE_2187_KB_001_0001.jpg"
  );
  const pg = P.extractPageNumberParam(base);
  assert.equal(pg, 2);
  assert.match(r.imageUrls[pg - 1], /DE_2187_KB_001_0002\.jpg$/);
});

test("extractMatriculaImageUrlsFromDv1: ohne dv1 -> null; kaputte Einträge -> null an Position", () => {
  assert.equal(P.extractMatriculaImageUrlsFromDv1("<html></html>", "https://x.de/"), null);
  const html = 'dv1 = new arc.imageview.MatriculaDocView("d", {"files": ["/image/%%%/", 5]});</script>';
  assert.equal(P.extractMatriculaImageUrlsFromDv1(html, "https://x.de/"), null);
});

test("upgradeMatriculaImageUrlToHttps", () => {
  assert.equal(
    P.upgradeMatriculaImageUrlToHttps("http://hosted-images.matricula-online.eu/a.jpg"),
    "https://hosted-images.matricula-online.eu/a.jpg"
  );
  assert.equal(P.upgradeMatriculaImageUrlToHttps("http://example.com/a.jpg"), "http://example.com/a.jpg");
  assert.equal(P.upgradeMatriculaImageUrlToHttps("http://evil.de/?x=matricula-online.eu/"), "http://evil.de/?x=matricula-online.eu/");
});

test("extractMatriculaMetaFromHtml: Tabelle und aktiver Seiten-Link T_197", () => {
  const meta = P.extractMatriculaMetaFromHtml(fixture("matricula.html"));
  assert.deepEqual(meta, { parish: "Aachen, Hl. Kreuz", bookType: "Taufen", signature: "KB 001", pageNumber: 197 });
  assert.equal(P.combineMatriculaLabel(meta), "Aachen, Hl. Kreuz, Taufen, KB 001");
  assert.equal(P.combineMatriculaLabel({}), null);
});

test("extractTitleTag dekodiert Entities", () => {
  assert.equal(
    P.extractTitleTag(fixture("matricula.html")),
    "Aachen, Hl. Kreuz | KB 001 & Taufen | Matricula Online"
  );
  assert.equal(P.extractTitleTag("<p>x</p>"), null);
});

test("decodeBase64ToUtf8String: URL-safe, fehlendes Padding, Fehler -> null", () => {
  assert.equal(P.decodeBase64ToUtf8String(Buffer.from("äöü?>>").toString("base64")), "äöü?>>");
  assert.equal(P.decodeBase64ToUtf8String("YWJj"), "abc");
  assert.equal(P.decodeBase64ToUtf8String("YWJjZA"), "abcd");
  assert.equal(P.decodeBase64ToUtf8String("!!!"), null);
});

test("extractCandidateImageUrlsFromHtml: Kitodo-Hinweis und Dateiendung", () => {
  const html = '<img src="/logo.png"><img id="image" src="/scan?id=5"><img src="x.jpg">';
  assert.deepEqual(P.extractCandidateImageUrlsFromHtml(html, "https://a.de/b/"), ["https://a.de/scan?id=5"]);
  assert.deepEqual(P.extractCandidateImageUrlsFromHtml('<img src="x.jpg"><img src="icon.png">', "https://a.de/b/"), ["https://a.de/b/x.jpg"]);
});

// ---------------------------------------------------------------------
// Landesarchiv BW
// ---------------------------------------------------------------------
test("extractLandesarchivBwBildSource: &amp; dekodiert, Qualität 100 im Download, Bild 74, UND", () => {
  const r = P.extractLandesarchivBwBildSource(
    fixture("bw-zoom.html"),
    "https://www.landesarchiv-bw.de/plink/zoom.php?gewaehlteSeite=74"
  );
  assert.ok(r);
  assert.equal(
    r.imageUrl,
    "https://www.landesarchiv-bw.de/plink/bild.php?drehen=&zoom=100&gamma=1&jpegQualitaetZoombild=60&scopeid_besta=7883&originalBilddatei=%2Fdata%2Fbildcms%2F04_74.jpg"
  );
  assert.ok(!r.imageUrl.includes("&amp;"));
  assert.match(r.downloadUrl, /jpegQualitaetZoombild=100/);
  assert.match(r.imageUrl, /jpegQualitaetZoombild=60/);
  assert.equal(r.pageNumber, 74);
  assert.equal(r.pageLabel, "Bild 74");
  assert.equal(r.label, "456 C Nr. 1792, 2 cm");
  assert.equal(r.rightsCategory, "UND");
});

test("extractLandesarchivBwBildSource: ohne imageSource -> null; http wird auf https angehoben", () => {
  assert.equal(P.extractLandesarchivBwBildSource("<html></html>", "https://www.landesarchiv-bw.de/x"), null);
  const r = P.extractLandesarchivBwBildSource("imageSource: 'bild.php?a=1'", "http://www.landesarchiv-bw.de/x/zoom.php");
  assert.equal(r.imageUrl, "https://www.landesarchiv-bw.de/x/bild.php?a=1");
});

test("BW: unquoted option-Attribute (JPG-Optionen, aktuelle Datei, Formularfelder)", () => {
  const html = fixture("bw-zoom.html");
  assert.deepEqual(P.extractLandesarchivBwJpgOptions(html), ["04_73.jpg", "04_74.jpg", "04_75.jpg"]);
  assert.equal(P.extractLandesarchivBwCurrentFile(html, "https://x.de/zoom.php?gewaehlteSeite=3"), "04_75.jpg");
  assert.equal(P.extractLandesarchivBwCurrentFile(html, "https://x.de/zoom.php"), "04_73.jpg");
  const fields = P.extractLandesarchivBwLegacyFormFields(html);
  assert.equal(fields.scopeid_besta, "7883");
  assert.equal(fields.vorigeBilddatei, "04_74.jpg");
  assert.equal(fields.originalBilddatei, "04_74.jpg"); // selected-Option
});

test("BW: decodeUrlAmpersands, isLandesarchivBwUrl, upgrade, plink_screen-Redirect", () => {
  assert.equal(P.decodeUrlAmpersands("a&amp;b&#38;c&#x26;d\\u0026e"), "a&b&c&d&e");
  assert.equal(P.isLandesarchivBwUrl("https://www.landesarchiv-bw.de/x"), true);
  assert.equal(P.isLandesarchivBwUrl("https://evil.de/landesarchiv-bw.de"), false);
  assert.equal(P.upgradeLandesarchivBwImageUrlToHttps("http://www.landesarchiv-bw.de/a"), "https://www.landesarchiv-bw.de/a");
  const stub = '<script>self.location.href = "zoom.php?x=1";</script>';
  assert.equal(
    P.resolveLandesarchivBwPlinkScreenRedirect(stub, "https://www.landesarchiv-bw.de/plink/plink_screen.php?f=1"),
    "https://www.landesarchiv-bw.de/plink/zoom.php?f=1"
  );
  assert.equal(P.resolveLandesarchivBwPlinkScreenRedirect("<html></html>", "https://x.de/plink_screen.php"), null);
  assert.equal(P.resolveLandesarchivBwPlinkScreenRedirect(stub, "https://x.de/zoom.php"), null);
});

// ---------------------------------------------------------------------
// dLibra (wbc.poznan.pl)
// ---------------------------------------------------------------------
test("extractWbcEditionId aus allen URL-Formen", () => {
  assert.equal(P.extractWbcEditionId("https://www.wbc.poznan.pl/dlibra/publication/147448/edition/156210/content"), "156210");
  assert.equal(P.extractWbcEditionId("https://www.wbc.poznan.pl/dlibra/publication/edition/156210/x"), "156210");
  assert.equal(P.extractWbcEditionId("https://www.wbc.poznan.pl/Content/156210/index.djvu"), "156210");
  assert.equal(P.extractWbcEditionId("https://www.wbc.poznan.pl/dlibra/docmetadata?id=156210&from=edition"), "156210");
  assert.equal(P.extractWbcEditionId("https://www.wbc.poznan.pl/dlibra/docmetadata?id=156210"), "156210");
  assert.equal(P.extractWbcEditionId("https://www.wbc.poznan.pl/dlibra/docmetadata?id=147448&from=publication"), null);
  assert.equal(P.extractWbcEditionId("kein url"), null);
});

test("isWbcPoznanDlibraUrl, buildWbcOaiMetsUrl, looksLikeWbcPowChallenge", () => {
  assert.equal(P.isWbcPoznanDlibraUrl("https://www.wbc.poznan.pl/dlibra/publication/1/edition/2/content"), true);
  assert.equal(P.isWbcPoznanDlibraUrl("https://www.wbc.poznan.pl/Content/2/x.djvu"), true);
  assert.equal(P.isWbcPoznanDlibraUrl("https://www.wbc.poznan.pl/"), false);
  assert.equal(P.isWbcPoznanDlibraUrl("https://example.com/dlibra/x"), false);
  assert.equal(
    P.buildWbcOaiMetsUrl("156210", "https://www.wbc.poznan.pl/dlibra/publication/147448/edition/156210/content"),
    "https://www.wbc.poznan.pl/dlibra/oai-pmh-repository.xml?verb=GetRecord&metadataPrefix=mets&identifier=oai%3Awww.wbc.poznan.pl%3A156210"
  );
  assert.equal(P.buildWbcOaiMetsUrl("1", "kein url"), null);
  assert.equal(P.looksLikeWbcPowChallenge("<h1>High Load - Verifying Browser</h1>"), true);
  assert.equal(P.looksLikeWbcPowChallenge("document.cookie='captcha_pow=1'"), true);
  assert.equal(P.looksLikeWbcPowChallenge("<html>normal</html>"), false);
});

test("dLibra-METS: PublicAccess false, Titel, Datum, Rechte", () => {
  const xml = fixture("mets-dlibra.xml");
  assert.equal(P.extractWbcPublicAccess(xml), "false");
  assert.equal(P.extractWbcPublicAccess("<x/>"), null);
  const meta = P.extractWbcMetaFromMets(xml);
  assert.equal(meta.title, "Księga urodzin i chrztów"); // LABEL-Attribut mit einfachen Anführungszeichen
  assert.equal(meta.date, "1850");
  assert.equal(meta.rights, "Biblioteka Raczyńskich");
});

test("dLibra-METS: dc:title mit Präfix, wenn LABEL fehlt; exaktes Präfix hat Vorrang", () => {
  const noLabel = fixture("mets-dlibra.xml").replace(/ LABEL='[^']*'/, "");
  assert.equal(P.extractWbcMetaFromMets(noLabel).title, "Księga urodzin & chrztów"); // CDATA
  assert.equal(P.extractCdataOrText("<mods:title>A</mods:title><dc:title>B</dc:title>", "dc:title"), "B");
  assert.equal(P.extractCdataOrText("<mods:title>A</mods:title>", "dc:title"), "A"); // anderes Präfix
  assert.equal(P.extractCdataOrText("<t>a <b>b</b> &amp; c</t>", "t"), "a b & c");
  assert.equal(P.extractCdataOrText("<t/>", "x"), null);
});

test("dLibra-METS: Seitenliste nach ID-Suffix sortiert, index.djvu ausgeklammert", () => {
  const r = P.extractWbcPageFilesFromMets(fixture("mets-dlibra.xml"), "https://www.wbc.poznan.pl/dlibra/oai");
  assert.deepEqual(r.pageUrls, [
    "https://www.wbc.poznan.pl/Content/156210/directory/page1.djvu",
    "https://www.wbc.poznan.pl/Content/156210/directory/page2.djvu",
    "https://www.wbc.poznan.pl/Content/156210/directory/page3.djvu"
  ]);
  assert.equal(r.wholeDocumentUrl, "https://www.wbc.poznan.pl/Content/156210/index.djvu");
});

// ---------------------------------------------------------------------
// Allgemeine Helfer
// ---------------------------------------------------------------------
test("stripHtmlEntities: kein doppeltes Dekodieren", () => {
  assert.equal(P.stripHtmlEntities("&amp;#39;"), "&#39;");
  assert.equal(P.stripHtmlEntities("&#39;x&#x41;&quot;&lt;&gt;&nbsp;a   b"), "'xA\"<> a b");
  assert.equal(P.stripHtmlEntities("&#0;&#xD800;ok"), "ok");
});

test("safeFromCodePoint", () => {
  assert.equal(P.safeFromCodePoint(65), "A");
  assert.equal(P.safeFromCodePoint(0), "");
  assert.equal(P.safeFromCodePoint(0xd800), "");
  assert.equal(P.safeFromCodePoint(NaN), "");
});

test("sanitizeForFilesystem", () => {
  assert.equal(P.sanitizeForFilesystem("CON"), "_CON");
  assert.equal(P.sanitizeForFilesystem("nul.txt"), "_nul.txt");
  assert.equal(P.sanitizeForFilesystem('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(P.sanitizeForFilesystem("Müller – Ärger ß  "), "Müller – Ärger ß");
  assert.equal(P.sanitizeForFilesystem("name. . "), "name");
  assert.equal(P.sanitizeForFilesystem(""), "Quelle");
  assert.equal(P.sanitizeForFilesystem(null), "Quelle");
});

test("utf8ToBase64 (Umlaute, lange Strings)", () => {
  assert.equal(P.utf8ToBase64("äöü€"), Buffer.from("äöü€").toString("base64"));
  const long = "ä".repeat(50000);
  assert.equal(P.utf8ToBase64(long), Buffer.from(long).toString("base64"));
});

test("isSafeExternalUrl", () => {
  assert.equal(P.isSafeExternalUrl("https://a.de/x"), true);
  assert.equal(P.isSafeExternalUrl("http://a.de/x"), true);
  assert.equal(P.isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(P.isSafeExternalUrl("file:///etc/passwd"), false);
  assert.equal(P.isSafeExternalUrl("blob:https://a.de/1"), false);
  assert.equal(P.isSafeExternalUrl("data:text/html,<script>1</script>"), false);
  assert.equal(P.isSafeExternalUrl("data:text/html,<script>1</script>", { allowDataImage: true }), false);
  assert.equal(P.isSafeExternalUrl("data:image/svg+xml;base64,PHN2Zz4=", { allowDataImage: true }), false);
  assert.equal(P.isSafeExternalUrl("data:image/png;base64,iVBOR", { allowDataImage: true }), true);
  assert.equal(P.isSafeExternalUrl("data:image/jpeg;base64,/9j/", { allowDataImage: true }), true);
  // data:image nur, wenn ausdrücklich erlaubt
  assert.equal(P.isSafeExternalUrl("data:image/png;base64,iVBOR"), false);
  assert.equal(P.isSafeExternalUrl(""), false);
  assert.equal(P.isSafeExternalUrl(null), false);
});

test("sanitizeFindResult verwirft unzulässige URL-Schemata", () => {
  const ok = { ok: true, imageUrl: "https://a.de/i.jpg", downloadUrl: "https://a.de/d.jpg" };
  assert.equal(P.sanitizeFindResult(ok), ok);
  const bad = P.sanitizeFindResult({ ok: true, imageUrl: "javascript:1" });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /imageUrl/);
  assert.equal(P.sanitizeFindResult({ ok: true, downloadUrl: "data:image/svg+xml,x" }).ok, false);
  assert.equal(P.sanitizeFindResult({ ok: true, suggestedUrl: "data:image/png;base64,AA" }).ok, false);
  assert.equal(P.sanitizeFindResult(null), null);
});
