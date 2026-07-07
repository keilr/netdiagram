"use strict";
/* Tests: core pipeline (parse -> layout -> render), feature rendering,
 * validation errors, and a full boot of dist/netdiagram.html in jsdom.
 * Run: npm test (builds dist first via pretest). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ELK = require("elkjs");
const { parseSpec, buildElk, renderSVG } = require("../src/netdiagram.js");

const root = path.join(__dirname, "..");
const EXAMPLE = fs.readFileSync(path.join(root, "examples/hq-edge-core.yaml"), "utf8");
const elk = new ELK();

const results = [];
function test(name, fn) { results.push([name, fn]); }

// ---------- pipeline + feature rendering ----------
let svg, spec;
test("example parses and renders", async () => {
  spec = parseSpec(EXAMPLE);
  const layout = await elk.layout(buildElk(spec));
  svg = renderSVG(spec, layout);
  assert.ok(spec.nodeMap.size >= 10, "nodes");
  assert.ok(spec.groupMap.size >= 4, "groups");
  const edges = [...svg.matchAll(/class="edge"/g)].length;
  assert.strictEqual(edges, spec.doc.links.length, "every link rendered as an edge path");
});

test("groups render cidr and classes", () => {
  assert.ok(svg.includes("10.0.10.0/24"), "cidr text");
  assert.ok(svg.includes("SERVER LAN"), "group label");
});

test("diagram attributes render as rows in the title block", () => {
  assert.ok(svg.includes(">AUTHOR</text>"), "attr key uppercased");
  assert.ok(svg.includes(">remy</text>"), "attr value");
  assert.ok(svg.includes(">REVISION</text>") && svg.includes(">1.2</text>"), "second attr");
});

test("group attributes render bottom-right in the group", () => {
  assert.ok(svg.includes(">owner: </tspan>"), "group attr key");
  assert.ok(svg.includes(">netops</tspan>"), "group attr value");
  const attrLine = svg.match(/<text[^>]*><tspan[^>]*>owner: /)?.[0];
  assert.ok(attrLine && attrLine.includes('text-anchor="end"'), "attr anchored to the right edge");
});

test("nodes render kv lines (os/ip one per line) and type caption", () => {
  assert.ok(svg.includes("os: </tspan>"), "os key");
  assert.ok(svg.includes(">linux</tspan>"), "os value");
  assert.ok(svg.includes("ip: </tspan>"), "ip key");
  // db1 has two ips -> two separate ip lines
  assert.ok(svg.includes(">10.0.20.21</tspan>") && svg.includes(">10.0.99.21</tspan>"), "multi-ip lines");
  assert.ok(svg.includes(">FIREWALL</text>"), "type caption under icon");
});

test("tags render as neutral pills; platform types set border styles", () => {
  for (const t of ["HA", "PROD", "PCI"]) assert.ok(svg.includes(`>${t}</text>`), t + " pill");
  assert.ok(svg.includes('stroke-dasharray="5 3"'), "vm-typed node dashed border");
  assert.ok(svg.includes('stroke-dasharray="2 3"'), "container-typed node dotted border");
});

test("tags wrap to a new row after two pills", async () => {
  const s = parseSpec("nodes:\n  - {id: a, tags: [vm, prod, pci]}");
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  const ys = [...out.matchAll(/<rect x="[\d.-]+" y="([\d.-]+)" width="[\d.]+" height="12" rx="6"/g)].map(m => m[1]);
  assert.strictEqual(ys.length, 3, "three pills drawn");
  assert.strictEqual(new Set(ys).size, 2, "pills occupy two rows");
});

test("platform types draw dedicated glyphs and set border style; tags do not", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: v, type: vm}",
    "  - {id: c, type: docker}",             // alias -> container
    "  - {id: m, type: metal}",
    "  - {id: t, type: server, tags: [vm]}", // tag is a neutral pill, no styling
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('M8 8V5.5'), "vm glyph drawn");
  assert.ok(out.includes('M6.5 10v5'), "container glyph via docker alias");
  assert.ok(out.includes('M9.5 6V3'), "metal glyph drawn");
  assert.ok(out.includes('rx="4" fill="none"'), "metal double border (inner rect)");
  assert.strictEqual([...out.matchAll(/stroke-dasharray="5 3"/g)].length, 1,
    "dashed border only on the vm-typed node, not the vm-tagged one");
  assert.strictEqual([...out.matchAll(/stroke-dasharray="2 3"/g)].length, 1,
    "dotted border only on the container-typed node");
});

test("equal labels share a color; distinct labels differ", () => {
  const hexFor = lbl =>
    [...svg.matchAll(new RegExp('fill="(#[0-9a-f]{6})"[^>]*>' + lbl + "</text>", "g"))]
      .map(m => m[1]);
  const hssh = hexFor("ssh"), hsyslog = hexFor("syslog");
  assert.strictEqual(hssh.length, 2, "two ssh labels");
  assert.strictEqual(hssh[0], hssh[1], "ssh labels share color");
  assert.strictEqual(hsyslog.length, 2, "two syslog labels");
  assert.strictEqual(hsyslog[0], hsyslog[1], "syslog labels share color");
  assert.notStrictEqual(hssh[0], hsyslog[0], "ssh differs from syslog");
});

test("all examples parse, layout and render", async () => {
  const files = fs.readdirSync(path.join(root, "examples")).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length >= 2, "at least two examples");
  await Promise.all(files.map(async (f) => {
    const s = parseSpec(fs.readFileSync(path.join(root, "examples", f), "utf8"));
    const out = renderSVG(s, await elk.layout(buildElk(s)));
    assert.ok(out.startsWith("<svg"), f + " renders");
  }));
});

test("group-to-group and group-to-node links route", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: a, label: a, type: server}",
    "  - {id: c, label: c, type: siem}",
    "groups:",
    "  - {id: g1, label: G1, class: zone, nodes: [a]}",
    "  - {id: g2, label: G2, class: cloud, nodes: [c]}",
    "links:",
    "  - {from: g1, to: g2, label: netflow}",
    "  - {from: g1, to: c}",
  ].join("\n"));
  const layout = await elk.layout(buildElk(s));
  const out = renderSVG(s, layout);
  assert.strictEqual([...out.matchAll(/marker-end/g)].length, 2, "both group links drawn");
});

// ---------- validation ----------
function expectError(yaml, needle) {
  try { parseSpec(yaml); assert.fail("expected error: " + needle); }
  catch (e) { assert.ok(e.message.includes(needle), `"${e.message}" should include "${needle}"`); }
}
test("validation: unknown link endpoint", () =>
  expectError("nodes:\n  - {id: a}\nlinks:\n  - {from: a, to: ghost}", 'unknown endpoint "ghost"'));
test("validation: tags must be scalars", () =>
  expectError("nodes:\n  - {id: a, tags: {env: prod}}", "tags must be a scalar or a list of scalars"));
test("validation: node in two groups", () =>
  expectError(
    "nodes:\n  - {id: a}\ngroups:\n  - {id: g1, nodes: [a]}\n  - {id: g2, nodes: [a]}",
    'is in both'));

// ---------- dist boot (jsdom) ----------
test("dist/netdiagram.html boots and renders in jsdom", async () => {
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(root, "dist/netdiagram.html"), "utf8");
  assert.ok(!/cdnjs|jsdelivr|unpkg/.test(html), "dist must be self-contained (no CDN refs)");
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const errs = [];
  dom.window.addEventListener("error", (e) => errs.push(e.message));
  // poll until the page settles (OK status, error status, or page error), 5 s ceiling
  const statusEl = dom.window.document.querySelector("#status");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !errs.length
         && !/^OK/.test(statusEl.textContent) && !statusEl.classList.contains("error"))
    await new Promise((r) => setTimeout(r, 100));
  const status = statusEl.textContent;
  const rendered = dom.window.document.querySelector("#canvas-pane svg");
  assert.deepStrictEqual(errs, [], "no page errors");
  assert.ok(rendered, "svg rendered");
  assert.ok(/^OK/.test(status), "status OK, got: " + status);
});

// ---------- runner ----------
(async () => {
  let failed = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log("  ok   " + name); }
    catch (e) { failed++; console.error("  FAIL " + name + "\n       " + e.message); }
  }
  console.log(failed ? `\n${failed} test(s) failed` : `\nall ${results.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
