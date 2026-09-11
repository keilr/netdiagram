#!/usr/bin/env node
"use strict";
/* Check a spec as a CI gate — exits non-zero when something is wrong:
 *   node scripts/check.js <spec.yaml> [--against <file|-> [--from ansible|terraform|netbox]]
 *                                     [--strict] [--json]
 * Without --against it lints the architecture (addresses, subnets, vocabulary,
 * contradictions). With --against it also compares the spec to a live
 * inventory and reports drift, so a pipeline can fail when the diagram no
 * longer matches the infrastructure it claims to describe. */
const fs = require("fs");
const nd = require("../src/netdiagram.js");
const { detectImport, importAs } = require("../src/importers.js");

const USAGE = `usage: node scripts/check.js <spec.yaml> [options]
  --against <file|->     compare with a live inventory (drift check); - reads stdin
  --from ansible|terraform|netbox
                         inventory format for --against (detected when omitted)
  --strict               treat warnings as failures too
  --json                 machine-readable findings on stdout

exit: 0 clean, 1 findings, 2 bad usage or unreadable input`;

const VALUE_FLAGS = new Set(["against", "from"]);
const BOOL_FLAGS = new Set(["strict", "json", "help"]);
const opts = {}, positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { positional.push(argv[i]); continue; }
  if (VALUE_FLAGS.has(m[1])) {
    opts[m[1]] = m[2] ?? argv[++i];
    if (opts[m[1]] == null || opts[m[1]] === "") fail(`--${m[1]} needs a value\n\n${USAGE}`, 2);
  } else if (BOOL_FLAGS.has(m[1])) opts[m[1]] = true;
  else fail(`unknown option --${m[1]}\n\n${USAGE}`, 2);
}
function fail(message, code) { console.error(message); process.exit(code); }

if (opts.help) { console.log(USAGE); process.exit(0); }
const input = positional[0];
if (!input || positional.length > 1) fail(USAGE, 2);

let spec, findings, drift = [];
try {
  spec = nd.parseSpec(fs.readFileSync(input, "utf8"));
} catch (e) {
  /* a malformed document cannot be reasoned about — report and stop */
  fail(`${input}: ${e.message}`, e.isSpec ? 1 : 2);
}
try {
  findings = nd.lintSpec(spec);
  if (opts.against) {
    const text = fs.readFileSync(opts.against === "-" ? 0 : opts.against, "utf8");
    const imported = opts.from ? importAs(opts.from, text)
      : detectImport(text, opts.against === "-" ? "" : opts.against);
    if (!imported) throw new Error(`${opts.against}: unrecognized inventory format — pass --from ansible|terraform|netbox`);
    drift = nd.driftReport(imported.doc, spec.doc);
  }
} catch (e) {
  fail(e.message, 2);
}

const errors = findings.filter((f) => f.severity === "error");
const warnings = findings.filter((f) => f.severity === "warning");
const failed = errors.length + drift.length > 0 || (opts.strict && warnings.length > 0);

if (opts.json) {
  console.log(JSON.stringify({ file: input, findings, drift, ok: !failed }, null, 2));
} else {
  const where = (p) => (p ? p.filter((s) => typeof s === "string" || Number.isInteger(s)).join(".") : "");
  for (const f of [...errors, ...warnings])
    console.log(`${f.severity === "error" ? "error  " : "warning"}  ${f.rule.padEnd(22)} ${f.message}${where(f.path) ? `  [${where(f.path)}]` : ""}`);
  for (const d of drift) console.log(`drift    ${d.rule.padEnd(22)} ${d.message}`);
  const parts = [];
  if (errors.length) parts.push(`${errors.length} error${errors.length !== 1 ? "s" : ""}`);
  if (warnings.length) parts.push(`${warnings.length} warning${warnings.length !== 1 ? "s" : ""}`);
  if (drift.length) parts.push(`${drift.length} drift`);
  console.log(`${input} — ${parts.length ? parts.join(", ") : "clean"}`);
}
process.exit(failed ? 1 : 0);
