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

test("k8s group classes and type aliases render", async () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: hv, type: hypervisor}",
    "  - {id: ing, type: ingress}",
    "  - {id: eg, type: egress-ip}",
    "groups:",
    "  - {id: c, label: prod, class: cluster, groups: [{id: n, label: ns web, class: namespace, nodes: [ing, eg]}]}",
    "  - {id: p, label: pool, class: nodepool, nodes: [hv]}",
  ].join("\n"));
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('rgba(29,78,216,.05)'), "cluster class draws the blue tint");
  assert.ok(out.includes('rgba(21,128,61,.05)'), "namespace class draws the green tint");
  assert.ok(out.includes('rgba(87,99,111,.05)'), "nodepool class draws the grey tint");
  assert.ok(out.includes('>HYPERVISOR<'), "hypervisor caption renders");
  assert.strictEqual([...out.matchAll(/rx="4" fill="none"/g)].length, 1,
    "hypervisor is physical -> bare-metal double border");
  assert.ok(out.includes('M9.5 6V3'), "hypervisor draws the metal chip glyph");
  assert.ok(out.includes('>INGRESS<') && out.includes('>EGRESS-IP<'), "ingress/egress captions render");
  assert.ok(out.includes('M12 7.5v4'), "ingress draws the lb glyph");
  assert.ok(out.includes('M7 9h7'), "egress-ip draws the router glyph");
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

// ---------- source map, embedding, themes, views ----------
const nd = require("../src/netdiagram.js");
const layoutOf = async (s) => {
  const pass1 = await elk.layout(buildElk(s));
  const graph = assignPorts(buildElk(s), pass1);
  return graph ? elk.layout(graph) : pass1;
};
const slice = (text, r) => text.slice(r.from, r.to);

test("validation errors carry document paths that sourceMap places", () => {
  const yaml = "nodes:\n  - {id: a}\n  - {id: a}\ngroups:\n  - {id: g, nodes: [a, zz]}\nconnections:\n  - {from: a, to: ghost}";
  let err;
  try { parseSpec(yaml); } catch (e) { err = e; }
  assert.ok(err && err.errors, "structured errors attached");
  const map = nd.sourceMap(yaml);
  const at = (needle) => err.errors.find((x) => x.message.includes(needle));
  assert.deepStrictEqual(at('unknown endpoint').path, ["connections", 0, "to"]);
  assert.strictEqual(slice(yaml, map.rangeOf(at('unknown endpoint').path)), "ghost", "endpoint error underlines the id");
  assert.strictEqual(slice(yaml, map.rangeOf(at('unknown node').path)), "zz", "member error underlines the member");
  assert.strictEqual(slice(yaml, map.rangeOf(at('duplicate node id').path)), "a", "duplicate points at the second id");
  assert.strictEqual(map.rangeOf(["nodes", 1, "id"]).from, yaml.indexOf("{id: a}", 12) + 5, "second node, not the first");
});

test("sourceMap finds items by id and by cursor position", () => {
  const map = nd.sourceMap(EXAMPLE);
  assert.ok(slice(EXAMPLE, map.itemRange("node", "db1")).startsWith("id: db1"), "node item range");
  assert.ok(slice(EXAMPLE, map.itemRange("group", "lan")).startsWith("id: lan"), "nested group item range");
  assert.ok(slice(EXAMPLE, map.itemRange("connection", 0)).startsWith("{from: inet"), "connection item range");
  assert.deepStrictEqual(map.itemAt(EXAMPLE.indexOf("pg-primary")), { kind: "node", id: "db1" });
  assert.deepStrictEqual(map.itemAt(EXAMPLE.indexOf("nodes: [core") + 9), { kind: "node", id: "core" }, "member id in a group list");
  assert.deepStrictEqual(map.itemAt(EXAMPLE.indexOf("owner: netops")), { kind: "group", id: "lan" });
  assert.deepStrictEqual(map.itemAt(EXAMPLE.indexOf('"vrrp ha"')), { kind: "connection", index: 2 });
  assert.strictEqual(map.itemAt(EXAMPLE.indexOf("revision")), null, "diagram block is no item");
  assert.strictEqual(nd.sourceMap("nodes: [unclosed"), null, "unparseable text has no map");
});

test("svg items carry data-id / data-conn for diagram <-> YAML navigation", () => {
  assert.ok(svg.includes('class="nd-node" data-id="db1"'), "node group tagged with its id");
  assert.ok(svg.includes('class="nd-group" data-id="lan"'), "group tagged with its id");
  const conns = new Set([...svg.matchAll(/class="edge" data-conn="(\d+)"/g)].map((m) => m[1]));
  assert.strictEqual(conns.size, spec.doc.connections.length, "every edge path carries its connection index");
});

test("exported svg embeds the YAML source and round-trips it", async () => {
  const text = 'diagram: {title: "a <b> & \'c\'"}\nnodes:\n  - {id: n, label: "]]> é 🌐"}\n';
  const s = parseSpec(text);
  const out = renderSVG(s, await elk.layout(buildElk(s)), { source: text });
  assert.ok(out.includes('<metadata id="netdiagram-source"'), "metadata element present");
  assert.strictEqual(nd.extractSource(out), text, "extractSource returns the exact source");
  assert.strictEqual(nd.extractSource(renderSVG(s, await elk.layout(buildElk(s)))), null, "no source unless asked");
  assert.strictEqual(nd.extractSource('<svg><metadata id="netdiagram-source"><![CDATA[a: <1>]]></metadata></svg>'), "a: <1>", "CDATA form");
});

test("title-block date: opts.date, then diagram.date, then today", async () => {
  const s = parseSpec("diagram: {date: '2020-02-02'}\nnodes:\n  - {id: a}");
  const layout = await elk.layout(buildElk(s));
  const out = renderSVG(s, layout);
  assert.ok(out.includes(">2020-02-02</text>"), "diagram.date shown");
  assert.strictEqual((out.match(/2020-02-02/g) || []).length, 1, "date is an option, not an extra attribute row");
  assert.ok(renderSVG(s, layout, { date: "1999-12-31" }).includes(">1999-12-31</text>"), "opts.date wins");
  const plain = parseSpec("nodes:\n  - {id: a}");
  assert.ok(renderSVG(plain, layout).includes(`>${new Date().toISOString().slice(0, 10)}</text>`), "today by default");
});

