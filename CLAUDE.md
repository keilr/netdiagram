# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**netdiagram** turns a YAML description of a network (nodes, groups/zones, connections)
into a blueprint-style SVG schematic. The deliverable is `dist/netdiagram.html` —
a single, fully self-contained HTML file (editor + live renderer + vendored
libraries) that works offline with no CDN and no server.

## Commands

```bash
npm install        # deps: elkjs, js-yaml; dev: esbuild, jsdom, eslint, codemirror
npm run build      # -> dist/netdiagram.html (~2.7 MB, self-contained)
npm run watch      # rebuild dist on changes to src/, examples/, the schema
npm run lint       # eslint (flat config; also runs first in CI)
npm test           # builds, then runs test/test.js (pipeline, features, validation,
                   # importers, CLI, golden SVGs, jsdom boot of the app)
npm run test:golden  # rebuild + rewrite test/golden/*.svg — ONLY after an intended
                   # visual change; review the SVG diff before committing
npm run render -- in.yaml [out.svg] [--theme --tags --compare --csv --date --extract]
npm run import -- <file|-> [--from ansible|terraform|netbox] [-o out.yaml]
npm run check -- net.yaml [--against inv|-] [--from ...] [--strict] [--json]
                   # CI gate: architecture lint (+ drift vs a live inventory);
                   # exits 1 on findings, 2 on bad usage. All bundled examples
                   # must stay clean — test/test.js asserts it.
```

There is no dev server; after `npm run build`, open `dist/netdiagram.html` in a browser.

## Architecture

```
src/netdiagram.js   Core library (browser + node). Pure pipeline:
                    parseSpec(yamlText) = specFromDoc(jsyaml.load(text))
                      -> {doc, nodeMap, groupMap, claimed}; validation errors
                      carry e.errors = [{path, message}] (path into the doc)
                    buildElk(spec)      -> ELK graph JSON (layout is caller's job)
                    assignPorts(graph, pass1) -> graph|null — two-pass layout:
                      pins FIXED_ORDER ports on leaf nodes with 2+ edges so hub
                      edges leave toward their targets (kills most crossings).
                      Pass a FRESH buildElk graph; null = no hubs, skip pass 2.
                    renderSVG(spec, layout, opts) -> SVG string; opts: theme,
                      date, source (YAML embedded in <metadata>), diff, rows
                    Views on a doc (both keep connection objects BY REFERENCE):
                      filterDoc(doc, tags), allTags(doc), diffDocs(base, cur)
                      -> {doc (merged), status, counts}
                    sourceMap(text) -> {rangeOf(path), itemRange(kind, key),
                      itemAt(pos)} — YAML offsets from js-yaml parseEvents
                    connectionRules(spec) / rulesToCsv — the firewall-rule table
                    extractSource(svgText), encodeShare/decodeShare (#src= links)
                    Also: CONNECTION_STYLES, GROUP_STYLES, GLYPHS, LABEL_PALETTE, THEMES.
src/importers.js    Ansible (INI / YAML / --list JSON), Terraform (show -json /
                    tfstate) and NetBox JSON -> netdiagram doc + YAML.
                    detectImport(text, filename) | importAs(kind, text).
                    Dual shape like the core; publishes window.Importers.
src/app.js          Browser-only wire-up: CodeMirror editor, debounced render
                    (validate source -> tag filter -> compare -> layout), SVG /
                    YAML download, PDF export (prints via a hidden iframe — the
                    browser's print-to-PDF keeps it vector), Import (YAML, SVG
                    with embedded source, inventories; also drag & drop), share
                    links, compare picker, tag chips, diagram <-> YAML navigation
                    (data-id / data-conn attributes + sourceMap), example picker
                    (below the editor), and local project persistence (autosaves
                    the editor buffer as a draft and stores named projects in
                    localStorage under netdiagram:v1:* keys; every storage
                    access is guarded, so an opaque/unavailable origin hides the
                    project UI and degrades to no-op). Expects globals ELK,
                    jsyaml, EXAMPLES, SCHEMA, makeEditor, Importers.
src/editor.js       CodeMirror 6 setup (bundled separately by esbuild):
                    YAML mode + json-schema lint/hover/key-completion, plus
                    valueCompletion() — value hints the library doesn't do:
                    enums/examples read from the JSON schema, document ids
                    for connection endpoints and group member lists.
                    makeEditor(parent, schema, onChange, {lint, onCursor}) ->
                    {value, setValue, reveal(from, to)}.
src/template.html   Page shell + CSS with <!--INJECT:JSYAML-->, <!--INJECT:ELK-->,
                    <!--INJECT:EDITOR-->, <!--INJECT:APP--> placeholders.
scripts/build.js    Vendors js-yaml + elkjs + the editor bundle via esbuild,
                    concatenates core + importers + app into one script (after
                    EXAMPLES, SCHEMA, NETDIAGRAM_VERSION / _HOMEPAGE globals),
                    writes dist/netdiagram.html.
scripts/render.js   CLI: same pipeline in node, for external editors (VS Code
                    tasks in .vscode/tasks.json call it) and CI change reviews.
scripts/import.js   CLI: inventory -> YAML scaffold (stdin with `-`).
examples/*.yaml     All examples are injected into the app at build time
                    (EXAMPLES array; picker below the editor). hq-edge-core.yaml
                    is the default on load and the one tests assert against.
test/test.js        Assertion-based tests, no framework. Must pass before commit.
test/golden/*.svg   Every example rendered with a fixed date (+ hq-edge-core in
                    blueprint); byte-compared by npm test.
```

