#!/usr/bin/env node
"use strict";
/* CLI renderer for external-editor workflows (VS Code etc.) and CI.
 * Same pipeline as the browser app: parseSpec -> buildElk -> ELK ->
 * assignPorts -> ELK -> renderSVG (two passes: hub ports need pass-1 geometry). */
const fs = require("fs");
const path = require("path");
const ELK = require("elkjs");
const nd = require("../src/netdiagram.js");

const USAGE = `usage: node scripts/render.js <input.yaml|input.svg> [output.svg] [options]
  --watch                re-render on every save of the input
  --theme paper|blueprint
  --tags a,b             draw only what carries one of these tags
  --compare base.yaml    mark what changed since base (YAML or a netdiagram SVG)
  --csv rules.csv        also write the Connections table (firewall rules) as CSV
  --date YYYY-MM-DD      title-block date (else diagram.date, $SOURCE_DATE_EPOCH, today)
  --no-source            don't embed the YAML source in the SVG
  --extract              print the YAML embedded in a netdiagram SVG and exit`;
const VALUE_FLAGS = new Set(["theme", "tags", "compare", "csv", "date"]);
const BOOL_FLAGS = new Set(["watch", "no-source", "extract", "help"]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const opts = {}, positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { positional.push(argv[i]); continue; }
  if (VALUE_FLAGS.has(m[1])) {
    opts[m[1]] = m[2] ?? argv[++i];
    if (opts[m[1]] == null || opts[m[1]] === "") fail(`--${m[1]} needs a value\n\n${USAGE}`);
  } else if (BOOL_FLAGS.has(m[1])) opts[m[1]] = true;
  else fail(`unknown option --${m[1]}\n\n${USAGE}`);
}
const [input, outArg] = positional;
if (opts.help) { console.log(USAGE); process.exit(0); }
if (!input) fail(USAGE);
if (opts.theme && !Object.hasOwn(nd.THEMES, opts.theme)) fail(`unknown theme "${opts.theme}" — use ${Object.keys(nd.THEMES).join(" or ")}`);
if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) fail("--date expects YYYY-MM-DD");

const isSvg = f => /\.svg$/i.test(f);
/* spec text from a YAML file, or the source embedded in a netdiagram SVG */
function readSpecText(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!isSvg(file)) return text;
  const src = nd.extractSource(text);
  if (src == null) throw new Error(`${file}: no embedded netdiagram source`);
  return src;
}

if (opts.extract) {
  try { process.stdout.write(readSpecText(input)); } catch (e) { fail(e.message); }
  process.exit(0);
}

const output = outArg || (isSvg(input) ? null : input.replace(/\.ya?ml$/i, "") + ".svg");
if (!output) fail("an SVG input needs an explicit output file (it would overwrite itself)");
const tags = opts.tags ? opts.tags.split(",").map(s => s.trim()).filter(Boolean) : [];
const epoch = Number(process.env.SOURCE_DATE_EPOCH);
const envDate = process.env.SOURCE_DATE_EPOCH && Number.isFinite(epoch)
  ? new Date(epoch * 1000).toISOString().slice(0, 10) : undefined;

const elk = new ELK();
async function render() {
  try {
    const text = readSpecText(input);
    const sourceSpec = nd.parseSpec(text);
    let doc = tags.length ? nd.filterDoc(sourceSpec.doc, tags) : sourceSpec.doc;
    if (tags.length && !doc.nodes.length) throw new Error(`nothing is tagged ${tags.join(", ")}`);
    let diff = null;
    if (opts.compare) {
      const base = nd.parseSpec(readSpecText(opts.compare)).doc;
      diff = { ...nd.diffDocs(tags.length ? nd.filterDoc(base, tags) : base, doc), base: path.basename(opts.compare) };
      doc = diff.doc;
    }
    const spec = doc === sourceSpec.doc ? sourceSpec : nd.specFromDoc(doc);
    const pass1 = await elk.layout(nd.buildElk(spec));
    const ported = nd.assignPorts(nd.buildElk(spec), pass1);
    const svg = nd.renderSVG(spec, ported ? await elk.layout(ported) : pass1, {
      theme: opts.theme,
      date: opts.date || (sourceSpec.doc.diagram?.date == null ? envDate : undefined),
      source: opts["no-source"] ? undefined : text,
      rows: tags.length ? [["filter", "tags: " + tags.join(", ")]] : [],
      diff,
    });
    fs.writeFileSync(output, svg);
    if (opts.csv) fs.writeFileSync(opts.csv, nd.rulesToCsv(nd.connectionRules(spec).rules, diff && diff.status.connections) + "\n");
    const counts = diff ? ` · +${diff.counts.added} −${diff.counts.removed} ~${diff.counts.changed} vs ${diff.base}` : "";
    console.log(`${output} — ${spec.nodeMap.size} nodes · ${spec.groupMap.size} groups · ${(spec.doc.connections || []).length} connections${counts}`);
  } catch (e) {
    console.error(e.message);
    if (!opts.watch) process.exit(1);
  }
}

render().then(() => {
  if (!opts.watch) return;
  console.log(`watching ${input} — Ctrl-C to stop`);
  fs.watchFile(input, { interval: 300 }, render);
});