test("blueprint theme repaints the drawing; paper stays the default", async () => {
  const s = parseSpec("diagram: {theme: blueprint}\nnodes:\n  - {id: a, type: fw, tags: [x]}\n  - {id: b}\ngroups:\n  - {id: g, class: trust, nodes: [b]}\nconnections:\n  - {from: a, to: b, label: https}");
  const out = renderSVG(s, await elk.layout(buildElk(s)));
  assert.ok(out.includes('data-theme="blueprint"') && out.includes('fill="#1f4f8f"'), "blueprint ground");
  assert.ok(!out.includes("#fafbf7") && !out.includes('rx="6" fill="#ffffff"'), "no paper ground or white node boxes left");
  assert.ok(svg.includes('data-theme="paper"') && svg.includes('fill="#fafbf7"'), "example renders on paper");
  const forced = renderSVG(s, await elk.layout(buildElk(s)), { theme: "paper" });
  assert.ok(forced.includes('data-theme="paper"'), "opts.theme overrides diagram.theme");
});

test("tag filter: tagged groups keep their subtree; connections need both ends", () => {
  const doc = parseSpec(EXAMPLE).doc;
  assert.deepStrictEqual(nd.allTags(doc), ["ha", "pci", "prod"], "tags from nodes and groups");
  const view = nd.filterDoc(doc, ["PCI"]);
  assert.deepStrictEqual(view.nodes.map((n) => n.id).sort(), ["api1", "app1", "core", "db1"], "pci-tagged lan keeps all members");
  assert.deepStrictEqual(view.groups.map((g) => g.id), ["onprem"], "ancestors of a match survive");
  assert.ok(view.connections.every((l) => ["api1", "app1", "core", "db1", "lan"].includes(l.from)), "no dangling connections");
  assert.ok(view.connections.every((l) => doc.connections.includes(l)), "connections kept by reference");
  const ha = nd.filterDoc(doc, ["ha"]);
  assert.deepStrictEqual(ha.nodes.map((n) => n.id), ["fw1", "fw2"], "node tags match individually");
  nd.specFromDoc(view); nd.specFromDoc(ha);
  assert.strictEqual(nd.filterDoc(doc, []), doc, "no tags = the document itself");
});

const BASE = [
  "diagram: {title: v1}",
  "nodes:",
  "  - {id: fw, type: firewall}",
  "  - {id: web, type: vm, ip: 10.0.0.1}",
  "  - {id: old, type: vm}",
  "groups:",
  "  - {id: dmz, nodes: [web, old]}",
  "  - {id: legacy, nodes: []}",
  "connections:",
  "  - {from: fw, to: web, port: 443}",
  "  - {from: fw, to: old, port: 22}",
].join("\n");
const CUR = [
  "diagram: {title: v2}",
  "nodes:",
  "  - {id: fw, type: firewall}",
  "  - {id: web, type: vm, ip: 10.0.0.2}",
  "  - {id: api, type: container}",
  "groups:",
  "  - {id: dmz, nodes: [web, api]}",
  "connections:",
  "  - {from: fw, to: web, port: 8443}",
  "  - {from: web, to: api, port: 8080}",
].join("\n");

test("compare: added / removed / changed items on a merged document", async () => {
  const d = nd.diffDocs(parseSpec(BASE).doc, parseSpec(CUR).doc);
  assert.strictEqual(d.status.nodes.get("api"), "added");
  assert.strictEqual(d.status.nodes.get("old"), "removed");
  assert.strictEqual(d.status.nodes.get("web"), "changed", "ip changed");
  assert.strictEqual(d.status.nodes.get("fw"), undefined, "unchanged node has no status");
  assert.strictEqual(d.status.groups.get("legacy"), "removed");
  assert.strictEqual(d.status.connections.get(0), "changed", "port changed on fw->web");
  assert.strictEqual(d.status.connections.get(1), "added");
  assert.strictEqual(d.status.connections.get(2), "removed", "removed connection appended");
  assert.deepStrictEqual(d.counts, { added: 2, removed: 3, changed: 2 });
  const merged = nd.specFromDoc(d.doc);
  assert.strictEqual(merged.claimed.get("old"), "dmz", "removed node returns to its old group");
  assert.ok(merged.groupMap.has("legacy"), "removed group is drawn");
  const out = renderSVG(merged, await layoutOf(merged), { diff: { ...d, base: "v1.yaml" } });
  for (const s of ["added", "removed", "changed"]) assert.ok(out.includes(`data-change="${s}"`), s + " mark drawn");
  assert.ok(out.includes(">COMPARE</text>") && out.includes("+2 −3 ~2 vs v1.yaml"), "title block summarises");
  assert.ok(/class="edge" data-conn="2"[^>]*stroke-dasharray="6 4"[^>]*opacity="0.6"/.test(out), "removed edge dashed + faded");
  assert.strictEqual(parseSpec(CUR).doc.groups[0].nodes.length, 2, "diffDocs leaves its inputs untouched");
});

test("connection rules: same-zone skipped, both -> two rows, none dropped; CSV", () => {
  const s = parseSpec([
    "nodes:",
    "  - {id: a, label: aaa, ip: 10.0.0.1}",
    "  - {id: b, label: bbb, ip: 10.0.0.2}",
    "  - {id: c, label: ccc}",
    "  - {id: d, label: ddd}",
    "groups:",
    "  - {id: z, nodes: [c, d]}",
    "connections:",
    "  - {from: a, to: b, protocol: tcp, port: 22, direction: both, comment: 'mgmt \"ssh\"'}",
    "  - {from: b, to: z, protocol: udp, port: 514}",
    "  - {from: a, to: c, direction: none}",
    "  - {from: c, to: d}",
  ].join("\n"));
  const { rules, excluded, considered } = nd.connectionRules(s);
  assert.strictEqual(excluded, 1, "c->d share zone z");
  assert.strictEqual(considered, 3);
  assert.deepStrictEqual(rules.map((r) => `${r.src.name}>${r.dst.name}`), ["aaa>bbb", "bbb>aaa", "bbb>z"]);
  assert.strictEqual(rules[2].dst.addr, "—", "group without cidr has no address");
  const csv = nd.rulesToCsv(rules, new Map([[1, "added"]]));
  assert.ok(csv.startsWith('"#","Source","Source Address","Destination","Dest Address","Protocol","Port","Label","Comment","Change"'));
  assert.ok(csv.includes('"mgmt ""ssh"""'), "quotes doubled");
  assert.ok(csv.split("\n")[3].endsWith('"added"'), "change column filled per connection");
});

