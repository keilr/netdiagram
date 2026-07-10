#!/usr/bin/env node
"use strict";
/*
 * Build: src/template.html + vendored libs + src/*.js + examples/hq-edge-core.yaml
 *        -> dist/netdiagram.html (fully self-contained, no CDN, works offline)
 *
 * IMPORTANT: library code is spliced in via split/join on placeholder comments.
 * NEVER use String.prototype.replace with file content as the replacement string:
 * minified code contains `$\`` / `$&` sequences that replace() interprets as
 * replacement patterns and will corrupt the output (this bit us once already).
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// script-safe: prevent premature </script> termination inside inlined code
const scriptSafe = (s) => s.replace(/<\/script/gi, () => "<\\/script");

// inject via split/join — immune to $-pattern interpretation
function inject(template, placeholder, content) {
  const parts = template.split(placeholder);
  if (parts.length !== 2) throw new Error(`placeholder ${placeholder} not found exactly once`);
  return parts[0] + content + parts[1];
}

// 1. bundle CodeMirror editor (YAML + JSON Schema autocomplete/lint/hover)
const editorBundle = esbuild.buildSync({
  entryPoints: [path.join(root, "src/editor.js")],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  platform: "browser",
}).outputFiles[0].text;

// 2. vendor js-yaml as a window global
const jsyaml = esbuild.buildSync({
  stdin: { contents: 'window.jsyaml = require("js-yaml");', resolveDir: root },
  bundle: true,
  minify: true,
  write: false,
}).outputFiles[0].text;

// 3. vendor elkjs (already a standalone browser bundle exposing window.ELK; just minify)
const elk = esbuild.transformSync(read("node_modules/elkjs/lib/elk.bundled.js"), {
  minify: true,
}).code;

// 4. app payload: examples + schema + core library + browser wire-up
const DEFAULT_EXAMPLE = "hq-edge-core.yaml"; // shown on first load
const jsyamlLib = require("js-yaml");
const examples = fs.readdirSync(path.join(root, "examples"))
  .filter((f) => f.endsWith(".yaml"))
  .sort((a, b) => (a === DEFAULT_EXAMPLE ? -1 : b === DEFAULT_EXAMPLE ? 1 : a.localeCompare(b)))
  .map((f) => {
    const yaml = read("examples/" + f);
    let name = f.replace(/\.yaml$/, "");
    try { name = String(jsyamlLib.load(yaml)?.diagram?.title || name); } catch (e) { /* fall back to filename */ }
    return { name, yaml };
  });
const schema  = read("netdiagram-schema.json");
const core = read("src/netdiagram.js");
const app = read("src/app.js");
const version = require(path.join(root, "package.json")).version;
const payload =
  `window.NETDIAGRAM_VERSION = ${JSON.stringify(version)};\n` +
  `const EXAMPLES = ${JSON.stringify(examples)};\nconst SCHEMA = ${schema};\n` + core + "\n" + app;

// 5. assemble
let html = read("src/template.html");
html = inject(html, "<!--INJECT:JSYAML-->",  "/* js-yaml — MIT */\n" + scriptSafe(jsyaml));
html = inject(html, "<!--INJECT:ELK-->",     "/* elkjs (Eclipse Layout Kernel) — EPL-2.0 */\n" + scriptSafe(elk));
html = inject(html, "<!--INJECT:EDITOR-->",  "/* CodeMirror — MIT */\n" + scriptSafe(editorBundle));
html = inject(html, "<!--INJECT:APP-->",     scriptSafe(payload));

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "netdiagram.html"), html);
console.log(`dist/netdiagram.html — ${Math.round(html.length / 1024)} KB`);
