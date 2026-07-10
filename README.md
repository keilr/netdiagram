# netdiagram

Network architecture diagrams from YAML, rendered as blueprint-style SVG
schematics. Ships as a **single self-contained HTML file** — open it in any
browser, no server, no CDN, works offline.

Write this:

```yaml
diagram:
  title: HQ edge & core
  direction: right

nodes:
  - id: fw1
    label: Edge FW A
    type: firewall
    ip: 203.0.113.1
    os: bsd
  - id: web1
    label: web-01
    type: server
    ip: 10.0.10.11
    os: linux
    tags: [prod]

groups:
  - id: dmz
    label: DMZ (VLAN 10)
    class: zone
    cidr: 10.0.10.0/24
    nodes: [web1]

connections:
  - {from: fw1, to: web1, label: "tcp/443 https",  protocol: tcp, port: 443}
  - {from: dmz, to: fw1,  label: "udp/514 syslog", protocol: udp, port: 514}
```

…and get a graph-paper schematic with drawn device glyphs, tinted zone
boundaries, color-coded connections, and a drafting title block — plus a
firewall-rule table derived from the connections. Download the diagram as
**SVG**, the source as **YAML**, or **Export PDF** (opens the browser print
dialog — the diagram stays vector, and page orientation follows its aspect).

## Quick start

```bash
npm install
npm run build          # -> dist/netdiagram.html
```

Open `dist/netdiagram.html` in a browser. The left pane is a YAML editor with
live validation and schema-aware autocomplete — keys, enum values (`type: f…`
→ `firewall`), and node/group ids for connection endpoints; the right pane
renders as you type.

Your work is kept in the browser: the editor buffer is autosaved and restored
on reload, and you can **Save** (or <kbd>Ctrl/Cmd-S</kbd>) the current YAML as a
named **project** to switch between later. Projects live in the browser's local
storage — nothing leaves your machine, and there's no server. (If the browser
blocks local storage for the page, the project controls hide themselves and the
editor still works from examples.)

### Prefer your own editor? (VS Code)

You don't have to write the YAML in the browser app — a CLI renders any spec
file straight to SVG:

```bash
npm run render -- mynet.yaml                     # -> mynet.svg
npm run render -- mynet.yaml out.svg --watch     # re-render on every save
```

Opening this repo in VS Code gives you the same schema-driven IntelliSense
through `.vscode/settings.json` and the recommended
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml):
completion, hover docs, and validation for `examples/*.yaml` and
`*.netdiagram.yaml` files. Two build tasks — *Render current YAML to SVG* and
a `--watch` variant — feed the current file to the CLI; run the watch task
and open the generated SVG in a side-by-side tab for a live preview. For
spec files outside this repo, put a modeline on the first line instead:

```yaml
# yaml-language-server: $schema=/path/to/netdiagram-schema.json
```

## Schema

### `diagram`
| key | values |
|---|---|
| `title` | shown in the drafting title block |
| `direction` | `right` (default) or `down` |
| *anything else* | any other scalar key (`author`, `revision`, `site`, …) is rendered as a row in the drafting title block |

### `nodes[]`
| key | notes |
|---|---|
| `id` | required, unique across nodes and groups |
| `label` | display name (defaults to id) |
| `type` | glyph + caption: `router` `switch` `firewall` `waf` `db` `lb` `cloud` `internet` `user` `wifi` `siem` `storage` `vm` `container` `metal` `gpu` (aliases like `gw`, `docker`, `nas`, and `gpu-host` / `accelerator` / `cuda` work; the rack-server glyph is `host` / `app` / `web`). Platform types `vm` / `container` / `metal` also set the border style: dashed / fine-dotted / double. `server`, `physical [server]`, `dedicated`, `baremetal` are aliases of `metal` |
| `icon` | explicit glyph override — visual only, border styling follows `type` (e.g. `type: metal, icon: db`) |
| `ip` / `ips` | one or many; rendered one per line |
| `os` | free-form (`linux`, `windows`, `bsd`, …) |
| `tags` | informational labels — list (or single string), shown as neutral pills top-right (tag text, two per row). Tags never affect styling |
| *anything else* | unknown scalar keys render as `key: value` lines |

### `groups[]`
| key | notes |
|---|---|
| `id`, `label` | as for nodes |
| `class` | `zone` `vlan` `subnet` `cloud` `onprem` `trust` — tint + border style (trust = red dashed) |
| `cidr` | rendered as `cidr: <value>` in the info box in the group's lower-right corner |
| `nodes` | member node ids (a node belongs to at most one group) |
| `groups` | nested groups, arbitrary depth |
| *anything else* | any other scalar key (`owner`, `site`, …) is rendered as `key: value` in the same info box |

### `connections[]`
| key | notes |
|---|---|
| `from`, `to` | node **or group** ids |
| `label` | shown at the edge midpoint |
| `protocol` | `tcp`, `udp`, … — shown in the Connections table |
| `port` | destination port number or range — shown in the Connections table |
| `direction` | `forward` (default), `both`, `none` |

**Color rules:** connections with a label get a color from a categorical
palette, and **equal labels share the same color** (e.g. every `pgsql`
connection renders identically); unlabeled connections use the default ink.
The app's **Connections tab** turns the list into a firewall-rule table
(protocol/port/direction per rule), skipping pairs that sit in the same zone.

## Development

```
src/netdiagram.js    core: parseSpec -> buildElk -> renderSVG (browser + node)
src/app.js           browser wire-up (editor, debounce, download)
src/editor.js        CodeMirror setup: schema-driven completion, lint, hover
src/template.html    page shell with injection placeholders
scripts/build.js     vendors js-yaml + elkjs, assembles dist/netdiagram.html
scripts/render.js    CLI: YAML -> SVG (--watch), for external editors
examples/            default example YAML (single source of truth)
test/                npm test — pipeline, features, validation, jsdom boot
```

Layout is [ELK](https://eclipse.dev/elk/) (layered, orthogonal routing, real
nested-group support). See `CLAUDE.md` for architecture notes and the list of
sharp edges (ELK coordinate spaces, safe code inlining, etc.).

## License

MIT for project code. The built `dist/netdiagram.html` embeds
[js-yaml](https://github.com/nodeca/js-yaml) (MIT),
[elkjs](https://github.com/kieler/elkjs) (EPL-2.0),
[CodeMirror](https://codemirror.net/) (MIT) and
[codemirror-json-schema](https://github.com/acao/codemirror-json-schema) (MIT).