test("share links round-trip (deflate and plain)", async () => {
  const text = EXAMPLE + "\n# ünïcödé 🌐\n";
  const z = await nd.encodeShare(text), r = await nd.encodeShare(text, { compress: false });
  assert.ok(z.startsWith("z") && r.startsWith("r"), "payload kinds");
  assert.ok(/^[\w-]+$/.test(z) && /^[\w-]+$/.test(r), "URL-safe alphabet");
  assert.ok(z.length < r.length / 2, `deflate shrinks the link (${z.length} vs ${r.length})`);
  assert.strictEqual(await nd.decodeShare(z), text);
  assert.strictEqual(await nd.decodeShare(r), text);
  await assert.rejects(nd.decodeShare("qabc"), /Unrecognized/);
});

// ---------- importers ----------
const importers = require("../src/importers.js");
const validImport = (r) => { assert.ok(r, "format detected"); return parseSpec(r.yaml); };

test("import: Ansible INI inventory (ranges, children, tags, no secrets)", () => {
  const ini = [
    "bastion ansible_host=203.0.113.9",
    "[web]",
    "web[01:03].example.com ansible_host=10.0.1.10 ansible_password=hunter2",
    "[db]",
    "pg-01 ansible_host=db.internal",
    "[prod:children]",
    "web",
    "db",
    "[prod:vars]",
    "ansible_become_pass=hunter2",
    "[monitoring]",
    "web01.example.com",
  ].join("\n");
  const r = importers.detectImport(ini, "hosts.ini");
  const s = validImport(r);
  assert.strictEqual(r.kind, "ansible");
  assert.ok(!r.yaml.includes("hunter2"), "credentials never imported");
  assert.deepStrictEqual([...s.nodeMap.keys()], ["bastion", "web01.example.com", "web02.example.com", "web03.example.com", "pg-01"]);
  assert.strictEqual(s.claimed.get("web02.example.com"), "web", "deepest group is home");
  assert.deepStrictEqual(s.groupMap.get("prod").groups.map((g) => g.id), ["web", "db"], "children nest");
  assert.deepStrictEqual(s.nodeMap.get("web01.example.com").tags, ["monitoring"], "other groups become tags");
  assert.strictEqual(s.nodeMap.get("pg-01").type, "db", "name hints pick the type");
  assert.strictEqual(s.nodeMap.get("pg-01").host, "db.internal", "non-IP address kept as host");
  assert.strictEqual(s.nodeMap.get("bastion").ip, "203.0.113.9");
});

test("import: Ansible YAML inventory and ansible-inventory --list JSON", () => {
  const y = validImport(importers.detectImport([
    "all:",
    "  children:",
    "    edge:",
    "      hosts:",
    "        fw1: {ansible_host: 10.0.0.1}",
    "      children:",
    "        lbs:",
    "          hosts:",
    "            haproxy-1:",
  ].join("\n"), "inventory.yml"));
  assert.strictEqual(y.nodeMap.get("fw1").type, "firewall");
  assert.strictEqual(y.claimed.get("haproxy-1"), "lbs");
  const j = validImport(importers.detectImport(JSON.stringify({
    _meta: { hostvars: { k1: { ansible_host: "10.1.0.1" }, w1: { ansible_connection: "winrm" } } },
    all: { children: ["ungrouped", "k8s"] },
    k8s: { hosts: ["k1"] },
    ungrouped: { hosts: ["w1"] },
  })));
  assert.strictEqual(j.claimed.get("k1"), "k8s");
  assert.strictEqual(j.claimed.has("w1"), false, "ungrouped hosts stay top-level");
  assert.strictEqual(j.nodeMap.get("w1").os, "windows");
});

test("import: Terraform show -json and .tfstate", () => {
  const show = { format_version: "1.0", values: { root_module: {
    resources: [
      { address: "aws_vpc.main", mode: "managed", type: "aws_vpc", name: "main", values: { id: "vpc-1", cidr_block: "10.0.0.0/16", tags: { Name: "main" } } },
      { address: "aws_subnet.a", mode: "managed", type: "aws_subnet", name: "a", values: { id: "sub-1", vpc_id: "vpc-1", cidr_block: "10.0.1.0/24" } },
      { address: "aws_instance.web[0]", mode: "managed", type: "aws_instance", name: "web", values: { subnet_id: "sub-1", private_ip: "10.0.1.10", tags: { Name: "web-0" } } },
      { address: "data.aws_ami.x", mode: "data", type: "aws_ami", name: "x", values: {} },
    ],
    child_modules: [{ resources: [
      { address: "module.db.aws_db_instance.pg", mode: "managed", type: "aws_db_instance", name: "pg", values: { address: "pg.rds.example" } },
    ] }],
  } } };
  const s = validImport(importers.detectImport(JSON.stringify(show), "show.json"));
  assert.deepStrictEqual(s.groupMap.get("aws_vpc.main").groups.map((g) => g.id), ["aws_subnet.a"], "subnet nests in its vpc");
  assert.strictEqual(s.groupMap.get("aws_subnet.a").cidr, "10.0.1.0/24");
  assert.strictEqual(s.claimed.get("aws_instance.web-0"), "aws_subnet.a", "instance lands in its subnet");
  assert.strictEqual(s.nodeMap.get("aws_instance.web-0").label, "web-0");
  assert.strictEqual(s.nodeMap.get("aws_db_instance.pg").type, "db", "child modules are walked");
  const state = { version: 4, terraform_version: "1.9.0", resources: [
    { mode: "managed", type: "google_compute_network", name: "n", instances: [{ attributes: { name: "n", self_link: "https://x/global/networks/n" } }] },
    { mode: "managed", type: "google_compute_subnetwork", name: "s", instances: [{ attributes: { name: "s", network: "https://x/global/networks/n", ip_cidr_range: "10.2.0.0/20" } }] },
    { mode: "managed", type: "google_compute_instance", name: "vm", instances: [{ index_key: 0, attributes: { name: "vm-0", network_interface: [{ subnetwork: "https://x/regions/r/subnetworks/s", network_ip: "10.2.0.5" }] } }] },
  ] };
  const t = validImport(importers.detectImport(JSON.stringify(state), "terraform.tfstate"));
  assert.strictEqual(t.nodeMap.get("google_compute_instance.vm-0").ip, "10.2.0.5");
  assert.strictEqual(t.claimed.get("google_compute_instance.vm-0"), "google_compute_subnetwork.s");
});

