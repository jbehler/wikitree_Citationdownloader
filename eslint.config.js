"use strict";
// ESLint 9 Flat Config. Bewusst nur eslint:recommended, keine Stilregeln.
const js = require("@eslint/js");
const globals = require("globals");

// Funktionen aus lib/parsers.js sind im Service Worker per importScripts
// global - als bekannte Globals für background.js eintragen (Liste kommt
// direkt aus den Exports, bleibt also automatisch synchron).
const parserGlobals = Object.fromEntries(
  Object.keys(require("./lib/parsers.js")).map((name) => [name, "readonly"])
);

module.exports = [
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    // Bewusst leere catch-Blöcke wie `catch (e) { return null; }` sind im
    // Code Absicht (Fehler -> Fallback) - ungenutzte Fehlervariablen daher
    // nicht melden; sonst bleibt no-unused-vars unverändert aktiv.
    rules: { "no-unused-vars": ["error", { caughtErrors: "none" }] }
  },
  {
    // Service Worker: klassisches Skript (kein type:module), lädt
    // lib/parsers.js per importScripts.
    files: ["background.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.serviceworker, ...globals.webextensions,
        ...parserGlobals,
        AbortController: "readonly",
        // Nur in Funktionen, die per chrome.scripting.executeScript in die
        // Seite injiziert werden und dort im Tab-Kontext laufen.
        document: "readonly"
      }
    }
  },
  {
    // Parser-Bibliothek: im Service Worker global, für Node zusätzlich per
    // module.exports exportiert (daher "module" bekannt).
    files: ["lib/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.serviceworker, ...globals.webextensions, module: "writable" }
    }
  },
  {
    // Content Script auf wikitree.com (IIFE, kein Modul).
    files: ["content.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions }
    }
  },
  {
    // Tests und Konfiguration laufen in Node (CommonJS).
    files: ["test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node }
    }
  }
];
