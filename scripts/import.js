#!/usr/bin/env node
"use strict";
/* Scaffold a netdiagram spec from an existing inventory:
 *   node scripts/import.js <file|-> [--from ansible|terraform|netbox] [-o out.yaml]
 * The format is detected unless --from is given; `-` reads stdin, e.g.
 *   terraform show -json | node scripts/import.js - --from terraform -o net.yaml
 *   ansible-inventory -i inventory --list | node scripts/import.js - -o net.yaml
 * Writes YAML to stdout unless -o is given. */
const fs = require("fs");
const { detectImport, importAs } = require("../src/importers.js");

const USAGE = "usage: node scripts/import.js <file|-> [--from ansible|terraform|netbox] [-o out.yaml]";
const args = process.argv.slice(2);
let file = null, from = null, out = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--from") from = args[++i];
  else if (a.startsWith("--from=")) from = a.slice(7);
  else if (a === "-o" || a === "--out") out = args[++i];
  else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
  else if (file == null) file = a;
  else { console.error(USAGE); process.exit(1); }
}
if (!file || (args.includes("--from") && !from) || ((args.includes("-o") || args.includes("--out")) && !out)) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const text = fs.readFileSync(file === "-" ? 0 : file, "utf8");
  const result = from ? importAs(from, text) : detectImport(text, file === "-" ? "" : file);
  if (!result) throw new Error("unrecognized format (or already netdiagram YAML) — pass --from ansible|terraform|netbox");
  if (out) fs.writeFileSync(out, result.yaml);
  else process.stdout.write(result.yaml);
  console.error(`${result.label}: ${result.summary}${out ? " -> " + out : ""}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