test("import: NetBox devices + virtual machines", () => {
  const s = validImport(importers.detectImport(JSON.stringify({ results: [
    { name: "core-sw1", device_type: { model: "C9300" }, role: { name: "Core Switch" }, site: { name: "HQ" }, rack: { name: "R1" }, primary_ip4: { address: "10.0.0.2/24" }, tags: [{ slug: "prod" }], platform: { name: "IOS-XE" } },
    { name: "db01", device_type: { model: "R740" }, role: { name: "Server" }, site: { name: "HQ" } },
    { name: "app-vm", vcpus: 4, cluster: { name: "pve" }, site: { name: "HQ" }, primary_ip: { address: "10.0.5.5/24" } },
  ] }), "devices.json"));
  assert.strictEqual(s.nodeMap.get("core-sw1").type, "switch", "role picks the type");
  assert.strictEqual(s.nodeMap.get("core-sw1").ip, "10.0.0.2", "prefix length stripped");
  assert.strictEqual(s.nodeMap.get("db01").type, "server");
  assert.strictEqual(s.nodeMap.get("db01").icon, "db", "name hint becomes the icon of a physical server");
  assert.strictEqual(s.nodeMap.get("app-vm").type, "vm");
  assert.strictEqual(s.claimed.get("core-sw1"), "R1");
  assert.strictEqual(s.claimed.get("app-vm"), "pve");
  assert.deepStrictEqual(s.groupMap.get("HQ").groups.map((g) => g.label), ["R1", "pve"], "racks and clusters nest in the site");
});

test("import: netdiagram YAML and unknown text are not converted", () => {
  assert.strictEqual(importers.detectImport(EXAMPLE, "hq.yaml"), null);
  assert.strictEqual(importers.detectImport("just some words", "notes.txt"), null);
  assert.throws(() => importers.importAs("netbox", "{}"), /NetBox import expects/);
});

