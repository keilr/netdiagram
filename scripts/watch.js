#!/usr/bin/env node
"use strict";
/* Watches src/ and examples/ for changes and rebuilds dist/netdiagram.html. */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function build() {
  try {
    execSync("node scripts/build.js", { cwd: root, stdio: "inherit" });
  } catch (_) {
    /* build error already printed to stderr */
  }
}

build();

let timer;
function onChange(filename) {
  console.log(`[watch] changed: ${filename}`);
  clearTimeout(timer);
  timer = setTimeout(build, 80);
}

/* watch the build's input directories so new files are picked up without
 * maintaining a file list here; the schema sits alone at the repo root */
for (const dir of ["src", "examples"])
  fs.watch(path.join(root, dir), (ev, f) => onChange(dir + "/" + (f || "")));
fs.watchFile(path.join(root, "netdiagram-schema.json"), { interval: 300 },
  () => onChange("netdiagram-schema.json"));

console.log("watching src/ and examples/ … Ctrl-C to stop");