Layout is done by ELK (`elk.bundled.js`, layered algorithm, orthogonal routing,
`hierarchyHandling: INCLUDE_CHILDREN` for nested groups).

## YAML schema (quick reference)

```yaml
diagram:
  title: str, direction: down|right   # OPTIONS (control rendering; down is default)
  theme: paper|blueprint, date: str   # OPTIONS (blueprint = cyanotype colors; date
                                      # pins the title-block DATE, else today)
  <any-scalar-key>: val               # attributes; rendered as rows in the
                                      # drafting title block (author, revision, …)
nodes:
  - id: str                # required, unique across nodes AND groups
    label: str
    type: str              # picks glyph: router switch firewall waf db lb cloud
                           # internet user wifi siem storage vm container metal gpu
                           # (+aliases; the rack-server glyph is host|app|web; gpu
                           # aliases gpu-host|accelerator|cuda draw a GPU card).
                           # Platform types vm|container|metal also set the
                           # border style: dashed / fine-dotted / double (hwOf +
                           # HW_STYLES). server, physical [server], dedicated,
                           # baremetal, hypervisor|esx[i]|kvm|proxmox … are metal
                           # aliases (GLYPH_ALIASES). K8s: ingress|service -> lb,
                           # egress[-ip] -> router, etcd -> db, pod -> container,
                           # control-plane|master -> rack server
    icon: str              # explicit glyph override (visual only — border
                           # styling always follows type)
    ip: str | ips: [str]   # rendered one per line as "ip: <value>"
    os: str                # free-form; rendered as "os: <value>"
    tags: [str] | str      # informational only: neutral pills in the top-right
                           # corner showing the tag text, max two per row
                           # (wraps below). Tags never affect styling — glyph
                           # and border come from type/icon
    rank: int              # layout hint: lower = earlier in the flow; unranked
                           # siblings sit at rank 0 (ELK partitioning)
    nodes: [node, ...]     # CHILD NODES drawn inside this node's box (a
                           # hypervisor's VMs, a host's containers). Full node
                           # objects, nesting to any depth, like groups.groups.
                           # The node's own chrome becomes the box's top
                           # padding; ids stay unique across every level; a
                           # hosted node may NOT also be a group member
    <any-scalar-key>: val  # unknown scalar keys render as "key: value" lines
groups:
  - id, label, class: zone|vlan|subnet|cloud|onprem|trust (+ Cisco ACI:
    tenant|vrf|bd|ap|epg|l3out; + K8s: cluster|k8s|namespace|ns|nodepool), cidr,
    nodes: [ids], groups: [nested]   # a node may belong to at most one group
    tags: [str] | str      # pills in the top-right, tinted in the group's own
                           # class/style color (tagPills, reused from nodes)
    rank: int              # as for nodes: -1 = above the unranked row, 1 = below;
                           # same-rank siblings follow YAML order left->right
    style:                 # optional visual overrides (extensible)
      color: <name>        # gray red orange yellow green teal cyan blue indigo
                           # purple pink (or colour); overrides the class color
                           # with a toned-down tint (GROUP_COLORS in netdiagram.js)
      border: solid|dashed|dotted   # CSS border-style names (GROUP_BORDERS)
    <any-scalar-key>: val  # cidr + attributes render as "key: value" lines in
                           # an info box in the group's bottom-right corner
                           # (bottom padding grows with the box — see
                           # groupHeader() in src/netdiagram.js)
connections:               # renamed from links: (parseSpec errors on the old key)
  - from/to: node OR group id
    label: str             # shown on edge; equal labels share a palette color
    protocol: str          # tcp|udp|… — shown in the Connections table
    port: int|str          # dest port or range — shown in the Connections table
    direction: forward|both|none   # table: both -> two rows; none -> excluded
    comment: str           # free-form note; Connections-table column only, not on the edge
```