// ---------- CLI ----------
test("render CLI: --date --tags --compare --csv --theme and --extract", () => {
  const { execFileSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netdiagram-test-"));
  try {
    const run = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/render.js"), ...args], { encoding: "utf8" });
    fs.writeFileSync(path.join(dir, "base.yaml"), BASE);
    fs.writeFileSync(path.join(dir, "cur.yaml"), CUR);
    const out = path.join(dir, "cur.svg"), csv = path.join(dir, "rules.csv");
    const log = run(path.join(dir, "cur.yaml"), out, "--date", "2001-01-01", "--compare", path.join(dir, "base.yaml"), "--csv", csv, "--theme=blueprint");
    assert.ok(log.includes("+2 −3 ~2 vs base.yaml"), "summary printed: " + log);
    const drawn = fs.readFileSync(out, "utf8");
    assert.ok(drawn.includes(">2001-01-01</text>") && drawn.includes('data-theme="blueprint"'));
    assert.ok(fs.readFileSync(csv, "utf8").split("\n")[0].endsWith('"Change"'), "csv written with change column");
    assert.strictEqual(run(out, "--extract"), CUR, "--extract prints the embedded source");
    assert.ok(run(path.join(root, "examples/hq-edge-core.yaml"), path.join(dir, "ha.svg"), "--tags", "ha").includes("— 2 nodes"),
      "--tags narrows the drawing");
    assert.throws(() => execFileSync(process.execPath, [path.join(root, "scripts/render.js"), path.join(dir, "cur.yaml"),
      path.join(dir, "none.svg"), "--tags", "nope"], { stdio: "pipe" }),
    (e) => String(e.stderr).includes("nothing is tagged"), "a filter matching nothing fails loudly");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- views ----------
const VIEWS = `
diagram:
  title: Whole thing
nodes:
  - {id: inet, type: internet}
  - {id: fw, type: firewall}
  - {id: web, type: server, tags: [prod]}
  - {id: db, type: db}
  - {id: far}
groups:
  - {id: dmz, class: zone, nodes: [web]}
  - {id: lan, class: trust, nodes: [db]}
connections:
  - {from: inet, to: fw}
  - {from: fw, to: web}
  - {from: web, to: db}
  - {from: db, to: far}
views:
  - {id: edge, title: Edge, focus: fw, depth: 1}
  - {id: prod, tags: [prod]}
  - {id: deep, focus: fw, depth: 2, direction: right}
`;
const viewDoc = (id) => {
  const spec = parseSpec(VIEWS);
  return nd.applyView(spec.doc, nd.viewById(spec.doc, id), spec);
};
const nodeIds = (d) => nd.flatNodes(d).map((n) => String(n.id)).sort();

test("views: focus keeps the target, its contents and `depth` connection hops", () => {
  assert.deepStrictEqual(nodeIds(viewDoc("edge")), ["fw", "inet", "web"]);
  assert.deepStrictEqual(nodeIds(viewDoc("deep")), ["db", "fw", "inet", "web"]);
  // a surviving node keeps the group that draws it, and nothing else
  assert.deepStrictEqual((viewDoc("edge").groups || []).map((g) => g.id), ["dmz"]);
  // connections survive only when both ends do
  assert.strictEqual((viewDoc("edge").connections || []).length, 2);
});

test("views: tags narrow like the tag filter; options fold into diagram", () => {
  assert.deepStrictEqual(nodeIds(viewDoc("prod")), ["web"]);
  assert.strictEqual(viewDoc("edge").diagram.title, "Edge");
  assert.strictEqual(viewDoc("deep").diagram.direction, "right");
  assert.strictEqual(viewDoc("deep").diagram.title, "Whole thing", "options the view does not set are inherited");
});

test("views: a narrowed document never carries views onward", () => {
  const spec = parseSpec(VIEWS);
  for (const id of ["edge", "prod", "deep"]) {
    const d = nd.applyView(spec.doc, nd.viewById(spec.doc, id), spec);
    assert.strictEqual(d.views, undefined, `${id} strips views`);
    // must still validate: another view's focus may have just been pruned away
    nd.specFromDoc(d);
  }
  assert.strictEqual(nd.viewsOf(spec.doc).length, 3, "the source document is untouched");
  assert.strictEqual(nd.flatNodes(spec.doc).length, 5);
  assert.strictEqual(nd.filterDoc(spec.doc, ["prod"]).views, undefined, "the tag filter strips them too");
});

test("validation: views need a known focus, unique ids and a numeric depth", () => {
  expectError("nodes:\n  - {id: a}\nviews:\n  - {id: v, focus: ghost}\n", 'unknown focus "ghost"');
  expectError("nodes:\n  - {id: a}\nviews:\n  - {id: v}\n  - {id: v}\n", 'duplicate view id "v"');
  expectError("nodes:\n  - {id: a}\nviews:\n  - {id: v, depth: soon}\n", "depth must be a number");
  expectError("nodes:\n  - {id: a}\nviews:\n  - {title: no id}\n", "views[0]: missing id");
});

test("views CLI: --list-views, --view, and an unknown view", () => {
  const { execFileSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netdiagram-views-"));
  const script = path.join(root, "scripts/render.js");
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
    }
  };
  try {
    const spec = path.join(dir, "net.yaml");
    fs.writeFileSync(spec, VIEWS);
    const list = run(spec, "--list-views");
    assert.strictEqual(list.code, 0);
    assert.ok(/edge\s+Edge/.test(list.out), list.out);

    const out = path.join(dir, "edge.svg");
    const r = run(spec, out, "--view", "edge", "--date", "2000-01-01");
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.out.includes("view edge"), r.out);
    const svg = fs.readFileSync(out, "utf8");
    assert.ok(svg.includes(">Edge</title>"), "the view title reaches the title block");
    assert.ok(svg.includes('data-id="fw"'), "the focus is drawn");
    assert.ok(!svg.includes('data-id="far"'), "what is out of range is not");

    const bad = run(spec, path.join(dir, "x.svg"), "--view", "nope");
    assert.strictEqual(bad.code, 1);
    assert.ok(bad.out.includes('unknown view "nope"'), bad.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- architecture lint + drift ----------
const lintOf = (yaml) => nd.lintSpec(parseSpec(yaml));
const rulesFired = (yaml) => lintOf(yaml).map((f) => f.rule).sort();

test("lint: every bundled example is clean", () => {
  for (const f of fs.readdirSync(path.join(root, "examples")).filter((x) => x.endsWith(".yaml"))) {
    const found = lintOf(fs.readFileSync(path.join(root, "examples", f), "utf8"));
    assert.deepStrictEqual(found, [], `${f}: ${found.map((x) => x.rule + " " + x.message).join("; ")}`);
  }
});

test("lint: an address in no declared subnet is an error, dual-homing is not", () => {
  const base = (ips) => `
nodes:
  - {id: a, ip: 10.0.10.5}
  - {id: b, ips: [${ips}]}
groups:
  - {id: dmz, cidr: 10.0.10.0/24, nodes: [a]}
  - {id: lan, cidr: 10.0.20.0/24, nodes: [b]}
connections:
  - {from: a, to: b}
`;
  // a second NIC on another DECLARED subnet is legitimate
  assert.deepStrictEqual(rulesFired(base("10.0.20.5, 10.0.10.9")), []);
  // an address in no declared subnet at all is a typo
  const bad = lintOf(base("10.0.20.5, 10.0.99.9"));
  assert.deepStrictEqual(bad.map((f) => f.rule), ["ip-outside-cidr"]);
  assert.strictEqual(bad[0].severity, "error");
  assert.ok(bad[0].message.includes("10.0.99.9"), bad[0].message);
  assert.deepStrictEqual(bad[0].path, ["nodes", 1]);
});

test("lint: duplicate addresses and overlapping subnets are errors", () => {
  assert.ok(rulesFired(`
nodes:
  - {id: a, ip: 10.0.10.5}
  - {id: b, ip: 10.0.10.5}
groups:
  - {id: g, cidr: 10.0.10.0/24, nodes: [a, b]}
connections:
  - {from: a, to: b}
`).includes("duplicate-ip"));
  assert.ok(rulesFired(`
nodes:
  - {id: a, ip: 10.0.10.5}
  - {id: b, ip: 10.0.10.9}
groups:
  - {id: g1, cidr: 10.0.0.0/16, nodes: [a]}
  - {id: g2, cidr: 10.0.10.0/24, nodes: [b]}
connections:
  - {from: a, to: b}
`).includes("cidr-overlap"), "unrelated groups that overlap are flagged");
  // a subnet nested inside its supernet is the normal case, not an overlap
  assert.deepStrictEqual(rulesFired(`
nodes:
  - {id: a, ip: 10.0.10.5}
groups:
  - id: outer
    cidr: 10.0.0.0/16
    groups:
      - {id: inner, cidr: 10.0.10.0/24, nodes: [a]}
connections:
  - {from: a, to: outer}
`), []);
});

test("lint: a pair both blocked and allowed contradicts itself", () => {
  const f = lintOf(`
nodes:
  - {id: a}
  - {id: b}
connections:
  - {from: a, to: b, protocol: tcp, port: 443}
  - {from: b, to: a, direction: none}
`);
  assert.deepStrictEqual(f.map((x) => x.rule), ["blocked-contradiction"]);
  assert.strictEqual(f[0].severity, "error");
});

test("lint: silent degradation is warned about, not hidden", () => {
  const f = lintOf(`
nodes:
  - {id: a, type: sw1tch}
  - {id: b, type: switch}
groups:
  - {id: g, class: zoen, nodes: [a, b]}
connections:
  - {from: a, to: b}
`);
  assert.deepStrictEqual(f.map((x) => x.rule).sort(), ["unknown-class", "unknown-type"]);
  assert.ok(f.every((x) => x.severity === "warning"));
});

test("lint: an unconnected node is warned about; a guest and a grouped node are not", () => {
  const f = lintOf(`
nodes:
  - {id: a}
  - {id: lonely}
  - id: host
    nodes:
      - {id: guest}
  - {id: member}
groups:
  - {id: g, nodes: [member]}
connections:
  - {from: a, to: g}
  - {from: a, to: host}
`);
  assert.deepStrictEqual(f.map((x) => x.rule), ["isolated"]);
  assert.ok(f[0].message.includes("lonely"), f[0].message);
});

test("drift: reports what the inventory has, the diagram has, and readdressing", () => {
  const live = {
    nodes: [
      { id: "web-01", label: "web-01", ip: "10.0.10.11" },
      { id: "web-02", label: "web-02", ip: "10.0.10.12" },
    ],
  };
  const authored = {
    nodes: [
      { id: "w1", label: "web-01", ip: "10.0.10.99" }, // matched by label, readdressed
      { id: "old", label: "decommissioned", ip: "10.0.10.50" },
    ],
  };
  const d = nd.driftReport(live, authored);
  const by = (r) => d.filter((x) => x.rule === r).map((x) => x.id);
  assert.deepStrictEqual(by("missing"), ["web-02"], "in the inventory, not in the diagram");
  assert.deepStrictEqual(by("extra"), ["old"], "in the diagram, not in the inventory");
  assert.deepStrictEqual(by("address"), ["w1"], "matched by label but readdressed");
  assert.deepStrictEqual(nd.driftReport(live, live), [], "a document does not drift from itself");
});

test("check CLI: exit codes, --strict, --json and --against", () => {
  const { execFileSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netdiagram-check-"));
  const script = path.join(root, "scripts/check.js");
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
    }
  };
  try {
    const clean = path.join(root, "examples/hq-edge-core.yaml");
    assert.strictEqual(run(clean).code, 0, "a clean spec exits 0");
    assert.ok(run(clean).out.includes("clean"));

    const warn = path.join(dir, "warn.yaml");
    fs.writeFileSync(warn, "nodes:\n  - {id: a, type: nonsense}\n  - {id: b}\nconnections:\n  - {from: a, to: b}\n");
    assert.strictEqual(run(warn).code, 0, "warnings alone do not fail");
    assert.strictEqual(run(warn, "--strict").code, 1, "--strict makes warnings fail");

    const bad = path.join(dir, "bad.yaml");
    fs.writeFileSync(bad, "nodes:\n  - {id: a, ip: 10.9.9.9}\n  - {id: b}\ngroups:\n  - {id: g, cidr: 10.0.0.0/24, nodes: [a]}\nconnections:\n  - {from: a, to: b}\n");
    const r = run(bad);
    assert.strictEqual(r.code, 1, "an error exits 1");
    assert.ok(r.out.includes("ip-outside-cidr"), r.out);
    const parsed = JSON.parse(run(bad, "--json").out);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.findings[0].rule, "ip-outside-cidr");

    // drift: an Ansible inventory that has a host the diagram doesn't
    const inv = path.join(dir, "hosts.ini");
    fs.writeFileSync(inv, "[web]\nweb-01 ansible_host=10.0.10.11\nweb-99 ansible_host=10.0.10.99\n");
    const spec = path.join(dir, "net.yaml");
    fs.writeFileSync(spec, "nodes:\n  - {id: web-01, label: web-01, ip: 10.0.10.11}\n  - {id: b}\nconnections:\n  - {from: web-01, to: b}\n");
    const dr = run(spec, "--against", inv);
    assert.strictEqual(dr.code, 1, "drift fails the check");
    assert.ok(dr.out.includes("web-99"), dr.out);
    assert.strictEqual(run(spec, "--against", inv, "--json").code, 1);

    assert.strictEqual(run(clean, "--nope").code, 2, "bad usage exits 2");
    assert.strictEqual(run(path.join(dir, "missing.yaml")).code, 2, "unreadable input exits 2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- node containment ----------
const CONTAIN = `
nodes:
  - id: host1
    label: esx-01
    type: hypervisor
    ip: 10.40.0.11
    os: esxi
    nodes:
      - {id: vm1, label: web-01, type: vm, ip: 10.40.10.11}
      - {id: vm2, label: web-02, type: vm, ip: 10.40.10.12, tags: [prod]}
  - {id: sw, label: core-sw, type: switch}
groups:
  - {id: dc, label: DC, class: onprem, nodes: [host1, sw]}
connections:
  - {from: sw, to: vm1, label: "tcp/443 https", protocol: tcp, port: 443}
`;
const absBoxes = (layout) => {
  const abs = new Map();
  (function walk(n, ox, oy) {
    (n.children || []).forEach((c) => {
      const x = ox + (c.x || 0), y = oy + (c.y || 0);
      abs.set(c.id, { x, y, w: c.width || 0, h: c.height || 0 });
      walk(c, x, y);
    });
  })(layout, 0, 0);
  return abs;
};

test("containment: children lay out inside their host and render with data-id", async () => {
  const s = parseSpec(CONTAIN);
  assert.ok(s.nodeMap.has("vm1"), "a nested node is registered in the flat id namespace");
  assert.strictEqual(s.hosted.get("vm1"), "host1");
  const layout = await layoutOf(s);
  const abs = absBoxes(layout);
  const host = abs.get("host1");
  for (const id of ["vm1", "vm2"]) {
    const b = abs.get(id);
    assert.ok(b, `${id} is laid out`);
    assert.ok(b.x >= host.x && b.y >= host.y &&
      b.x + b.w <= host.x + host.w && b.y + b.h <= host.y + host.h,
      `${id} sits inside host1's box`);
    assert.ok(b.y >= host.y + 40, `${id} clears the host's own chrome`);
  }
  const svg = renderSVG(s, layout, {});
  assert.ok(svg.includes('data-id="vm1"'), "nested nodes are clickable");
  assert.ok(svg.includes('data-id="host1"'));
});

/* a host whose own chrome is wider than its single small child: ELK would size
 * the box from the child alone, so the pass-2 widening has to kick in */
const WIDE_LEAF = `
nodes:
  - id: hv
    label: hypervisor-esx-01.dc1.example.com
    type: hypervisor
    ip: 10.40.0.11
`;
const WIDE_HOST = WIDE_LEAF + `    nodes:
      - {id: g1, label: vm, type: vm}
`;
test("containment: a host is widened so its own chrome still fits", async () => {
  const leaf = buildElk(parseSpec(WIDE_LEAF)).children[0].width;
  const host = absBoxes(await layoutOf(parseSpec(WIDE_HOST))).get("hv");
  assert.ok(host.w >= leaf,
    `container ${host.w} should be at least the ${leaf} the same node needs as a leaf`);
});

test("validation: a hosted node cannot also be a group member", () =>
  expectError("nodes:\n  - id: h\n    nodes:\n      - {id: v}\ngroups:\n  - {id: g, nodes: [v]}\n",
    'is inside "h"'));

test("validation: duplicate ids are caught across nesting levels", () =>
  expectError("nodes:\n  - {id: a}\n  - id: b\n    nodes:\n      - {id: a}\n",
    'duplicate node id "a"'));

test("containment: guests on one host share its zone; a guest inherits the host's group", () => {
  const s = parseSpec(`
nodes:
  - id: h1
    type: hypervisor
    nodes:
      - {id: v1, type: vm}
      - {id: v2, type: vm}
  - {id: ext, type: internet}
connections:
  - {from: v1, to: v2, protocol: tcp, port: 22}
  - {from: ext, to: v1, protocol: tcp, port: 443}
`);
  const { rules, excluded } = nd.connectionRules(s);
  assert.strictEqual(excluded, 1, "same-host pair needs no rule");
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(rules[0].dst.name, "v1");
});

test("containment: filtering by a child's tag keeps its host as a shell", () => {
  const out = nd.filterDoc(parseSpec(CONTAIN).doc, ["prod"]);
  const host = out.nodes.find((n) => n.id === "host1");
  assert.ok(host, "the host survives because a child matched");
  assert.deepStrictEqual(host.nodes.map((n) => n.id), ["vm2"]);
  assert.ok(!out.nodes.some((n) => n.id === "sw"), "an untagged sibling is dropped");
});

test("containment: moving a guest between hosts marks the guest, not the hosts", () => {
  const a = parseSpec("nodes:\n  - {id: h1, type: hypervisor, nodes: [{id: v, type: vm}]}\n  - {id: h2, type: hypervisor, nodes: [{id: x, type: vm}]}\n").doc;
  const b = parseSpec("nodes:\n  - {id: h1, type: hypervisor, nodes: [{id: x, type: vm}]}\n  - {id: h2, type: hypervisor, nodes: [{id: v, type: vm}]}\n").doc;
  const d = nd.diffDocs(a, b);
  assert.strictEqual(d.status.nodes.get("v"), "changed");
  assert.strictEqual(d.status.nodes.get("x"), "changed");
  assert.ok(!d.status.nodes.get("h1"), "the host itself did not change");
});

test("containment: sourceMap locates a nested node; the cursor picks the innermost", () => {
  const text = "nodes:\n  - id: h\n    nodes:\n      - {id: v}\n";
  const m = nd.sourceMap(text);
  assert.ok(slice(text, m.itemRange("node", "v")).includes("id: v"));
  assert.deepStrictEqual(m.itemAt(text.indexOf("id: v") + 2), { kind: "node", id: "v" });
});

// ---------- golden SVGs ----------
/* Every example rendered with a fixed date, byte-compared against
 * test/golden/. After an intended rendering change: npm run test:golden,
 * then review the SVG diffs. The version stamp is normalized so releases
 * don't churn the files. */
const UPDATE_GOLDEN = process.argv.includes("--update-golden");
const goldenDir = path.join(root, "test/golden");
const normalizeVersion = (s) => s.replace(/netdiagram v[\w.-]+<\/text>/, "netdiagram vX</text>");
const goldens = [
  ...fs.readdirSync(path.join(root, "examples")).filter((f) => f.endsWith(".yaml")).map((f) => [f, {}]),
  ["hq-edge-core.yaml", { theme: "blueprint" }],
];
for (const [file, extra] of goldens) {
  const name = file.replace(/\.yaml$/, "") + (extra.theme ? "." + extra.theme : "") + ".svg";
  test(`golden: ${name}`, async () => {
    const text = fs.readFileSync(path.join(root, "examples", file), "utf8");
    const s = parseSpec(text);
    const out = normalizeVersion(renderSVG(s, await layoutOf(s), { date: "2000-01-01", source: text, ...extra })) + "\n";
    const target = path.join(goldenDir, name);
    if (UPDATE_GOLDEN) { fs.mkdirSync(goldenDir, { recursive: true }); fs.writeFileSync(target, out); return; }
    assert.ok(fs.existsSync(target), `missing ${path.relative(root, target)} — run npm run test:golden`);
    const want = fs.readFileSync(target, "utf8");
    if (out !== want) {
      const at = [...out].findIndex((c, i) => c !== want[i]);
      assert.fail(`${name} differs from the golden file near offset ${at}: ` +
        `got ${JSON.stringify(out.slice(Math.max(0, at - 40), at + 40))} ` +
        `want ${JSON.stringify(want.slice(Math.max(0, at - 40), at + 40))} — if intended, npm run test:golden`);
    }
  });
}

// ---------- dist: new app features (jsdom) ----------
async function bootPage({ draft, projects, url = "https://netdiagram.test/" } = {}) {
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(root, "dist/netdiagram.html"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url,
    beforeParse(w) {
      try {
        if (draft) w.localStorage.setItem("netdiagram:v1:draft", draft);
        if (projects) w.localStorage.setItem("netdiagram:v1:projects", JSON.stringify(projects));
      } catch (e) {}
    },
  });
  const win = dom.window, doc = win.document, statusEl = doc.querySelector("#status");
  const errs = [];
  win.addEventListener("error", (e) => errs.push(e.message));
  await waitFor(() => errs.length || /^OK/.test(statusEl.textContent) || statusEl.classList.contains("error"));
  assert.deepStrictEqual(errs, [], "no page errors");
  return { win, doc, statusEl, errs };
}
async function waitFor(pred, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

test("app: clicking the diagram reveals YAML; the selection glows and clears on empty paper", async () => {
  const { win, doc } = await bootPage();
  const node = doc.querySelector('#canvas-pane .nd-node[data-id="db1"]');
  assert.ok(node, "example node drawn");
  click(win, node.querySelector("rect"));
  assert.ok(await waitFor(() => node.classList.contains("nd-sel")), "revealed node is outlined via the cursor");
  const edge = doc.querySelector('#canvas-pane .edge[data-conn="4"]');
  click(win, edge);
  assert.ok(await waitFor(() => edge.classList.contains("nd-sel") && !node.classList.contains("nd-sel")),
    "clicking an edge moves the selection to that connection");
  assert.ok(edge.classList.contains("nd-pulse"), "a new selection pulses");
  assert.ok(doc.querySelector('#canvas-pane .edge-lbl[data-conn="4"]').classList.contains("nd-sel"),
    "the edge label glows with its edge");
  click(win, doc.querySelector("#canvas-pane svg > rect"));
  assert.strictEqual(doc.querySelectorAll("#canvas-pane .nd-sel").length, 0, "a click on empty paper clears the selection");
  click(win, node.querySelector("rect"));
  assert.ok(await waitFor(() => node.classList.contains("nd-sel")), "an item can be selected again after clearing");
  click(win, node.querySelector("rect"));
  assert.ok(!node.classList.contains("nd-sel"), "clicking the selected item again clears it");
});

test("app: tag chips narrow the diagram", async () => {
  const { win, doc, statusEl } = await bootPage();
  assert.ok(!doc.querySelector("#tag-filter").hidden, "tag bar shown for a tagged document");
  const chip = [...doc.querySelectorAll(".tag-chip")].find((c) => c.dataset.tag === "ha");
  click(win, chip);
  assert.ok(await waitFor(() => statusEl.textContent.includes("showing")), "status reports the filter: " + statusEl.textContent);
  const ids = [...doc.querySelectorAll("#canvas-pane .nd-node")].map((n) => n.dataset.id).sort();
  assert.deepStrictEqual(ids, ["fw1", "fw2"]);
  assert.ok(doc.querySelector("#canvas-pane svg").outerHTML.includes(">FILTER</text>"), "title block notes the filter");
  assert.strictEqual(doc.querySelector('.tag-chip[data-tag="ha"]').getAttribute("aria-pressed"), "true");
});

test("app: the View picker appears only with views, and narrows the diagram", async () => {
  const plain = await bootPage({ draft: "nodes:\n  - {id: a}\n" });
  assert.ok(plain.doc.querySelector("#view-picker").hidden, "hidden for a document without views");

  const { win, doc, statusEl } = await bootPage({ draft: VIEWS });
  assert.ok(!doc.querySelector("#view-picker").hidden, "shown for a document with views");
  const sel = doc.querySelector("#sel-view");
  assert.deepStrictEqual([...sel.options].map((o) => o.value), ["", "edge", "prod", "deep"],
    "the whole diagram plus every declared view");
  assert.deepStrictEqual([...sel.options].map((o) => o.textContent),
    ["Whole diagram", "Edge", "prod", "deep"], "titles label the views, ids stand in without one");

  sel.value = "edge";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.ok(await waitFor(() => statusEl.textContent.includes('view "edge"')),
    "status reports the view: " + statusEl.textContent);
  const ids = [...doc.querySelectorAll("#canvas-pane .nd-node")].map((n) => n.dataset.id).sort();
  assert.deepStrictEqual(ids, ["fw", "inet", "web"], "only the focus and one hop are drawn");
  assert.ok(doc.querySelector("#canvas-pane svg").outerHTML.includes(">VIEW</text>"),
    "the title block records which view is drawn");

  sel.value = "";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.ok(await waitFor(() => doc.querySelectorAll("#canvas-pane .nd-node").length === 5),
    "switching back to the whole diagram restores every node");
});

test("app: a #src= share link opens on load and clears the fragment", async () => {
  const shared = "diagram: {title: Shared}\nnodes:\n  - {id: s1, label: from-link}\n";
  const { win, doc, statusEl } = await bootPage({ url: "https://netdiagram.test/#src=" + await nd.encodeShare(shared, { compress: false }) });
  assert.ok(/^OK — 1 nodes/.test(statusEl.textContent), "shared doc rendered: " + statusEl.textContent);
  assert.ok(doc.querySelector("#canvas-pane svg").outerHTML.includes("from-link"));
  assert.strictEqual(win.location.hash, "", "fragment cleared so a reload keeps later edits");
});

test("app: compare with a saved project marks changes in diagram and table", async () => {
  const { win, doc, statusEl } = await bootPage({ draft: CUR, projects: { base: { yaml: BASE, updated: 1 } } });
  const sel = doc.querySelector("#sel-compare");
  assert.ok([...sel.options].some((o) => o.value === "p:base"), "saved project offered as baseline");
  sel.value = "p:base";
  sel.dispatchEvent(new win.Event("change", { bubbles: true }));
  assert.ok(await waitFor(() => statusEl.textContent.includes("vs base")), "status: " + statusEl.textContent);
  const out = doc.querySelector("#canvas-pane svg").outerHTML;
  assert.ok(out.includes('data-change="added"') && out.includes('data-change="removed"'), "changes marked");
  // web->api (added) stays inside dmz, so it is no rule; fw->web changed its port, fw->old is gone
  assert.ok(doc.querySelector("#connections-pane tr.chg-changed"), "rule table marks changed rules");
  assert.ok(doc.querySelector("#connections-pane tr.chg-removed"), "rule table keeps removed rules, marked");
  assert.ok(doc.querySelector("#connections-pane th").textContent === "", "change marker column added");
});

test("app: importing an exported SVG reopens its source; inventories convert", async () => {
  const { win, doc, statusEl } = await bootPage();
  const text = "diagram: {title: Round trip}\nnodes:\n  - {id: rt, label: round-trip}\n";
  const s = parseSpec(text);
  win.importText(renderSVG(s, await elk.layout(buildElk(s)), { source: text }), "rt.svg");
  assert.ok(await waitFor(() => doc.querySelector("#canvas-pane svg")?.outerHTML.includes("round-trip")), "svg source reopened");
  win.importText("[web]\nweb1 ansible_host=10.0.0.1\nweb2 ansible_host=10.0.0.2\n", "hosts.ini");
  assert.ok(await waitFor(() => statusEl.textContent.includes("imported Ansible inventory")), "status: " + statusEl.textContent);
  assert.ok(/^OK — 2 nodes · 1 groups/.test(statusEl.textContent));
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
