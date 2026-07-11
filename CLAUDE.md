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
npm run lint       # eslint (flat config; also runs first in CI)
npm test           # builds, then runs test/test.js (pipeline, features, validation, jsdom boot)
```

There is no dev server; after `npm run build`, open `dist/netdiagram.html` in a browser.

## Architecture

```
src/netdiagram.js   Core library (browser + node). Pure pipeline:
                    parseSpec(yamlText) -> {doc, nodeMap, groupMap, claimed}
                    buildElk(spec)      -> ELK graph JSON (layout is caller's job)
                    renderSVG(spec, layout) -> SVG string
                    Also: CONNECTION_STYLES, GROUP_STYLES, GLYPHS, LABEL_PALETTE.
src/app.js          Browser-only wire-up: textarea editor, debounced render,
                    SVG download, YAML import/download, PDF export (prints via a hidden
                    iframe — the browser's print-to-PDF keeps it vector),
                    example loading (picker below the editor), and local
                    project persistence (autosaves the
                    editor buffer as a draft and stores named projects in
                    localStorage under netdiagram:v1:* keys; every storage
                    access is guarded, so an opaque/unavailable origin hides the
                    project UI and degrades to no-op). Expects globals ELK,
                    jsyaml, EXAMPLE (injected at build time).
src/editor.js       CodeMirror 6 setup (bundled separately by esbuild):
                    YAML mode + json-schema lint/hover/key-completion, plus
                    valueCompletion() — value hints the library doesn't do:
                    enums/examples read from the JSON schema, document ids
                    for connection endpoints and group member lists.
src/template.html   Page shell + CSS with <!--INJECT:JSYAML-->, <!--INJECT:ELK-->,
                    <!--INJECT:APP--> placeholders.
scripts/build.js    Vendors js-yaml + elkjs via esbuild, injects everything into
                    the template, writes dist/netdiagram.html.
scripts/render.js   CLI: node scripts/render.js in.yaml [out.svg] [--watch] —
                    same pipeline in node, for external-editor workflows
                    (VS Code tasks in .vscode/tasks.json call it).
examples/*.yaml     All examples are injected into the app at build time
                    (EXAMPLES array; picker in the header). hq-edge-core.yaml
                    is the default on load and the one tests assert against.
test/test.js        Assertion-based tests, no framework. Must pass before commit.
```

Layout is done by ELK (`elk.bundled.js`, layered algorithm, orthogonal routing,
`hierarchyHandling: INCLUDE_CHILDREN` for nested groups).

## YAML schema (quick reference)

```yaml
diagram:
  title: str, direction: right|down   # OPTIONS (control rendering)
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
                           # baremetal … are metal aliases (GLYPH_ALIASES)
    icon: str              # explicit glyph override (visual only — border
                           # styling always follows type)
    ip: str | ips: [str]   # rendered one per line as "ip: <value>"
    os: str                # free-form; rendered as "os: <value>"
    tags: [str] | str      # informational only: neutral pills in the top-right
                           # corner showing the tag text, max two per row
                           # (wraps below). Tags never affect styling — glyph
                           # and border come from type/icon
    <any-scalar-key>: val  # unknown scalar keys render as "key: value" lines
groups:
  - id, label, class: zone|vlan|subnet|cloud|onprem|trust, cidr,
    nodes: [ids], groups: [nested]   # a node may belong to at most one group
    <any-scalar-key>: val  # cidr + attributes render as "key: value" lines in
                           # an info box in the group's bottom-right corner
                           # (bottom padding grows with the box — see
                           # groupHeader() in src/netdiagram.js)
connections:               # renamed from links: (parseSpec errors on the old key)
  - from/to: node OR group id
    label: str             # shown on edge; equal labels share a palette color
    protocol: str          # tcp|udp|… — shown in the Connections table
    port: int|str          # dest port or range — shown in the Connections table
    direction: forward|both|none
```

Connection color: shared-label palette color if the connection has a label,
else default ink. The app (`src/app.js`) also renders a Connections tab: a
firewall-rule table derived from the connections, excluding pairs whose
endpoints share the same immediate group ("same zone" needs no rule). `netdiagram-schema.json` is the
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
  red dashed group border.
- After changing rendering or layout, eyeball the example: render
  `examples/hq-edge-core.yaml` and check labels don't collide (there is no
  automated visual regression test).

## License notes

Project code is MIT. The build embeds js-yaml (MIT), elkjs (EPL-2.0), and
CodeMirror + codemirror-json-schema (MIT) into `dist/netdiagram.html`; keep
the attribution comments the build script emits. EPL-2.0 requires telling
recipients where elkjs source lives — the README license section does that.