Connection color: shared-label palette color if the connection has a label,
else default ink. The app (`src/app.js`) also renders a Connections tab: a
firewall-rule table derived from the connections (source + destination each with
its address, protocol, port, label, and comment column when any is set),
excluding pairs whose endpoints share the same immediate group ("same zone"
needs no rule); a `direction: both` connection is emitted as two rows, one per
direction, and a `direction: none` (blocked) connection is left out entirely.
`netdiagram-schema.json` is the
JSON Schema for this format — keep it and this section in sync when the
format changes (the editor autocomplete derives its key AND value
suggestions from the schema, so it follows automatically).

## Gotchas — read before touching build or layout code

1. **Never use `String.replace` with file content as the replacement string.**
   Minified libraries contain `` $` `` / `$&` sequences, which `replace()`
   interprets as replacement patterns — this once spliced the document's own
   `<head>` into the middle of js-yaml. `scripts/build.js` uses split/join
   (`inject()`) instead. Keep it that way.
2. **elkjs is NOT on cdnjs.** Do not reintroduce CDN script tags; the original
   bug that motivated vendoring was a hallucinated cdnjs URL. The test suite
   asserts `dist/` contains no CDN references.
3. **Inlined scripts must be script-safe.** `</script` inside vendored code
   terminates the HTML script element early; `scriptSafe()` escapes it.
4. **ELK hierarchical edge coordinates are relative to `edge.container`**, not
   the root. `renderSVG` collects edges recursively and offsets each by its
   container's absolute position. Forgetting this makes arrows float in space.
5. **ELK layout options are per hierarchy level.** Spacing set on the root does
   not apply inside groups — the shared `ELK_SPACING` object is spread into the
   root options AND into every `elkGroup()`. Tune spacing there, not inline.
6. **Group-to-group connections work** (ELK routes to the compound-node
   boundary), but a connection from a child group to its own **ancestor**
   renders awkwardly.
   Prefer sibling-to-sibling or group-to-external-node in examples.
7. **Edge order = connection order.** ELK edge ids are `e<index>` into
   `doc.connections`; `renderSVG` maps styles/labels back via that index.
   Don't reorder or filter edges in `buildElk` without updating the mapping.
8. **Node text metrics** use canvas `measureText` with a monospace stack and
   fall back to `length * 7.8` when canvas is unavailable (node/jsdom).
   `nodeMetrics()` / `groupHeader()` are the single source of truth for box
   sizing and header offsets, shared by ELK sizing and `renderSVG` drawing.
   The measuring font constants (`NODE_FONT`, `CAP_FONT`, `IP_FONT`) must still
   match the `font-size`/`font-weight` attributes written in `renderSVG`, or
   labels overflow their boxes.
9. **Hub fan-outs auto-pack.** Layered layout puts every neighbor of a hub in
   one layer, so hub -> N members = one very wide row. `buildElk` therefore
   switches any group whose interior is untouched by connections (edges may end
   at the group itself) to `SEPARATE_CHILDREN` + component packing
   (`PACK_OPTIONS`), gridding its members near the 2.0 aspect ratio (the
   packer's row width is ~ar*sqrt(area); 1.6 tipped groups of wide nodes —
   long captions like HYPERVISOR — into one-per-row columns).
   INCLUDE_CHILDREN would silently disable that packing — which is exactly why
   it only applies to groups with no boundary-crossing member edges. Advise
   users to connect hub -> group (not each member) for compact fan-outs.
10. **`elk.layered.considerModelOrder.strategy` is ROOT-ONLY.** Setting it on a
    group's layoutOptions crashes ELK's hierarchical layout (undefined-property
    TypeError deep in elk-worker). `MODEL_ORDER` in buildElk is spread into the
    root options only; keep it that way. `rank` maps to ELK partitioning
    (applyRanks), activated per hierarchy level only when a sibling sets one —
    unranked siblings get partition 0 explicitly.

11. **The browser payload is ONE classic script.** build.js concatenates
    netdiagram.js + importers.js + app.js, so top-level `const`/`let` names
    share a scope — a second `const jsyaml` is a SyntaxError that kills the
    page. importers.js therefore lives in an IIFE; new files must too (and get
    an eslint globals entry for what app.js uses).
12. **Views keep connection objects by reference.** filterDoc and diffDocs
    never clone connections; app.js maps between editor indices and drawn
    `data-conn` indices with `indexOf`. Cloning them breaks click-to-source
    and cursor highlighting silently.
13. **Golden SVGs are byte-exact.** Any rendering change (a color, an
    attribute, an offset) fails every golden test. That is the point: run
    `npm run test:golden`, open the changed SVGs, then commit them with the code.
    Node measures text with the 7.8px fallback, so goldens differ from what a
    browser lays out — they guard regressions, not browser pixels.

## Conventions

- Vanilla JS, CommonJS, no frameworks, no transpilation of `src/`.
- `src/netdiagram.js` must stay environment-agnostic: no `document`/`window`
  access without a guard, so tests run in plain node.
- Validation philosophy: `parseSpec` collects **all** errors (with ids and
  indices) and throws once — don't fail fast on the first problem.
- Visual conventions: platform *types* (vm / container / metal + aliases) draw
  the platform glyph AND set the border style — VM = dashed, bare metal =
  double, container = fine-dotted (hwOf + HW_STYLES). Tags are informational
  neutral pills, two per row (tagPills), never styling. Trust boundaries =
  red dashed group border. Edge crossings render as hop arcs: the connection
  with the higher index arcs over the lower one (hopPath/segHops — exact
  H-vs-V intersection tests, only possible because routing is orthogonal).
- After changing rendering or layout, eyeball the example: render
  `examples/hq-edge-core.yaml` and check labels don't collide — the golden
  SVGs catch unintended changes, not ugly-but-intended ones.

## License notes

Project code is MIT. The build embeds js-yaml (MIT), elkjs (EPL-2.0), and
CodeMirror + codemirror-json-schema (MIT) into `dist/netdiagram.html`; keep
the attribution comments the build script emits. EPL-2.0 requires telling
recipients where elkjs source lives — the README license section does that.
