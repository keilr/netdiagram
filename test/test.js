"use strict";
/* Tests: core pipeline (parse -> layout -> render), feature rendering,
 * validation errors, and a full boot of dist/netdiagram.html in jsdom.
 * Run: npm test (builds dist first via pretest). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ELK = require("elkjs");
const { parseSpec, buildElk, assignPorts, renderSVG } = require("../src/netdiagram.js");

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
  assert.strictEqual(edges, spec.doc.connections.length, "every connection rendered as an edge path");
});

test("title block stamps the netdiagram version", () => {
  const version = require("../package.json").version;
  assert.ok(svg.includes(`netdiagram v${version}</text>`),
    `title block shows "netdiagram v${version}"`);
});

test("svg is accessible: role, title and desc", () => {
  assert.ok(/<svg[^>]*role="img"/.test(svg), "svg has role=img");
  assert.ok(/aria-labelledby="nd-title nd-desc"/.test(svg), "svg is labelled by title+desc");
  assert.ok(/<title id="nd-title">HQ edge &amp; core<\/title>/.test(svg), "title is the diagram title (escaped)");
  assert.ok(/<desc id="nd-desc">\d+ nodes?, \d+ groups?, \d+ connections?<\/desc>/.test(svg), "desc summarises counts");
});

test("user text is escaped everywhere it reaches the svg (no injection)", async () => {
  const s = parseSpec([
    'diagram:',
    '  title: "<script>T</script>"',
    '  owner: "a&b"',
    'nodes:',
    '  - id: n1',
    '    label: "</text><script>x</script>"',
    '    type: server',
    '    note: "<b>bad</b>"',
    '    tags: ["<u>tag</u>"]',
    '  - {id: n2, label: n2, type: db}',
    'groups:',
    '  - id: g1',
    '    label: "<i>grp</i>"',
    '    cidr: "10/8<hack>"',
    '    nodes: [n1]',
    'connections:',
    '  - {from: n1, to: n2, label: "<img onerror=1>"}',
  ].join('\n'));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  for (const raw of ['<script', '<img', '<b>', '<u>', '<i>', '<hack>'])
    assert.ok(!out.toLowerCase().includes(raw.toLowerCase()), `no raw "${raw}" from user input`);
  assert.ok(out.includes('&lt;script&gt;'), "dangerous characters are HTML-escaped");
});

test("diagram direction defaults to down; right is explicit", () => {
  const dirOfSpec = yaml => buildElk(parseSpec(yaml)).layoutOptions['elk.direction'];
  assert.strictEqual(dirOfSpec("nodes:\n  - {id: a}"), 'DOWN', "no direction -> DOWN");
  assert.strictEqual(dirOfSpec("diagram: {direction: down}\nnodes:\n  - {id: a}"), 'DOWN', "down -> DOWN");
  assert.strictEqual(dirOfSpec("diagram: {direction: right}\nnodes:\n  - {id: a}"), 'RIGHT', "right -> RIGHT");
});

test("group tags render as pills in the group's class color", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: n, type: server}",
    "groups:",
    "  - {id: g, label: EPG, class: epg, tags: [prod], nodes: [n]}",
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(/fill="#15803d">PROD<\/text>/.test(out), "tag pill drawn in the epg (green) label color");
});

test("cisco ACI group classes render (e.g. epg)", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: n, type: server}",
    "groups:",
    "  - {id: g, label: EPG web, class: epg, nodes: [n]}",
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('rgba(21,128,61,.05)'), "epg class draws the green ACI tint");
});

test("hub->group fan-outs auto-pack into a grid instead of one wide row", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => "n" + i);
  const spec = parseSpec([
    "nodes:",
    "  - {id: hub, type: switch}",
    ...ids.map((id) => `  - {id: ${id}, label: ${id}, type: server, ip: 10.0.0.9}`),
    "groups:",
    `  - {id: farm, label: farm, class: subnet, nodes: [${ids.join(", ")}]}`,
    "connections:",
    "  - {from: hub, to: farm}",
  ].join("\n"));
  const graph = buildElk(spec);
  const farm = graph.children.find((c) => c.id === "farm");
  assert.strictEqual(farm.layoutOptions["elk.hierarchyHandling"], "SEPARATE_CHILDREN",
    "endpoint-free group gets packing options");
  const out = await elk.layout(graph);
  assert.ok(out.width < 1400, `packed star stays compact, got width ${Math.ceil(out.width)}`);
  assert.ok(out.width / out.height < 3, "no single wide layer row");

  // a group whose member is a connection endpoint must keep hierarchical layout
  const spec2 = parseSpec([
    "nodes:",
    "  - {id: hub, type: switch}",
    "  - {id: a, type: server}",
    "groups:",
    "  - {id: g, nodes: [a]}",
    "connections:",
    "  - {from: hub, to: a}",
  ].join("\n"));
  const g2 = buildElk(spec2).children.find((c) => c.id === "g");
  assert.strictEqual(g2.layoutOptions["elk.hierarchyHandling"], undefined,
    "member-endpoint group is not packed");
  assert.ok(renderSVG(spec2, await elk.layout(buildElk(spec2))).includes("marker-end"),
    "boundary-crossing edge still routes");
});

test("rank places siblings before/after the unranked row", async () => {
  const yaml = (gup, gdn) => [
    "nodes:",
    "  - {id: hub, type: switch}",
    "  - {id: a1, type: server}", "  - {id: a2, type: server}",
    "  - {id: b1, type: server}", "  - {id: b2, type: server}",
    "groups:",
    `  - {id: gup, nodes: [a1, a2]${gup}}`,
    `  - {id: gdn, nodes: [b1, b2]${gdn}}`,
    "connections:",
    "  - {from: hub, to: gup}",
    "  - {from: hub, to: gdn}",
  ].join("\n");
  const plain = buildElk(parseSpec(yaml("", "")));
  assert.strictEqual(plain.layoutOptions["elk.partitioning.activate"], undefined,
    "partitioning stays off without ranks");
  assert.strictEqual(plain.layoutOptions["elk.layered.considerModelOrder.strategy"], "NODES_AND_EDGES",
    "in-layer order follows yaml order");
  // rank -1 lays out before the unranked (rank 0) hub, rank 1 after it
  const out = await elk.layout(buildElk(parseSpec(yaml(", rank: -1", ", rank: 1"))));
  const y = Object.fromEntries(out.children.map((c) => [c.id, c.y]));
  assert.ok(y.gup < y.hub && y.hub < y.gdn,
    `expected gup above hub above gdn, got ${JSON.stringify(y)}`);
});

test("edge crossings render as hop arcs", async () => {
  // K3,3 is non-planar: whatever order ELK picks, some edges must cross
  const s = parseSpec([
    "nodes:",
    ...["a1","a2","a3","b1","b2","b3"].map((id) => `  - {id: ${id}, label: ${id}, type: server}`),
    "connections:",
    ...["a1","a2","a3"].flatMap((a) => ["b1","b2","b3"].map((b) => `  - {from: ${a}, to: ${b}}`)),
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  const edgePaths = [...out.matchAll(/class="edge"[^>]*? d="([^"]*)"/g)].map((m) => m[1]);
  assert.strictEqual(edgePaths.length, 9, "all K3,3 edges drawn");
  const arcs = edgePaths.join(" ").match(/A[\d.]+ [\d.]+ 0 0 [01]/g) || [];
  assert.ok(arcs.length >= 1, "at least one crossing drawn as a hop arc");
});

test("assignPorts pins hub edges toward their targets (two-pass layout)", async () => {
  // ansible-style hub: two estates above (rank -1), four below (rank 1)
  const groups = { gA: -1, gB: -1, gC: 1, gD: 1, gE: 1, gF: 1 };
  const s = () => parseSpec([
    "nodes:",
    "  - {id: hub, type: vm}",
    ...Object.keys(groups).flatMap((g) => [1, 2].map((i) => `  - {id: ${g}n${i}, type: server}`)),
    "groups:",
    ...Object.entries(groups).map(([g, r]) => `  - {id: ${g}, rank: ${r}, nodes: [${g}n1, ${g}n2]}`),
    "connections:",
    ...Object.keys(groups).map((g) => `  - {from: hub, to: ${g}}`),
  ].join("\n"));
  const pass1 = await elk.layout(buildElk(s()));
  const graph = assignPorts(buildElk(s()), pass1);
  assert.ok(graph, "hub with 6 edges gets ports");
  const hub = graph.children.find((c) => c.id === "hub");
  assert.strictEqual(hub.layoutOptions["elk.portConstraints"], "FIXED_ORDER");
  assert.strictEqual(hub.ports.length, 6, "one port per edge");
  const sides = hub.ports.map((p) => p.layoutOptions["elk.port.side"]);
  assert.strictEqual(sides.filter((x) => x === "NORTH").length, 2, "rank -1 targets face north");
  assert.strictEqual(sides.filter((x) => x === "SOUTH").length, 4, "rank 1 targets face south");
  // rank -1 targets sit before the hub in the flow: those edges go to ELK
  // reversed (routed with the flow, drawn flipped back by renderSVG)
  const rev = graph.edges.filter((e) => !e.sources[0].startsWith("hub.p"));
  assert.deepStrictEqual(rev.map((e) => e.sources[0]).sort(), ["gA", "gB"],
    "against-flow edges are reversed");
  assert.ok(graph.edges.every((e) => e.sources[0].startsWith("hub.p") || e.targets[0].startsWith("hub.p")),
    "every edge attaches to a hub port");
  // second pass lays out and renders without hub-edge crossings
  const out = renderSVG(s(), await elk.layout(graph));
  const edgePaths = [...out.matchAll(/class="edge"[^>]*? d="([^"]*)"/g)].map((m) => m[1]);
  assert.strictEqual(edgePaths.length, 6, "all edges drawn");
  const arcs = edgePaths.join(" ").match(/A[\d.]+ [\d.]+ 0 0 [01]/g) || [];
  assert.strictEqual(arcs.length, 0, "ordered ports leave no crossings");
  // nothing to pin: every node has a single edge
  const chain = parseSpec("nodes:\n  - {id: a}\n  - {id: b}\nconnections:\n  - {from: a, to: b}");
  assert.strictEqual(assignPorts(buildElk(chain), await elk.layout(buildElk(chain))), null,
    "returns null when no node has 2+ edges");
});

test("group style overrides color and border", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: n, type: server}",
    "groups:",
    "  - {id: g, label: G, class: subnet, nodes: [n], style: {color: red, border: dashed}}",
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('rgba(192,57,43,.05)'), "custom red fill applied");
  assert.ok(!out.includes('rgba(71,105,155,.06)'), "class (subnet) fill is overridden");
  assert.ok(out.includes('stroke-dasharray="8 5"'), "dashed border applied");
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

test("group cidr + attributes render in the bottom-right info box", () => {
  assert.ok(svg.includes('class="attr-box"'), "info box drawn");
  assert.ok(svg.includes(">owner: </tspan>"), "group attr key");
  assert.ok(svg.includes(">netops</tspan>"), "group attr value");
  assert.ok(svg.includes(">cidr: </tspan>"), "cidr rendered as key: value");
  assert.ok(svg.includes(">10.0.10.0/24</tspan>"), "cidr value inside the box");
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
    "  - {id: c, type: docker}",              // alias -> container
    "  - {id: m, type: metal}",
    "  - {id: s, type: server}",              // server = physical machine -> metal
    "  - {id: p, type: physical server}",     // multi-word alias -> metal
    "  - {id: t, type: host, tags: [vm]}",    // rack glyph; tag is a neutral pill, no styling
    "  - {id: d, type: metal, icon: db}",     // icon overrides glyph only, styling stays metal
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('M8 8V5.5'), "vm glyph drawn");
  assert.ok(out.includes('M6.5 10v5'), "container glyph via docker alias");
  assert.ok(out.includes('<ellipse cx="12" cy="5.5"'), "db glyph via icon override");
  assert.strictEqual([...out.matchAll(/M9\.5 6V3/g)].length, 3,
    "chip glyph for metal, server and 'physical server' (not the icon:db node)");
  assert.strictEqual([...out.matchAll(/rx="4" fill="none"/g)].length, 4,
    "double border for metal, server, 'physical server' and metal-with-db-icon");
  assert.ok(out.includes('M5 9h14'), "host keeps the rack glyph");
  assert.strictEqual([...out.matchAll(/stroke-dasharray="5 3"/g)].length, 1,
    "dashed border only on the vm-typed node, not the vm-tagged one");
  assert.strictEqual([...out.matchAll(/stroke-dasharray="2 3"/g)].length, 1,
    "dotted border only on the container-typed node");
});

test("waf and gpu draw their own glyphs with the default border", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: w, type: waf}",
    "  - {id: g, type: gpu}",
    "  - {id: a, type: accelerator}",   // alias -> gpu
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('M10.5 9.5 8.5 12'), "waf shield glyph drawn");
  assert.ok(!out.includes('M3 9.3h18'), "waf no longer falls back to the firewall glyph");
  assert.strictEqual([...out.matchAll(/<circle cx="8" cy="12" r="3\.2"/g)].length, 2,
    "gpu card glyph for type gpu and the accelerator alias");
  assert.strictEqual([...out.matchAll(/stroke-dasharray/g)].length, 0,
    "waf and gpu keep the default solid border (no platform styling)");
});

test("equal labels share a color; distinct labels differ", () => {
  const hexFor = lbl =>
    [...svg.matchAll(new RegExp('fill="(#[0-9a-f]{6})"[^>]*>' + lbl + "</text>", "g"))]
      .map(m => m[1]);
  const hssh = hexFor("tcp/22 ssh"), hsyslog = hexFor("udp/514 syslog");
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

test("group-to-group and group-to-node connections route", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: a, label: a, type: server}",
    "  - {id: c, label: c, type: siem}",
    "groups:",
    "  - {id: g1, label: G1, class: zone, nodes: [a]}",
    "  - {id: g2, label: G2, class: cloud, nodes: [c]}",
    "connections:",
    "  - {from: g1, to: g2, label: netflow}",
    "  - {from: g1, to: c}",
  ].join("\n"));
  const layout = await elk.layout(buildElk(s));
  const out = renderSVG(s, layout);
  assert.strictEqual([...out.matchAll(/marker-end/g)].length, 2, "both group connections drawn");
});

// ---------- validation ----------
function expectError(yaml, needle) {
  try { parseSpec(yaml); assert.fail("expected error: " + needle); }
  catch (e) { assert.ok(e.message.includes(needle), `"${e.message}" should include "${needle}"`); }
}
test("validation: unknown connection endpoint", () =>
  expectError("nodes:\n  - {id: a}\nconnections:\n  - {from: a, to: ghost}", 'unknown endpoint "ghost"'));
test("validation: legacy links key points to the rename", () =>
  expectError("nodes:\n  - {id: a}\nlinks:\n  - {from: a, to: a}", 'use "connections:"'));
test("validation: tags must be scalars", () =>
  expectError("nodes:\n  - {id: a, tags: {env: prod}}", "tags must be a scalar or a list of scalars"));
test("validation: node in two groups", () =>
  expectError(
    "nodes:\n  - {id: a}\ngroups:\n  - {id: g1, nodes: [a]}\n  - {id: g2, nodes: [a]}",
    'is in both'));
test("validation: rank must be numeric", () =>
  expectError("nodes:\n  - {id: a, rank: upper}", "rank must be a number"));

// ---------- editor value completion ----------
test("editor: value completion offers enum values and document ids", () => {
  // bundle src/editor.js like the build does (its deps are ESM-only)
  const code = require("esbuild").buildSync({
    stdin: {
      contents: [
        'globalThis.window = globalThis;',
        'const { EditorState } = require("@codemirror/state");',
        'const { yaml } = require("@codemirror/lang-yaml");',
        'const { CompletionContext } = require("@codemirror/autocomplete");',
        'const { valueCompletion } = require("./src/editor.js");',
        'module.exports = { EditorState, yaml, CompletionContext, valueCompletion };',
      ].join("\n"),
      resolveDir: root,
    },
    bundle: true, write: false, platform: "node", format: "cjs",
  }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, require);
  const { EditorState, yaml, CompletionContext, valueCompletion } = mod.exports;

  const schema = JSON.parse(fs.readFileSync(path.join(root, "netdiagram-schema.json"), "utf8"));
  const source = valueCompletion(schema);
  const labelsAt = (doc) => {
    const state = EditorState.create({ doc, extensions: [yaml()] });
    const res = source(new CompletionContext(state, doc.length, false));
    return res ? res.options.map((o) => o.label) : null;
  };

  assert.ok(labelsAt("nodes:\n  - id: fw1\n    type: f").includes("firewall"),
    "'type: f' offers firewall");
  assert.ok(labelsAt("groups:\n  - id: g\n    class: z").includes("zone"),
    "'class: z' offers zone");
  assert.ok(labelsAt("groups:\n  - id: g\n    style:\n      color: bl").includes("blue"),
    "'color: bl' offers blue (group style)");
  assert.ok(labelsAt("groups:\n  - id: g\n    style:\n      border: da").includes("dashed"),
    "'border: da' offers dashed (group style)");
  assert.ok(labelsAt("connections:\n  - {from: a, to: b, protocol: t").includes("tcp"),
    "protocol offers tcp (flow style)");
  assert.deepStrictEqual(labelsAt("nodes:\n  - id: fw1\n  - id: web1\nconnections:\n  - from: "),
    ["fw1", "web1"], "connection endpoints complete against document ids");
  assert.deepStrictEqual(
    labelsAt("nodes:\n  - id: n1\ngroups:\n  - id: g\n    nodes: [x, "),
    ["n1"], "group member list offers node ids only (not group ids)");
  assert.strictEqual(labelsAt("nodes:\n  - id: a\n    label: Edge"), null,
    "free-form keys get no value suggestions");
});

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

  // zoom controls scale the svg's width/height attributes
  const w0 = +rendered.getAttribute("width");
  dom.window.document.querySelector("#zoom-in").click();
  assert.strictEqual(+rendered.getAttribute("width"), Math.round(w0 * 1.25), "zoom in scales the svg");
  dom.window.document.querySelector("#zoom-pct").click();
  assert.strictEqual(+rendered.getAttribute("width"), w0, "reset returns to natural size");
});

test("projects persist: draft restored on reload, Save writes a named project", async () => {
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(root, "dist/netdiagram.html"), "utf8");
  const DRAFT = "diagram:\n  title: Restored Draft\n  direction: down\nnodes:\n  - {id: solo, label: Solo, type: server}\n";
  // a real origin enables localStorage; preseed a draft to simulate a prior session
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://netdiagram.test/",
    beforeParse(window) { try { window.localStorage.setItem("netdiagram:v1:draft", DRAFT); } catch (e) {} },
  });
  const win = dom.window, doc = win.document;
  win.prompt = () => "my project";            // name supplied to Save
  const errs = [];
  win.addEventListener("error", (e) => errs.push(e.message));
  const statusEl = doc.querySelector("#status");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !errs.length
         && !/^OK/.test(statusEl.textContent) && !statusEl.classList.contains("error"))
    await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(errs, [], "no page errors");
  // the autosaved draft is restored on load (1-node spec), not the default example
  assert.ok(/^OK — 1 nodes/.test(statusEl.textContent), "restored draft rendered, got: " + statusEl.textContent);
  assert.ok(doc.querySelector("#canvas-pane svg").outerHTML.includes("Solo"), "draft node drawn");
  assert.ok(!doc.querySelector("#project-picker").hidden, "project UI is live when storage works");
  // Save persists the current buffer as a named project
  doc.querySelector("#btn-save").click();
  const projects = JSON.parse(win.localStorage.getItem("netdiagram:v1:projects") || "{}");
  assert.ok(projects["my project"], "named project saved to localStorage");
  assert.strictEqual(projects["my project"].yaml, DRAFT, "saved project holds the current buffer");
  assert.strictEqual(win.localStorage.getItem("netdiagram:v1:active"), "my project", "saved project becomes active");
  assert.ok(!doc.querySelector("#btn-del").hidden, "delete is offered for the active project");
});

test("connections table: bidirectional yields two rows; comment column appears", async () => {
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(root, "dist/netdiagram.html"), "utf8");
  const DRAFT = [
    "diagram: {title: conn test}",
    "nodes:",
    "  - {id: a, label: aaa, type: server, ip: 10.0.0.1}",
    "  - {id: b, label: bbb, type: server, ip: 10.0.0.2}",
    "  - {id: c, label: ccc, type: db, ip: 10.0.0.3}",
    "connections:",
    "  - {from: a, to: b, protocol: tcp, port: 22, direction: both, comment: mgmt SSH}",
    "  - {from: b, to: c, protocol: tcp, port: 5432, label: pgsql}",
    "  - {from: a, to: c, direction: none, label: DENYME}",
  ].join("\n");
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://netdiagram.test/",
    beforeParse(w) { try { w.localStorage.setItem("netdiagram:v1:draft", DRAFT); } catch (e) {} },
  });
  const win = dom.window, doc = win.document;
  const errs = []; win.addEventListener("error", (e) => errs.push(e.message));
  const statusEl = doc.querySelector("#status");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !errs.length
         && !/^OK/.test(statusEl.textContent) && !statusEl.classList.contains("error"))
    await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(errs, [], "no page errors");
  const t = doc.querySelector("#connections-pane").innerHTML;
  assert.strictEqual((t.match(/class="conn-n"/g) || []).length, 3,
    "a<->b (2 rows) + b->c (1 row) = 3 rows; the direction:none flow is excluded");
  assert.ok(!t.includes("DENYME"), "direction:none connection excluded from the table");
  assert.ok(t.includes("<th>Comment</th>"), "comment column present when a comment exists");
  assert.strictEqual((t.match(/mgmt SSH/g) || []).length, 2, "comment shown on both directions");
  assert.ok(!t.includes("conn-dir"), "direction column removed");
  assert.ok(t.includes('class="conn-ep"'), "endpoints render as name + address cells");
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
