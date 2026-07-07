#!/usr/bin/env node
"use strict";
/* CLI renderer for external-editor workflows (VS Code etc.):
 *   node scripts/render.js <input.yaml> [output.svg] [--watch]
 * Same pipeline as the browser app: parseSpec -> buildElk -> ELK -> renderSVG.
 * --watch re-renders on save; pair it with an SVG preview in the editor. */
const fs = require("fs");
const ELK = require("elkjs");
const { parseSpec, buildElk, renderSVG } = require("../src/netdiagram.js");

const watch = process.argv.includes("--watch");
const [input, outArg] = process.argv.slice(2).filter(a => a !== "--watch");
if (!input) {
  console.error("usage: node scripts/render.js <input.yaml> [output.svg] [--watch]");
  process.exit(1);
}
const output = outArg || input.replace(/\.ya?ml$/i, "") + ".svg";

const elk = new ELK();
async function render() {
  try {
    const spec = parseSpec(fs.readFileSync(input, "utf8"));
    const svg = renderSVG(spec, await elk.layout(buildElk(spec)));
    fs.writeFileSync(output, svg);
    console.log(`${output} — ${spec.nodeMap.size} nodes · ${spec.groupMap.size} groups · ${(spec.doc.connections || []).length} connections`);
  } catch (e) {
    console.error(e.message);
    if (!watch) process.exit(1);
  }
}

render().then(() => {
  if (!watch) return;
  console.log(`watching ${input} — Ctrl-C to stop`);
  fs.watchFile(input, { interval: 300 }, render);
});
