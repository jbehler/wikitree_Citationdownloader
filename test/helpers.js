"use strict";
// Gemeinsame Test-Hilfen: content.js (IIFE ohne Module) in einem vm-Kontext
// mit minimalem Fake-DOM laden.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// src: Quelltext von content.js. extraHook: optionaler Code, der VOR dem
// Ende der IIFE eingefügt wird (nur für den Vergleich mit altem Code, der
// den __QBA_TEST__-Hook noch nicht hatte).
function loadContentScript(src, { sendMessage } = {}) {
  const sandbox = {
    __QBA_TEST__: {},
    // Keine WikiTree-Quellenliste, keine Links -> findSourceLinks() liefert
    // 0 Treffer, es wird nichts gerendert.
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild() {} }
    },
    location: { pathname: "/wiki/Test-1", href: "https://www.wikitree.com/wiki/Test-1" },
    chrome: { runtime: { sendMessage: sendMessage || (async () => ({})) } },
    URL,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "content.js" });
  return sandbox.__QBA_TEST__;
}

function readContentScript() {
  return fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
}

module.exports = { loadContentScript, readContentScript };
