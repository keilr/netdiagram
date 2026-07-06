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
    hw: metal
  - id: web1
    label: web-01
    type: server
    ip: 10.0.10.11
    os: linux
    hw: vm

groups:
  - id: dmz
    label: DMZ (VLAN 10)
    class: zone
    cidr: 10.0.10.0/24
    nodes: [web1]

links:
  - {from: fw1, to: web1, label: "443/tcp", type: primary}
  - {from: dmz, to: fw1,  label: syslog,    type: logging}
```

…and get a graph-paper schematic with drawn device glyphs, tinted zone
boundaries, semantic link styles, an auto-generated legend, and a drafting
title block. Export as SVG with one click.

## Quick start

```bash
npm install
npm run build          # -> dist/netdiagram.html
```

Open `dist/netdiagram.html` in a browser. The left pane is a YAML editor with
live validation; the right pane renders as you type.

## Schema

### `diagram`
| key | values |
|---|---|
| `title` | shown in the drafting title block |
| `direction` | `right` (default) or `down` |

### `nodes[]`
| key | notes |
|---|---|
| `id` | required, unique across nodes and groups |
| `label` | display name (defaults to id) |
| `type` | glyph + caption: `router` `switch` `firewall` `server` `db` `lb` `cloud` `internet` `user` `wifi` `siem` `storage` (aliases like `waf`, `gw`, `vm`, `nas` work) |
| `icon` | explicit glyph override |
| `ip` / `ips` | one or many; rendered one per line |
| `os` | free-form (`linux`, `windows`, `bsd`, …) |
| `hw` | `vm` (dashed border), `metal` (double border), `container` (dotted border) — with VM/BM/CT badge |
| *anything else* | unknown scalar keys render as `key: value` lines |

### `groups[]`
| key | notes |
|---|---|
| `id`, `label` | as for nodes |
| `class` | `zone` `vlan` `subnet` `cloud` `onprem` `trust` — tint + border style (trust = red dashed) |
| `cidr` | shown in the group header |
| `nodes` | member node ids (a node belongs to at most one group) |
| `groups` | nested groups, arbitrary depth |

### `links[]`
| key | notes |
|---|---|
| `from`, `to` | node **or group** ids |
| `label` | shown at the edge midpoint |
| `type` | `primary` `backup` `management` `logging` `failure` — semantic color + dash |
| `direction` | `forward` (default), `both`, `none` |

**Color rules:** an explicit `type` always wins. Untyped links with a label get
a color from a categorical palette, and **equal labels share the same color**
(e.g. every `5432` link renders identically). Everything used appears in the
legend.

## Development

```
src/netdiagram.js    core: parseSpec -> buildElk -> renderSVG (browser + node)
src/app.js           browser wire-up (editor, debounce, download)
src/template.html    page shell with injection placeholders
scripts/build.js     vendors js-yaml + elkjs, assembles dist/netdiagram.html
examples/            default example YAML (single source of truth)
test/                npm test — pipeline, features, validation, jsdom boot
```

Layout is [ELK](https://eclipse.dev/elk/) (layered, orthogonal routing, real
nested-group support). See `CLAUDE.md` for architecture notes and the list of
sharp edges (ELK coordinate spaces, safe code inlining, etc.).

## License

MIT for project code. The built `dist/netdiagram.html` embeds
[js-yaml](https://github.com/nodeca/js-yaml) (MIT) and
[elkjs](https://github.com/kieler/elkjs) (EPL-2.0).
