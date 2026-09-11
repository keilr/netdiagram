"use strict";
/* netdiagram core: YAML spec -> ELK graph -> SVG. Runs in browser (inlined) and node (tests). */
const jsyaml = (typeof window !== "undefined" && window.jsyaml) ? window.jsyaml : require("js-yaml");
/* Version stamped into the title block. The browser build injects
 * window.NETDIAGRAM_VERSION; node reads package.json; '' if neither is available. */
const VERSION = (typeof window !== "undefined")
  ? (window.NETDIAGRAM_VERSION || "")
  : (() => { try { return require("../package.json").version || ""; } catch (e) { return ""; } })();
/* ---------------- connection + group semantics ---------------- */
const CONNECTION_STYLES = {
  default: { hex:'#24344d', dash:null, width:1.8 },
  labeled: { dash:null, width:2 }   // hex assigned per label from LABEL_PALETTE
};
/* color-scheme derivation from one base hex — shared by the group classes below
 * and by named style.color overrides; the tint is toned down for the blueprint */
const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 }; };
const mixHex = (hex, toHex, t) => {
  const a = hexToRgb(hex), b = hexToRgb(toHex);
  const c = k => Math.round(a[k] + (b[k] - a[k]) * t).toString(16).padStart(2, '0');
  return '#' + c('r') + c('g') + c('b');
};
const groupColorScheme = hex => {
  const { r, g, b } = hexToRgb(hex);
  return { fill:`rgba(${r},${g},${b},.05)`, stroke: mixHex(hex, '#ffffff', .42), label: hex };
};
const GROUP_STYLES = {
  zone:   { fill:'rgba(180,83,9,.05)',   stroke:'#c98a4b', dash:null,  label:'#9a5b17' },
  vlan:   { fill:'rgba(13,148,136,.05)', stroke:'#4fa9a0', dash:null,  label:'#0f766e' },
  subnet: { fill:'rgba(71,105,155,.06)', stroke:'#8aa2c4', dash:null,  label:'#3f5e8c' },
  cloud:  { fill:'rgba(124,58,237,.045)',stroke:'#a78bda', dash:'6 4', label:'#6d4fb3' },
  onprem: { fill:'rgba(60,72,88,.045)',  stroke:'#9aa6b4', dash:null,  label:'#4b5866' },
  trust:  { fill:'rgba(192,57,43,.03)',  stroke:'#d0685c', dash:'8 5', label:'#a83a2e' },
  /* Cisco ACI containers: tenant > vrf > bd > ap > epg, plus l3out (external) */
  tenant: { ...groupColorScheme('#57636f'), dash:null  },
  vrf:    { ...groupColorScheme('#4338ca'), dash:null  },
  bd:     { ...groupColorScheme('#0e7490'), dash:null  },
  ap:     { ...groupColorScheme('#7c3aed'), dash:null  },
  epg:    { ...groupColorScheme('#15803d'), dash:null  },
  l3out:  { ...groupColorScheme('#c2410c'), dash:'6 4' },
  /* Kubernetes containers: cluster (alias k8s) > namespace (alias ns);
   * nodepool for machine pools (worker / gpu pools) */
  cluster:  { ...groupColorScheme('#1d4ed8'), dash:null },
  k8s:      { ...groupColorScheme('#1d4ed8'), dash:null },
  namespace:{ ...groupColorScheme('#15803d'), dash:null },
  ns:       { ...groupColorScheme('#15803d'), dash:null },
  nodepool: { ...groupColorScheme('#57636f'), dash:null },
  default:{ fill:'rgba(60,72,88,.04)',   stroke:'#a8b2bd', dash:null,  label:'#5b6874' }
};

/* colors assigned to shared connection labels */
const LABEL_PALETTE = ['#0f766e','#7c3aed','#1d4ed8','#9d174d','#4d7c0f','#0e7490','#a21caf','#b45309'];

/* Named group colors (group style.color / style.colour) — same derivation as the
 * class styles above; names are CSS color names, tinted down for the blueprint. */
const GROUP_COLORS = Object.fromEntries(Object.entries({
  gray:'#57636f', red:'#c0392b', orange:'#c2410c', yellow:'#a16207', green:'#15803d',
  teal:'#0f766e', cyan:'#0e7490', blue:'#1d4ed8', indigo:'#4338ca', purple:'#7c3aed', pink:'#be185d'
}).map(([name, hex]) => [name, groupColorScheme(hex)]));
/* CSS border-style names -> SVG stroke-dasharray (null = solid) */
const GROUP_BORDERS = { solid:null, dashed:'8 5', dotted:'2 4' };

/* connection direction vocabulary — shared by the SVG arrows and the Connections table */
const DIR_ALIASES = { both:'both', bidirectional:'both', none:'none' };
const dirOf = l => DIR_ALIASES[String(l.direction || '').toLowerCase()] || 'forward';

/* ---------------- device glyphs (drawn, 24x24 viewbox) ---------------- */
const GLYPHS = {
  router: `<circle cx="12" cy="12" r="10"/><path d="M7 9h7m0 0-2.4-2.4M14 9l-2.4 2.4M17 15h-7m0 0 2.4-2.4M10 15l2.4 2.4"/>`,
  switch: `<rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 10.5h6m0 0-2-2m2 2-2 2M18 13.5h-6m0 0 2-2m-2 2 2 2"/>`,
  firewall:`<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9.3h18M3 14.6h18M9 4v5.3M15 4v5.3M6 9.3v5.3M12 9.3v5.3M18 9.3v5.3M9 14.6V20M15 14.6V20"/>`,
  waf:    `<path d="M12 2.5 19 5v6c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V5z"/><path d="M10.5 9.5 8.5 12l2 2.5M13.5 9.5 15.5 12l-2 2.5"/>`,
  server: `<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M5 9h14M5 15h14"/><circle cx="8.2" cy="6" r=".9" fill="currentColor" stroke="none"/><circle cx="8.2" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="8.2" cy="18" r=".9" fill="currentColor" stroke="none"/>`,
  db:     `<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>`,
  lb:     `<rect x="9" y="2.5" width="6" height="5" rx="1"/><rect x="2" y="16.5" width="5" height="5" rx="1"/><rect x="9.5" y="16.5" width="5" height="5" rx="1"/><rect x="17" y="16.5" width="5" height="5" rx="1"/><path d="M12 7.5v4m0 0L4.5 16.5M12 11.5v5m0-5 7.5 5"/>`,
  cloud:  `<path d="M7 18a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 18.2 10.6 3.8 3.8 0 0 1 17.5 18Z"/>`,
  internet:`<circle cx="12" cy="12" r="9.5"/><ellipse cx="12" cy="12" rx="4.2" ry="9.5"/><path d="M2.5 12h19M4 7h16M4 17h16"/>`,
  user:   `<circle cx="12" cy="7.5" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>`,
  wifi:   `<path d="M3 9.5a13 13 0 0 1 18 0M6.2 13a8.5 8.5 0 0 1 11.6 0M9.4 16.4a4 4 0 0 1 5.2 0"/><circle cx="12" cy="19.5" r="1.3" fill="currentColor" stroke="none"/>`,
  siem:   `<rect x="3" y="4" width="18" height="14" rx="1.5"/><path d="M6 13.5l3-3.5 2.5 2.5L15 8l3 4M8 21h8"/>`,
  storage:`<rect x="3" y="5" width="18" height="6" rx="1"/><rect x="3" y="13" width="18" height="6" rx="1"/><circle cx="7" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="7" cy="16" r=".9" fill="currentColor" stroke="none"/>`,
  vm:     `<rect x="3" y="8" width="13" height="13" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/>`,
  container:`<rect x="2" y="7" width="20" height="11" rx="1.5"/><path d="M6.5 10v5M12 10v5M17.5 10v5"/>`,
  metal:  `<rect x="6" y="6" width="12" height="12" rx="1"/><rect x="10" y="10" width="4" height="4"/><path d="M9.5 6V3M14.5 6V3M9.5 21v-3M14.5 21v-3M6 9.5H3M6 14.5H3M21 9.5h-3M21 14.5h-3"/>`,
  gpu:    `<rect x="2" y="6.5" width="20" height="11" rx="1.5"/><circle cx="8" cy="12" r="3.2"/><path d="M8 8.8v6.4M4.8 12h6.4"/><path d="M14 10h4.5M14 12.3h4.5M14 14.6h4.5"/><path d="M6.5 17.5v2.6M11 17.5v2.6"/>`
};
const GLYPH_ALIASES = {
  fw:'firewall', ips:'firewall',
  rtr:'router', gateway:'router', gw:'router',
  sw:'switch', l2:'switch', l3:'switch',
  host:'server', app:'server', web:'server',
  database:'db', sql:'db',
  loadbalancer:'lb', 'load-balancer':'lb', proxy:'lb',
  inet:'internet', wan:'internet',
  client:'user', workstation:'user', admin:'user',
  ap:'wifi', wireless:'wifi',
  log:'siem', monitor:'siem', monitoring:'siem',
  nas:'storage', san:'storage', backup:'storage',
  virtual:'vm', guest:'vm', virtualmachine:'vm',
  ct:'container', docker:'container', pod:'container', lxc:'container', oci:'container',
  /* "server" means a physical machine -> bare metal (rack glyph stays available via host/app/web) */
  server:'metal', baremetal:'metal', 'bare-metal':'metal', 'bare metal':'metal',
  bm:'metal', physical:'metal', 'physical server':'metal', 'physical-server':'metal',
  physicalserver:'metal', dedicated:'metal', 'dedicated server':'metal',
  /* GPU / accelerator hosts (own glyph, no platform border) */
  'gpu-host':'gpu', gpuhost:'gpu', gpuserver:'gpu', 'gpu-server':'gpu',
  accelerator:'gpu', cuda:'gpu',
  /* Kubernetes / virtualization vocabulary. Hypervisors are physical ->
   * metal (double border); the rest are visual-only aliases */
  hypervisor:'metal', esx:'metal', esxi:'metal', kvm:'metal', proxmox:'metal',
  ingress:'lb', service:'lb', svc:'lb',
  egress:'router', 'egress-ip':'router', egressip:'router', 'egress-gw':'router',
  etcd:'db',
  'control-plane':'server', controlplane:'server', master:'server'
};

/* ---------------- helpers ---------------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const measureCtx = (()=>{ try { return document.createElement('canvas').getContext('2d'); } catch(e){ return null; } })();
const textWCache = new Map();
function textW(t, font){
  if (!measureCtx) return String(t).length * 7.8;
  const key = font + '\u0000' + t;
  let w = textWCache.get(key);
  if (w === undefined){
    measureCtx.font = font;
    w = measureCtx.measureText(t).width;
    textWCache.set(key, w);
  }
  return w;
}

const NODE_FONT = '600 13px ui-monospace, Menlo, Consolas, monospace';
const CAP_FONT = '700 8.5px ui-monospace, Menlo, Consolas, monospace';
const IP_FONT = '10.5px ui-monospace, Menlo, Consolas, monospace';

/* canonical key: aliases resolved, whitespace normalized */
function resolveKey(raw){
  const key = String(raw ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  return GLYPH_ALIASES[key] || key;
}
/* glyph comes from icon (pure visual override) or type */
function glyphFor(node){ return GLYPHS[resolveKey(node.icon || node.type)] || null; }

/* VM = dashed border, bare metal = double border (inner rect), container = fine-dotted;
 * keyed by the platform kind derived from type/icon (see hwOf) */
const HW_STYLES = {
  vm:    { dash:'5 3' },
  metal: { inner:true },
  ct:    { dash:'2 3' }
};
function tagsOf(n){
  const v = n.tags;
  return v == null ? [] : (Array.isArray(v) ? v : [v]).map(String);
}
/* platform kind (vm | metal | ct) derived from the node's type ONLY — icon is
 * a visual glyph override and never affects styling */
function hwOf(n){
  return { vm:'vm', metal:'metal', container:'ct' }[resolveKey(n.type)] || null;
}
const BADGE_FONT = '700 8px ui-monospace, Menlo, Consolas, monospace';
/* tags are informational only: neutral pills in the node's top-right corner
 * showing the tag text (uppercased), max two per row, wrapping below */
const PILL_H = 12, PILL_GAP = 4, PILL_ROW_H = 16;
function tagPills(n){
  const pills = tagsOf(n).map(t => {
    const text = t.toUpperCase();
    const w = Math.max(24, Math.ceil(textW(text, BADGE_FONT) + text.length * .8 + 10));
    return { text, w };
  });
  const rows = [];
  for (let i = 0; i < pills.length; i += 2) rows.push(pills.slice(i, i + 2));
  return rows;
}
const pillRowW = row => row.reduce((a,p) => a + p.w, 0) + (row.length - 1) * PILL_GAP;
function ipListOf(n){
  const v = n.ip ?? n.ips ?? n.addr;
  return v == null ? [] : (Array.isArray(v) ? v : [v]).map(String);
}
function ipsOf(n){ return ipListOf(n).join(' · '); }
const NODE_KNOWN_KEYS = new Set(['id','label','type','icon','ip','ips','addr','os','tags','rank']);
/* option keys control rendering; every other scalar key is a displayed attribute */
const DIAGRAM_OPTION_KEYS = new Set(['title','direction','theme','date']);
const GROUP_KNOWN_KEYS = new Set(['id','label','class','cidr','nodes','groups','style','tags','rank']);
function attrLines(obj, known){
  const out = [];
  for (const [k, val] of Object.entries(obj || {})){
    if (known.has(k) || val == null || typeof val === 'object') continue;
    out.push([k, String(val)]);
  }
  return out;
}
function kvLines(n){
  const out = [];
  if (n.os != null) out.push(['os', String(n.os)]);
  ipListOf(n).forEach(x => out.push(['ip', x]));
  out.push(...attrLines(n, NODE_KNOWN_KEYS));
  return out;
}

/* node box geometry — single source of truth for ELK sizing (elkNode) and SVG
 * drawing (renderSVG); textX/leftW are relative to the box's top-left corner */
function nodeMetrics(n){
  const label = String(n.label ?? n.id);
  const type = n.type ? String(n.type).toUpperCase() : '';
  const kv = kvLines(n);
  const hw = hwOf(n);
  const glyph = glyphFor(n);
  const capW = type ? textW(type, CAP_FONT) + type.length * .5 : 0;
  const leftW = (glyph || type) ? Math.max(glyph ? 24 : 0, Math.ceil(capW)) : 0;
  const textX = 12 + leftW + (leftW ? 12 : 4);
  const kvW = kv.length ? Math.max(...kv.map(([k,v]) => textW(k + ': ' + v, IP_FONT))) : 0;
  const pillRows = tagPills(n);
  const pillsW = pillRows.length ? Math.max(...pillRows.map(pillRowW)) + 13 : 0;   // widest row + corner margin
  const w = Math.max(120, Math.ceil(textX + Math.max(textW(label, NODE_FONT), kvW) + 16 + pillsW));
  const h = Math.max(54, 32 + kv.length * 14, 12 + pillRows.length * PILL_ROW_H);
  return { label, type, kv, hw, pillRows, glyph, leftW, textX, w, h };
}

/* group chrome layout — single source of truth for ELK padding (elkGroup) and
 * renderSVG. The label sits top-left; cidr + attributes render together in a
 * small info box in the group's bottom-right corner (grows the bottom pad). */
const GBOX_PAD = 10, GBOX_LINE_H = 15, GBOX_MARGIN = 8;
function groupHeader(g){
  const lines = [
    ...(g.cidr != null ? [['cidr', String(g.cidr)]] : []),
    ...attrLines(g, GROUP_KNOWN_KEYS)
  ];
  const box = lines.length ? {
    lines,
    w: Math.ceil(Math.max(...lines.map(([k,v]) => textW(k + ': ' + v, IP_FONT)))) + GBOX_PAD*2,
    h: lines.length*GBOX_LINE_H + 10
  } : null;
  return { labelY:22, padTop:46, box, padBottom: box ? GBOX_MARGIN + box.h + 10 : 22 };
}

/* ---------------- parse + validate ---------------- */
function parseSpec(text){
  return specFromDoc(jsyaml.load(text));
}
/* Validation errors carry the offending document path (e.g. ['connections', 3,
 * 'to']) so the editor can underline the exact spot (see sourceMap). The thrown
 * Error joins every message; e.errors keeps the structured list. */
function specFromDoc(doc){
  if (!doc || typeof doc !== 'object') throw new Error('Empty document — define nodes and connections.');
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  const badTags = t => t != null && (
    (typeof t === 'object' && !Array.isArray(t)) ||
    (Array.isArray(t) && t.some(x => x != null && typeof x === 'object')));
  if (doc.links != null) err(['links'], '"links:" has been renamed — use "connections:" instead');
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  if (!nodes.length) err(['nodes'], 'No nodes defined.');
  const nodeMap = new Map();
  nodes.forEach((n,i)=>{
    if (!n || !n.id) { err(['nodes', i], `nodes[${i}]: missing id`); return; }
    if (nodeMap.has(String(n.id))) err(['nodes', i, 'id'], `duplicate node id "${n.id}"`);
    if (badTags(n.tags))
      err(['nodes', i, 'tags'], `nodes[${i}] "${n.id}": tags must be a scalar or a list of scalars`);
    if (n.rank != null && !Number.isFinite(Number(n.rank)))
      err(['nodes', i, 'rank'], `nodes[${i}] "${n.id}": rank must be a number`);
    nodeMap.set(String(n.id), n);
  });

  const groupMap = new Map();
  const claimed = new Map(); // nodeId -> groupId
  function walkGroups(list, path){
    (list||[]).forEach((g,i)=>{
      const gp = [...path, i];
      if (!g || !g.id) { err(gp, `${path.join('.')}[${i}]: group missing id`); return; }
      const gid = String(g.id);
      if (groupMap.has(gid) || nodeMap.has(gid)) err([...gp, 'id'], `duplicate id "${gid}"`);
      if (badTags(g.tags))
        err([...gp, 'tags'], `group "${gid}": tags must be a scalar or a list of scalars`);
      if (g.rank != null && !Number.isFinite(Number(g.rank)))
        err([...gp, 'rank'], `group "${gid}": rank must be a number`);
      groupMap.set(gid, g);
      (g.nodes||[]).forEach((nid, k)=>{
        nid = String(nid);
        if (!nodeMap.has(nid)) err([...gp, 'nodes', k], `group "${gid}": unknown node "${nid}"`);
        else if (claimed.has(nid)) err([...gp, 'nodes', k], `node "${nid}" is in both "${claimed.get(nid)}" and "${gid}"`);
        else claimed.set(nid, gid);
      });
      walkGroups(g.groups, [...gp, 'groups']);
    });
  }
  walkGroups(doc.groups, ['groups']);

  const connections = Array.isArray(doc.connections) ? doc.connections : [];
  connections.forEach((l,i)=>{
    if (!l || l.from == null || l.to == null) { err(['connections', i], `connections[${i}]: needs from + to`); return; }
    for (const end of ['from', 'to'])
      if (!nodeMap.has(String(l[end])) && !groupMap.has(String(l[end])))
        err(['connections', i, end], `connections[${i}]: unknown endpoint "${l[end]}"`);
  });

  if (errors.length){
    const e = new Error(errors.map(x => x.message).join('\n'));
    e.isSpec = true; e.errors = errors;
    throw e;
  }
  return { doc, nodeMap, groupMap, claimed };
}

/* ---------------- source map (YAML offsets for document paths) ----------------
 * Built on js-yaml's event stream, which carries offsets for scalars and
 * collection starts; a collection ends where its last descendant scalar ends.
 * Returns null when the text does not parse. */
function yamlTree(text){
  let events;
  try { events = jsyaml.parseEvents(text); } catch (e) { return null; }
  const stack = [];
  let root = null;
  const add = node => {
    const top = stack[stack.length - 1];
    if (!top) { if (!root) root = node; return; }
    if (top.kind === 'seq') top.items.push(node);
    else if (top.key) { top.pairs.push({ key: top.key, value: node }); top.key = null; }
    else top.key = node;
  };
  for (const e of events){
    if (e.type === 2 || e.type === 3){           // sequence / mapping start
      const node = e.type === 2 ? { kind:'seq', from:e.start, to:e.start, items:[] }
                                : { kind:'map', from:e.start, to:e.start, pairs:[], key:null };
      add(node); stack.push(node);
    } else if (e.type === 4){                    // scalar
      add({ kind:'scalar', from:e.valueStart, to:e.valueEnd, text:text.slice(e.valueStart, e.valueEnd) });
    } else if (e.type === 5){                    // alias
      const p = e.start ?? e.valueStart ?? 0;
      add({ kind:'alias', from:p, to:p });
    } else if (e.type === 6){                    // pop
      const n = stack.pop();
      if (!n) continue;
      const last = n.kind === 'seq' ? n.items[n.items.length - 1]
        : (n.key || (n.pairs.length ? n.pairs[n.pairs.length - 1].value : null));
      if (last) n.to = Math.max(n.to, last.to);
    }
  }
  return root;
}
const treeGet = (map, key) => map && map.kind === 'map'
  ? (map.pairs.find(p => p.key.kind === 'scalar' && p.key.text === key) || {}).value : undefined;

function sourceMap(text){
  const root = yamlTree(text);
  if (!root) return null;
  const idOf = item => { const v = treeGet(item, 'id'); return v && v.kind === 'scalar' ? v.text : null; };
  const inside = (n, pos) => n && pos >= n.from && pos <= n.to;
  /* deepest node along path; a missing tail segment falls back to its parent */
  function rangeOf(path){             // depth: how many path segments resolved
    let n = root, depth = 0;
    for (const seg of path){
      const next = typeof seg === 'number' ? (n.kind === 'seq' ? n.items[seg] : undefined) : treeGet(n, seg);
      if (!next) break;
      n = next; depth++;
    }
    return { from:n.from, to:n.to, depth };
  }
  function findGroup(list, id){
    for (const g of (list && list.kind === 'seq') ? list.items : []){
      if (idOf(g) === id) return g;
      const sub = findGroup(treeGet(g, 'groups'), id);
      if (sub) return sub;
    }
    return null;
  }
  function itemRange(kind, key){
    let n = null;
    if (kind === 'node') n = (treeGet(root, 'nodes')?.items || []).find(it => idOf(it) === key);
    else if (kind === 'group') n = findGroup(treeGet(root, 'groups'), key);
    else if (kind === 'connection') n = (treeGet(root, 'connections')?.items || [])[key];
    return n ? { from:n.from, to:n.to } : null;
  }
  /* what the cursor is on: a node / group / connection item, or a member id
   * inside a group's nodes: list (that node) */
  function itemAt(pos){
    const nodes = treeGet(root, 'nodes');
    for (const it of nodes?.items || []) if (inside(it, pos) && idOf(it)) return { kind:'node', id:idOf(it) };
    const conns = treeGet(root, 'connections');
    const ci = (conns?.items || []).findIndex(it => inside(it, pos));
    if (ci >= 0) return { kind:'connection', index:ci };
    function inGroups(list){
      for (const g of (list && list.kind === 'seq') ? list.items : []){
        if (!inside(g, pos)) continue;
        const deeper = inGroups(treeGet(g, 'groups'));
        if (deeper) return deeper;
        const member = (treeGet(g, 'nodes')?.items || []).find(m => m.kind === 'scalar' && inside(m, pos));
        if (member) return { kind:'node', id:member.text };
        return idOf(g) ? { kind:'group', id:idOf(g) } : null;
      }
      return null;
    }
    return inGroups(treeGet(root, 'groups'));
  }
  return { rangeOf, itemRange, itemAt };
}

/* ---------------- views: tag filter + compare ---------------- */
/* every distinct tag on nodes and groups, sorted */
function allTags(doc){
  const out = new Set();
  (doc?.nodes || []).forEach(n => n && tagsOf(n).forEach(t => out.add(t)));
  (function walk(list){
    (list || []).forEach(g => { if (!g) return; tagsOf(g).forEach(t => out.add(t)); walk(g.groups); });
  })(doc?.groups);
  return [...out].sort((a, b) => a.localeCompare(b));
}
/* Subset of doc showing only what carries one of `tags` (case-insensitive).
 * A tagged group shows its whole subtree; an untagged group survives when
 * something inside it does. Connections survive when both endpoints do.
 * Connection objects are kept by reference (callers map back to source
 * indices with indexOf). */
function filterDoc(doc, tags){
  const want = new Set((tags || []).map(t => String(t).toLowerCase()));
  if (!want.size || !doc) return doc;
  const hit = o => tagsOf(o).some(t => want.has(t.toLowerCase()));
  const byId = new Map((doc.nodes || []).filter(n => n && n.id != null).map(n => [String(n.id), n]));
  const keep = new Set(), grouped = new Set();
  function walk(list, on){
    return (list || []).flatMap(g => {
      if (!g || g.id == null) return [];
      const inTag = on || hit(g);
      (g.nodes || []).forEach(id => grouped.add(String(id)));
      const nodes = (g.nodes || []).filter(id => {
        const n = byId.get(String(id));
        return n && (inTag || hit(n)) && keep.add(String(id));
      });
      const groups = walk(g.groups, inTag);
      if (!inTag && !nodes.length && !groups.length) return [];
      keep.add(String(g.id));
      return [{ ...g, nodes, groups }];
    });
  }
  const groups = walk(doc.groups, false);
  for (const [id, n] of byId) if (!grouped.has(id) && hit(n)) keep.add(id);
  return {
    ...doc,
    nodes: (doc.nodes || []).filter(n => n && keep.has(String(n.id))),
    groups,
    connections: (doc.connections || []).filter(l => l && keep.has(String(l.from)) && keep.has(String(l.to)))
  };
}

/* order-independent JSON for change detection */
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v ?? null);

/* Compare two documents. Returns a merged doc — the current one plus what the
 * base had and the current lost (removed groups re-parented under their old
 * parent when it still exists, removed nodes back in their old group) — and
 * per-item status: 'added' | 'removed' | 'changed' (absent = unchanged).
 * Connections are matched by from/to (nth occurrence); current connection
 * objects are kept by reference, removed ones are appended after them. */
function diffDocs(base, cur){
  base = base || {}; cur = cur || {};
  const flatGroups = (doc) => {
    const out = new Map();
    (function walk(list, parent){
      (list || []).forEach(g => {
        if (!g || g.id == null) return;
        out.set(String(g.id), { g, parent });
        walk(g.groups, String(g.id));
      });
    })(doc.groups, null);
    return out;
  };
  const memberOf = (groups) => {
    const out = new Map();
    for (const [gid, { g }] of groups) (g.nodes || []).forEach(id => { if (!out.has(String(id))) out.set(String(id), gid); });
    return out;
  };
  const byId = doc => new Map((doc.nodes || []).filter(n => n && n.id != null).map(n => [String(n.id), n]));
  const bNodes = byId(base), cNodes = byId(cur);
  const bGroups = flatGroups(base), cGroups = flatGroups(cur);
  const bMember = memberOf(bGroups), cMember = memberOf(cGroups);
  const status = { nodes:new Map(), groups:new Map(), connections:new Map() };
  const counts = { added:0, removed:0, changed:0 };
  const mark = (map, key, s) => { map.set(key, s); counts[s]++; };

  /* merged doc: deep copy of the current groups so re-parenting can't touch cur */
  const copyGroups = list => (list || []).map(g => (g && typeof g === 'object')
    ? { ...g, nodes:[...(g.nodes || [])], groups:copyGroups(g.groups) } : g);
  const doc = { ...cur, nodes:[...(cur.nodes || [])], groups:copyGroups(cur.groups), connections:[...(cur.connections || [])] };
  const merged = flatGroups(doc);
  const taken = new Set([...cNodes.keys(), ...cGroups.keys()]);

  for (const [id, { g, parent }] of cGroups){
    const b = bGroups.get(id);
    const strip = x => canon({ ...x, nodes: undefined, groups: undefined });
    if (!b) mark(status.groups, id, 'added');
    else if (strip(b.g) !== strip(g) || b.parent !== parent) mark(status.groups, id, 'changed');
  }
  for (const [id, { g, parent }] of bGroups){      // walk order: parents first
    if (cGroups.has(id)) continue;
    mark(status.groups, id, 'removed');
    if (taken.has(id)) continue;                   // id now names something else
    const copy = { ...g, nodes:[], groups:[] };
    const host = parent && merged.get(parent);
    if (host) (host.g.groups = host.g.groups || []).push(copy);
    else (doc.groups = doc.groups || []).push(copy);
    merged.set(id, { g:copy, parent });
    taken.add(id);
  }
  for (const [id, n] of cNodes){
    const b = bNodes.get(id);
    if (!b) mark(status.nodes, id, 'added');
    else if (canon(b) !== canon(n) || bMember.get(id) !== cMember.get(id)) mark(status.nodes, id, 'changed');
  }
  for (const [id, n] of bNodes){
    if (cNodes.has(id)) continue;
    mark(status.nodes, id, 'removed');
    if (taken.has(id)) continue;
    doc.nodes.push(n);
    const host = bMember.has(id) && merged.get(bMember.get(id));
    if (host) host.g.nodes.push(id);
    taken.add(id);
  }

  const connKeys = list => {
    const seen = new Map();
    return (list || []).map(l => {
      const k = l ? String(l.from) + ' ' + String(l.to) : '';
      const nth = seen.get(k) || 0; seen.set(k, nth + 1);
      return k + ' ' + nth;
    });
  };
  const bKeys = connKeys(base.connections), cKeys = connKeys(cur.connections);
  const bByKey = new Map(bKeys.map((k, i) => [k, base.connections[i]]));
  cKeys.forEach((k, i) => {
    if (!bByKey.has(k)) mark(status.connections, i, 'added');
    else if (canon(bByKey.get(k)) !== canon(cur.connections[i])) mark(status.connections, i, 'changed');
  });
  const cKeySet = new Set(cKeys);
  bKeys.forEach((k, i) => {
    const l = base.connections[i];
    if (cKeySet.has(k) || !l) return;
    if (!taken.has(String(l.from)) || !taken.has(String(l.to))) return;
    mark(status.connections, doc.connections.length, 'removed');
    doc.connections.push(l);
  });
  return { doc, status, counts };
}

/* ---------------- firewall rules (Connections table) ---------------- */
/* One directed rule per connection; direction: both yields two, direction:
 * none (blocked) none. Pairs whose endpoints share the same immediate zone
 * (a node's parent group; a group is its own zone) need no rule. `conn` is
 * the connection index each rule came from. */
function connectionRules(spec){
  const { doc, nodeMap, groupMap, claimed } = spec;
  const connections = doc.connections || [];
  const zoneOf = id => nodeMap.has(id) ? claimed.get(id) : groupMap.has(id) ? id : undefined;
  function endpoint(id){
    id = String(id);
    const n = nodeMap.get(id);
    if (n) return { name: String(n.label ?? id), addr: ipsOf(n) || '—' };
    const g = groupMap.get(id);
    if (g) return { name: String(g.label ?? id), addr: g.cidr ? String(g.cidr) : '—' };
    return { name: id, addr: '—' };
  }
  const rules = [];
  let excluded = 0;
  connections.forEach((l, i) => {
    const fz = zoneOf(String(l.from)), tz = zoneOf(String(l.to));
    if (fz !== undefined && fz === tz) { excluded++; return; }
    const dir = dirOf(l);
    if (dir === 'none') return;
    const meta = {
      proto:   l.protocol != null ? String(l.protocol) : '',
      port:    l.port     != null ? String(l.port)     : '',
      label:   l.label    != null ? String(l.label)    : '',
      comment: l.comment  != null ? String(l.comment)  : '',
    };
    rules.push({ conn:i, src:endpoint(l.from), dst:endpoint(l.to), ...meta });
    if (dir === 'both') rules.push({ conn:i, src:endpoint(l.to), dst:endpoint(l.from), ...meta });
  });
  return { rules, excluded, considered: connections.length - excluded };
}
/* CSV of the rules; `change` (conn index -> status) adds a Change column */
function rulesToCsv(rules, change){
  const hasComment = rules.some(r => r.comment.trim() !== '');
  const head = ['#','Source','Source Address','Destination','Dest Address','Protocol','Port','Label'];
  if (hasComment) head.push('Comment');
  if (change) head.push('Change');
  const rows = [head, ...rules.map((r, i) => {
    const row = [i+1, r.src.name, r.src.addr, r.dst.name, r.dst.addr, r.proto, r.port, r.label];
    if (hasComment) row.push(r.comment);
    if (change) row.push(change.get(r.conn) || '');
    return row;
  })];
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
}

/* ---------------- embedded source + share links ---------------- */
/* renderSVG embeds the YAML in <metadata id="netdiagram-source">; this pulls it
 * back out of SVG text (escaped text or CDATA). null when absent. */
function extractSource(svgText){
  const m = /<metadata\b[^>]*\bid="netdiagram-source"[^>]*>([\s\S]*?)<\/metadata>/.exec(String(svgText));
  if (!m) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(m[1]);
  if (cdata) return cdata[1];
  const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
  return m[1].replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (s, e) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10))
    : (named[e.toLowerCase()] ?? s));
}
/* Share-link payload for a URL fragment: 'z' + base64url(deflate-raw) where
 * CompressionStream exists, else 'r' + base64url(utf-8). Fragments never reach
 * a server, so a shared link keeps the diagram client-side. */
const b64url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pipeBytes(bytes, stream){
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
async function encodeShare(text, { compress = true } = {}){
  const bytes = new TextEncoder().encode(text);
  if (compress && typeof CompressionStream === 'function')
    return 'z' + b64url(await pipeBytes(bytes, new CompressionStream('deflate-raw')));
  return 'r' + b64url(bytes);
}
async function decodeShare(payload){
  const kind = payload[0], bytes = unb64url(payload.slice(1));
  if (kind === 'r') return new TextDecoder().decode(bytes);
  if (kind === 'z'){
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open compressed share links.');
    return new TextDecoder().decode(await pipeBytes(bytes, new DecompressionStream('deflate-raw')));
  }
  throw new Error('Unrecognized share link.');
}

/* ---------------- build ELK graph ---------------- */
/* ELK applies layout options per hierarchy level — spread at the root AND in
 * every group, or spacing inside groups silently falls back to defaults */
const ELK_SPACING = {
  'elk.layered.spacing.nodeNodeBetweenLayers':'96',
  'elk.spacing.nodeNode':'56',
  'elk.layered.spacing.edgeNodeBetweenLayers':'36',
  'elk.layered.spacing.edgeEdgeBetweenLayers':'22',
  'elk.spacing.edgeNode':'24',
  'elk.spacing.edgeEdge':'18'
};
/* ELK edge ids encode the index into doc.connections (edge order = connection order) */
const edgeId = i => 'e' + i;
const edgeIndex = id => parseInt(String(id).slice(1), 10);

function buildElk(spec){
  const { doc, nodeMap, claimed } = spec;
  const dirRaw = String(doc.diagram?.direction || 'down').toLowerCase();
  const direction = /right|lr/.test(dirRaw) ? 'RIGHT' : 'DOWN';

  function elkNode(n){
    const m = nodeMetrics(n);
    return { id:String(n.id), width:m.w, height:m.h };
  }
  /* Auto-packing: layered assigns every neighbor of a hub to the same layer, so
   * "hub -> group of N" renders the N members as one very wide row. When no
   * connection touches a group's INTERIOR (edges may end at the group itself),
   * the group can be laid out as SEPARATE_CHILDREN — safe because no edge
   * crosses its boundary to a member — which re-enables ELK's component packing
   * and grids the disconnected members near the root aspect ratio instead. */
  const endpoints = new Set((doc.connections||[]).flatMap(l => [String(l.from), String(l.to)]));
  function touchesInterior(g){
    return (g.nodes||[]).some(id => endpoints.has(String(id)))
        || (g.groups||[]).some(sub => sub && (endpoints.has(String(sub.id)) || touchesInterior(sub)));
  }
  /* aspectRatio feeds ELK's component-row packer (row width ~ ar*sqrt(area)):
   * 1.6 tips groups of wide nodes (long captions like HYPERVISOR) into
   * one-per-row columns; 2.0 keeps 2-3 column grids without flattening
   * everything into rows (2.4 does) */
  const PACK_OPTIONS = {
    'elk.hierarchyHandling':'SEPARATE_CHILDREN',
    'elk.separateConnectedComponents':'true',
    'elk.aspectRatio':'2.0'
  };
  /* in-layer order follows YAML order (left->right in a down layout), so
   * authors can nudge siblings around without fighting crossing minimization.
   * ROOT ONLY: setting this on group levels crashes ELK's hierarchical layout. */
  const MODEL_ORDER = { 'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES' };
  /* rank: pins siblings to ELK partitions — lower rank lays out earlier in the
   * flow direction (higher up in a down layout), unranked siblings sit at rank
   * 0. Only activated for levels where some sibling actually sets a rank. */
  function applyRanks(owners, children, layoutOptions){
    if (!owners.some(o => o && o.rank != null)) return;
    layoutOptions['elk.partitioning.activate'] = 'true';
    owners.forEach((o, i) => {
      children[i].layoutOptions = { ...(children[i].layoutOptions || {}),
        'elk.partitioning.partition': String(Math.trunc(Number(o?.rank ?? 0))) };
    });
  }
  function elkGroup(g){
    const hdr = groupHeader(g);
    const members = (g.nodes||[]).map(id => nodeMap.get(String(id)));
    const subs = g.groups||[];
    const children = [...members.map(elkNode), ...subs.map(elkGroup)];
    const layoutOptions = {
      'elk.padding': `[top=${hdr.padTop},left=22,bottom=${hdr.padBottom},right=22]`,
      ...ELK_SPACING,
      ...(touchesInterior(g) ? {} : PACK_OPTIONS)
    };
    applyRanks([...members, ...subs], children, layoutOptions);
    return { id:String(g.id), layoutOptions, children };
  }
  const topGroups = doc.groups||[];
  const looseNodes = [...nodeMap.values()].filter(n=>!claimed.has(String(n.id)));
  const rootChildren = [...topGroups.map(elkGroup), ...looseNodes.map(elkNode)];
  const edges = (doc.connections||[]).map((l,i)=>({ id:edgeId(i), sources:[String(l.from)], targets:[String(l.to)] }));

  const rootOptions = {
    'elk.algorithm':'layered',
    'elk.direction':direction,
    'elk.hierarchyHandling':'INCLUDE_CHILDREN',
    'elk.spacing.componentComponent':'64',
    'elk.edgeRouting':'ORTHOGONAL',
    'elk.spacing.edgeLabel':'8',
    'elk.padding':'[top=16,left=16,bottom=16,right=16]',
    ...ELK_SPACING,
    ...MODEL_ORDER
  };
  applyRanks([...topGroups, ...looseNodes], rootChildren, rootOptions);

  return { id:'root', layoutOptions: rootOptions, children:rootChildren, edges };
}

/* ---------------- two-pass refinement (ports + edge direction) ---------------- */
/* Two fixes that need pass-1 geometry, applied to a fresh graph for pass 2:
 * 1. Against-flow edges (rank places the target BEFORE the source, e.g.
 *    hub -> rank:-1 group) are handed to ELK reversed — otherwise ELK routes
 *    them around the whole diagram and into the target's far side. renderSVG
 *    detects the swap by comparing endpoints to the connection and flips the
 *    drawn path back, so arrows still point from -> to.
 * 2. ELK's crossing minimization barely orders the attachment points of
 *    hierarchical edges, so a hub's edges leave in arbitrary order and cross.
 *    Every leaf node with 2+ edges gets FIXED_ORDER ports — each edge on the
 *    side facing its counterpart, sides ordered by where the counterparts
 *    actually landed.
 *   const pass1 = await elk.layout(buildElk(spec));
 *   const graph = assignPorts(buildElk(spec), pass1);   // fresh graph!
 *   const layout = graph ? await elk.layout(graph) : pass1;
 * Returns null when nothing changed (skip the second pass). */
function assignPorts(graph, layout){
  const abs = {};                          // id -> absolute box + center
  (function walk(n, x, y){
    for (const c of n.children||[]){
      const x0 = x + (c.x||0), y0 = y + (c.y||0);
      abs[c.id] = { x0, y0, x1: x0 + (c.width||0), y1: y0 + (c.height||0),
                    x: x0 + (c.width||0)/2, y: y0 + (c.height||0)/2 };
      walk(c, x0, y0);
    }
  })(layout, 0, 0);
  const down = (graph.layoutOptions||{})['elk.direction'] !== 'RIGHT';

  /* 1. reverse edges whose target landed wholly before the source in the
   * flow direction — ELK then routes them short and direct */
  let assigned = false;
  for (const e of graph.edges||[]){
    const s = abs[e.sources[0]], t = abs[e.targets[0]];
    if (!s || !t) continue;
    if (down ? t.y1 <= s.y0 : t.x1 <= s.x0){
      [e.sources, e.targets] = [e.targets, e.sources];
      assigned = true;
    }
  }

  const leaves = {};                       // leaf node id -> graph node object
  (function collect(n){
    for (const c of n.children||[])
      if (c.children && c.children.length) collect(c); else leaves[c.id] = c;
  })(graph);

  const incident = {};                     // leaf id -> [{e, end, other}]
  for (const e of graph.edges||[]){
    const s = e.sources[0], t = e.targets[0];
    if (leaves[s]) (incident[s] = incident[s]||[]).push({ e, end:'sources', other:t });
    if (leaves[t]) (incident[t] = incident[t]||[]).push({ e, end:'targets', other:s });
  }

  /* 2. FIXED_ORDER ports on multi-edge leaf nodes */
  for (const id of Object.keys(incident)){
    const list = incident[id];
    if (list.length < 2 || !abs[id]) continue;
    const c = abs[id];
    const bySide = { NORTH:[], EAST:[], SOUTH:[], WEST:[] };
    for (const it of list){
      const o = abs[it.other];
      if (!o) continue;                    // unknown counterpart: leave endpoint on the node
      const dx = o.x - c.x, dy = o.y - c.y;
      /* prefer the flow axis: a counterpart whose box lies wholly before/after
       * the node goes on the flow-facing side, even when it is far off-axis;
       * the perpendicular sides are only for counterparts level with it */
      const side = down
        ? (o.y1 < c.y ? 'NORTH' : o.y0 > c.y ? 'SOUTH' : dx < 0 ? 'WEST'  : 'EAST')
        : (o.x1 < c.x ? 'WEST'  : o.x0 > c.x ? 'EAST'  : dy < 0 ? 'NORTH' : 'SOUTH');
      /* sort key = clockwise position on that side (N: left->right,
       * E: top->bottom, S: right->left, W: bottom->top) */
      bySide[side].push({ it, k: side==='NORTH' ? dx : side==='EAST' ? dy
                                : side==='SOUTH' ? -dx : -dy });
    }
    const node = leaves[id];
    node.layoutOptions = { ...(node.layoutOptions||{}), 'elk.portConstraints':'FIXED_ORDER' };
    node.ports = [];
    let idx = 0;
    for (const side of ['NORTH','EAST','SOUTH','WEST']){
      bySide[side].sort((a,b)=>a.k-b.k);
      for (const { it } of bySide[side]){
        const pid = `${id}.p${idx}`;
        node.ports.push({ id: pid, width: .1, height: .1,
          layoutOptions: { 'elk.port.side': side, 'elk.port.index': String(idx) } });
        it.e[it.end] = [pid];
        idx++;
      }
    }
    assigned = true;
  }
  return assigned ? graph : null;
}

/* ---------------- themes + change colors ---------------- */
/* renderSVG colors come from a theme: paper (default) or blueprint — white
 * linework on cyanotype blue, palette colors lifted toward white (tone). */
const THEMES = {
  paper: {
    name:'paper', bg:'#fafbf7', gridS:'#e7ece2', gridL:'#dde3d7',
    ink:'#24344d', text:'#1a2638', muted:'#7a8798', value:'#3f5e8c',
    nodeFill:'#ffffff', boxFill:'#ffffff',
    pillFill:'#eef1f4', pillStroke:'#9aa7ba', pillText:'#5b6874',
    tone: hex => hex,
    group: st => st
  },
  blueprint: {
    name:'blueprint', bg:'#1f4f8f', gridS:'#2a5998', gridL:'#3565a3',
    ink:'#e8f0fc', text:'#ffffff', muted:'#a9c2e6', value:'#d4e4fb',
    nodeFill:'#1b4680', boxFill:'#1b4680',
    pillFill:'#28589a', pillStroke:'#9fbbe3', pillText:'#dbe8fb',
    tone: hex => mixHex(hex, '#ffffff', .55),
    group: st => ({ ...st, fill:'rgba(255,255,255,.04)',
      stroke: mixHex(st.label, '#ffffff', .45), label: mixHex(st.label, '#ffffff', .62) })
  }
};
const themeOf = name => {
  const k = String(name || '').toLowerCase();
  return Object.hasOwn(THEMES, k) ? THEMES[k] : THEMES.paper;
};
/* compare view (opts.diff): halo + corner mark per changed item */
const DIFF_COLORS = { added:'#15803d', removed:'#c0392b', changed:'#b45309' };
const DIFF_MARKS = { added:'+', removed:'−', changed:'~' };

/* ---------------- render SVG ---------------- */
function midOfPolyline(pts){
  let total = 0;
  for (let i=1;i<pts.length;i++) total += Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  let half = total/2;
  for (let i=1;i<pts.length;i++){
    const seg = Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    if (half <= seg){
      const t = seg ? half/seg : 0;
      return { x: pts[i-1].x + (pts[i].x-pts[i-1].x)*t, y: pts[i-1].y + (pts[i].y-pts[i-1].y)*t };
    }
    half -= seg;
  }
  return pts[Math.floor(pts.length/2)] || {x:0,y:0};
}

/* ---- crossing hops --------------------------------------------------------
 * Layered layout minimizes crossings but cannot always avoid them. Where an
 * edge crosses an earlier one (lower connection index) perpendicularly, its
 * straight run is replaced by a small arc — the drafting convention for
 * "these wires do not connect". Orthogonal routing makes detection exact:
 * crossings are always one horizontal against one vertical segment. */
const HOP_R = 4.5;          // hop radius
const HOP_END_MARGIN = 8;   // keep hops clear of bends and terminals
const AXIS_EPS = .75;       // tolerance for treating a segment as axis-aligned

function segOrient(a, b){
  if (Math.abs(a.y - b.y) < AXIS_EPS && Math.abs(a.x - b.x) >= AXIS_EPS) return 'h';
  if (Math.abs(a.x - b.x) < AXIS_EPS && Math.abs(a.y - b.y) >= AXIS_EPS) return 'v';
  return null;
}
/* crossing positions of segment a->b (along its travel axis) against every
 * perpendicular segment of the earlier polylines */
function segHops(a, b, lowerPolys){
  const o = segOrient(a, b);
  if (!o) return [];
  const lo = o === 'h' ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const hi = o === 'h' ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  const level = o === 'h' ? a.y : a.x;
  const hops = [];
  for (const pts of lowerPolys){
    for (let i = 1; i < pts.length; i++){
      const c = pts[i-1], d = pts[i];
      if (segOrient(c, d) !== (o === 'h' ? 'v' : 'h')) continue;
      const cross = o === 'h' ? c.x : c.y;   // where the other segment sits on our axis
      const clo = o === 'h' ? Math.min(c.y, d.y) : Math.min(c.x, d.x);
      const chi = o === 'h' ? Math.max(c.y, d.y) : Math.max(c.x, d.x);
      if (cross <= lo + HOP_END_MARGIN || cross >= hi - HOP_END_MARGIN) continue; // near our bend/terminal
      if (level <= clo + AXIS_EPS || level >= chi - AXIS_EPS) continue;           // T-junction, not a crossing
      hops.push(cross);
    }
  }
  return hops;
}
/* path data for a polyline with hop arcs; hops bulge up (horizontal runs)
 * resp. right (vertical runs); overlapping hops merge into one wider arc */
function hopPath(pts, lowerPolys){
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++){
    const a = pts[i-1], b = pts[i];
    const o = segOrient(a, b);
    const hops = o && lowerPolys.length ? segHops(a, b, lowerPolys) : [];
    if (!hops.length){ d += `L${b.x} ${b.y}`; continue; }
    const dir = (o === 'h' ? b.x - a.x : b.y - a.y) > 0 ? 1 : -1;
    hops.sort((p, q) => (p - q) * dir);
    const runs = [];
    for (const c of hops){
      const run = runs[runs.length - 1];
      if (run && Math.abs(c - run[run.length - 1]) <= HOP_R * 2 + 1) run.push(c);
      else runs.push([c]);
    }
    const sweep = dir > 0 ? 1 : 0;
    for (const run of runs){
      const from = run[0] - HOP_R * dir, to = run[run.length - 1] + HOP_R * dir;
      const rHalf = Math.abs(to - from) / 2;
      if (o === 'h') d += `L${from} ${a.y}A${rHalf} ${HOP_R} 0 0 ${sweep} ${to} ${a.y}`;
      else           d += `L${a.x} ${from}A${HOP_R} ${rHalf} 0 0 ${sweep} ${a.x} ${to}`;
    }
    d += `L${b.x} ${b.y}`;
  }
  return d;
}

/* opts: { theme, date, source (YAML to embed), diff ({status, counts, base}
 * from diffDocs), rows ([[key, value]] extra title-block rows) } */
function renderSVG(spec, layout, opts = {}){
  const { doc, nodeMap, groupMap } = spec;
  const title = String(doc.diagram?.title || 'untitled network');
  const T = themeOf(opts.theme ?? doc.diagram?.theme);
  const diff = opts.diff || null;
  const statusOf = (kind, key) => diff ? diff.status[kind].get(key) : undefined;
  const diffHex = s => T.tone(DIFF_COLORS[s]);
  const diffHalo = (s, b, rx) => s
    ? `<rect class="nd-halo" x="${b.x-4}" y="${b.y-4}" width="${b.w+8}" height="${b.h+8}" rx="${rx}" fill="none" stroke="${diffHex(s)}" stroke-width="2.2"${s === 'removed' ? ' stroke-dasharray="6 4"' : ''}/>` : '';
  const diffMark = (s, x, y) => s
    ? `<g class="nd-change" data-change="${s}"><circle cx="${x}" cy="${y}" r="7.5" fill="${diffHex(s)}"/><text x="${x}" y="${y+3.8}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11" font-weight="700" fill="${T.nodeFill}">${DIFF_MARKS[s]}</text></g>` : '';

  // connections with the same label share a palette color
  const labelColor = new Map();
  for (const l of (doc.connections||[])){
    if (l.label != null && !labelColor.has(String(l.label)))
      labelColor.set(String(l.label), LABEL_PALETTE[labelColor.size % LABEL_PALETTE.length]);
  }
  function styleOf(l, i){
    const st = l.label != null
      ? { ...CONNECTION_STYLES.labeled, hex: T.tone(labelColor.get(String(l.label))) }
      : { ...CONNECTION_STYLES.default, hex: T.ink };
    const s = statusOf('connections', i);
    // compare view: unchanged connections recede so the change colors can't be
    // mistaken for label colors
    if (!s) return diff ? { ...st, hex: T.muted, opacity: .45 } : st;
    return { ...st, hex: diffHex(s), dash: s === 'removed' ? '6 4' : st.dash, opacity: s === 'removed' ? .6 : null };
  }
  // absolute positions
  const abs = new Map(); // id -> {x,y,w,h,isGroup}
  (function walk(node, ox, oy){
    (node.children||[]).forEach(c=>{
      const x = ox + (c.x||0), y = oy + (c.y||0);
      abs.set(c.id, { x, y, w:c.width||0, h:c.height||0, isGroup: groupMap.has(c.id) });
      walk(c, x, y);
    });
  })(layout, 0, 0);

  const W = Math.ceil(layout.width||600), H = Math.ceil(layout.height||400);
  const dAttrs = [...attrLines(doc.diagram, DIAGRAM_OPTION_KEYS),
    ...(opts.rows || []).map(([k, v]) => [String(k), String(v)])];
  if (diff){
    const c = diff.counts;
    dAttrs.push(['compare', `+${c.added} −${c.removed} ~${c.changed}` + (diff.base ? ` vs ${diff.base}` : '')]);
  }
  const attrKeyW = dAttrs.length ? Math.max(...dAttrs.map(([k]) => textW(k.toUpperCase(), '700 9px ui-monospace'))) : 0;
  const attrValW = dAttrs.length ? Math.max(...dAttrs.map(([,v]) => textW(v, '10px ui-monospace'))) : 0;
  const stampW = Math.max(232, Math.ceil(9 + attrKeyW + 24 + attrValW + 9));
  const stampH = 54 + dAttrs.length*16;
  const PAD = 26;
  const totW = W + PAD*2, totH = H + PAD*2 + stampH + 14;

  let defs = `
    <pattern id="gridS" width="12" height="12" patternUnits="userSpaceOnUse">
      <path d="M12 0H0v12" fill="none" stroke="${T.gridS}" stroke-width=".6"/>
    </pattern>
    <pattern id="gridL" width="60" height="60" patternUnits="userSpaceOnUse">
      <rect width="60" height="60" fill="url(#gridS)"/>
      <path d="M60 0H0v60" fill="none" stroke="${T.gridL}" stroke-width="1"/>
    </pattern>`;
  const markerHexes = [...new Set((doc.connections||[]).map((l, i) => styleOf(l, i).hex))];
  for (const hex of markerHexes){
    defs += `
    <marker id="ah-${hex.slice(1)}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 .8 9.2 5 0 9.2z" fill="${hex}"/>
    </marker>`;
  }

  let gGroups = '', gNodes = '', gEdges = '', gLabels = '';

  // groups (parents before children so nesting paints correctly — walk order already ensures it via Map insertion)
  for (const [id, b] of abs){
    if (!b.isGroup) continue;
    const g = groupMap.get(id) || {};
    let st = GROUP_STYLES[String(g.class||'').toLowerCase()] || GROUP_STYLES.default;
    // style overrides: style.color/colour picks a palette scheme, style.border sets the line style
    const gs = g.style || {};
    const cName = String(gs.color ?? gs.colour ?? '').toLowerCase().trim();
    if (GROUP_COLORS[cName]) st = { ...st, ...GROUP_COLORS[cName] };
    st = T.group(st);
    const bName = String(gs.border ?? '').toLowerCase().trim();
    const dashVal = (bName in GROUP_BORDERS) ? GROUP_BORDERS[bName] : st.dash;
    const dash = dashVal ? ` stroke-dasharray="${dashVal}"` : '';
    const hdr = groupHeader(g);
    // cidr + attributes live in a small info box in the bottom-right corner
    let boxText = '';
    if (hdr.box){
      const bx = b.x + b.w - GBOX_MARGIN - hdr.box.w, by = b.y + b.h - GBOX_MARGIN - hdr.box.h;
      boxText = `<rect class="attr-box" x="${bx}" y="${by}" width="${hdr.box.w}" height="${hdr.box.h}" rx="3" fill="${T.boxFill}" fill-opacity=".8" stroke="${st.stroke}" stroke-width=".9"/>`
        + hdr.box.lines.map(([k,v],i) =>
          `<text x="${bx+GBOX_PAD}" y="${by + 16 + i*GBOX_LINE_H}" font-family="ui-monospace,Menlo,monospace" font-size="10.5" fill="${st.label}"><tspan opacity=".6">${esc(k)}: </tspan><tspan opacity=".9">${esc(v)}</tspan></text>`).join('');
    }
    // tag pills in the top-right corner, styled in the group's own class color
    let gBadge = '';
    tagPills(g).forEach((row, r) => {
      let px = b.x + b.w - 10 - pillRowW(row);
      const py = b.y + 8 + r * PILL_ROW_H;
      for (const p of row){
        gBadge += `<rect x="${px}" y="${py}" width="${p.w}" height="${PILL_H}" rx="6" fill="${T.boxFill}" fill-opacity=".85" stroke="${st.stroke}" stroke-width=".9"/>
      <text x="${px+p.w/2}" y="${py+9}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8" font-weight="700" letter-spacing=".8" fill="${st.label}">${esc(p.text)}</text>`;
        px += p.w + PILL_GAP;
      }
    });
    const ds = statusOf('groups', id);
    gGroups += `<g class="nd-group" data-id="${esc(id)}"${ds === 'removed' ? ' opacity=".5"' : ''}>
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.4"${dash}/>
      ${diffHalo(ds, b, 11)}
      <text x="${b.x+14}" y="${b.y+hdr.labelY}" font-family="ui-monospace,Menlo,monospace" font-size="11" font-weight="700" letter-spacing="1.6" fill="${st.label}">${esc(String(g.label||id).toUpperCase())}</text>
      ${boxText}${gBadge}${diffMark(ds, b.x, b.y)}</g>`;
  }

  // nodes
  for (const [id, b] of abs){
    if (b.isGroup) continue;
    const n = nodeMap.get(id); if (!n) continue;
    const { label, type, kv, hw, pillRows, glyph, leftW, textX } = nodeMetrics(n);
    const iconX = b.x + 12 + (leftW - 24) / 2;
    const capX = b.x + 12 + leftW / 2;
    const tx = b.x + textX;
    const hs = hw ? HW_STYLES[hw] : null;
    const borderDash = hs?.dash ? ` stroke-dasharray="${hs.dash}"` : '';
    const inner = hs?.inner
      ? `<rect x="${b.x+3}" y="${b.y+3}" width="${b.w-6}" height="${b.h-6}" rx="4" fill="none" stroke="${T.ink}" stroke-width=".8"/>` : '';
    // tag pills: right-aligned block in the corner, up to two per row
    let badge = '';
    pillRows.forEach((row, r) => {
      let px = b.x + b.w - 7 - pillRowW(row);
      const py = b.y + 6 + r * PILL_ROW_H;
      for (const p of row){
        badge += `<rect x="${px}" y="${py}" width="${p.w}" height="${PILL_H}" rx="6" fill="${T.pillFill}" stroke="${T.pillStroke}" stroke-width=".8"/>
      <text x="${px+p.w/2}" y="${py+9}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8" font-weight="700" letter-spacing=".8" fill="${T.pillText}">${esc(p.text)}</text>`;
        px += p.w + PILL_GAP;
      }
    });
    const kvText = kv.map(([k,v],i) =>
      `<text x="${tx}" y="${b.y + 38 + i*14}" font-family="ui-monospace,Menlo,monospace" font-size="10.5"><tspan fill="${T.muted}">${esc(k)}: </tspan><tspan fill="${T.value}">${esc(v)}</tspan></text>`
    ).join('');
    const ds = statusOf('nodes', id);
    gNodes += `<g class="nd-node" data-id="${esc(id)}"${ds === 'removed' ? ' opacity=".5"' : ''}>
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${T.nodeFill}" stroke="${T.ink}" stroke-width="1.5"${borderDash}/>
      ${inner}${diffHalo(ds, b, 10)}
      ${glyph ? `<g transform="translate(${iconX},${b.y+9})"><g fill="none" stroke="${T.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="${T.ink}">${glyph}</g></g>` : ''}
      ${type ? `<text x="${capX}" y="${b.y + (glyph ? 46 : 26)}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8.5" font-weight="700" letter-spacing=".5" fill="${T.muted}">${esc(type)}</text>` : ''}
      <text x="${tx}" y="${b.y + 22}" font-family="ui-monospace,Menlo,monospace" font-size="13" font-weight="600" fill="${T.text}">${esc(label)}</text>
      ${kvText}
      ${badge}${diffMark(ds, b.x, b.y)}
    </g>`;
  }

  // edges — ELK places hierarchical edges relative to a container node; offset to absolute
  const allEdges = [];
  (function collectEdges(node){
    (node.edges||[]).forEach(e => allEdges.push(e));
    (node.children||[]).forEach(collectEdges);
  })(layout);
  const offsetOf = id => (!id || id==='root') ? {x:0,y:0} : (abs.get(id) || {x:0,y:0});
  // pass 1: absolute polylines, sorted to connection order so hop assignment
  // (later edge hops over earlier one) is stable regardless of ELK nesting
  const drawn = [];
  const bare = id => String(id).replace(/\.p\d+$/, '');  // strip assignPorts port suffix
  allEdges.forEach(e=>{
    const sec = (e.sections||[])[0]; if (!sec) return;
    const off = offsetOf(e.container);
    const pts = [sec.startPoint, ...(sec.bendPoints||[]), sec.endPoint]
      .map(p => ({ x: p.x + off.x, y: p.y + off.y }));
    // assignPorts feeds against-flow edges to ELK reversed; flip the drawn
    // path back so markers still point from -> to
    const l = (doc.connections||[])[edgeIndex(e.id)];
    if (l && String(l.from) !== String(l.to)
          && bare((e.sources||[])[0]) === String(l.to)
          && bare((e.targets||[])[0]) === String(l.from)) pts.reverse();
    drawn.push({ idx: edgeIndex(e.id), pts });
  });
  drawn.sort((p, q) => p.idx - q.idx);
  // pass 2: draw, arcing over every crossing with an earlier edge
  drawn.forEach((rec, k)=>{
    const l = (doc.connections||[])[rec.idx] || {};
    const st = styleOf(l, rec.idx);
    const mk = 'ah-' + st.hex.slice(1);
    const d = hopPath(rec.pts, drawn.slice(0, k).map(r => r.pts));
    const dirMode = dirOf(l);
    const mEnd = dirMode==='none' ? '' : ` marker-end="url(#${mk})"`;
    const mStart = dirMode==='both' ? ` marker-start="url(#${mk})"` : '';
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : '';
    const op = st.opacity ? ` opacity="${st.opacity}"` : '';
    const lblAttr = l.label != null ? ` data-label="${esc(String(l.label))}"` : '';
    gEdges += `<path class="edge" data-conn="${rec.idx}"${lblAttr} d="${d}" fill="none" stroke="${st.hex}" stroke-width="${st.width}"${dash}${op}${mEnd}${mStart}/>`;
    if (l.label){
      const m = midOfPolyline(rec.pts);
      gLabels += `<text class="edge-lbl" data-conn="${rec.idx}" data-label="${esc(String(l.label))}" x="${m.x}" y="${m.y-5}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11" fill="${st.hex}" stroke="${T.bg}" stroke-width="4" paint-order="stroke" stroke-linejoin="round"${op}>${esc(String(l.label))}</text>`;
    }
  });

  // drafting title block
  const sx = totW - stampW - 18, sy = totH - stampH - 14;
  const date = String(opts.date ?? doc.diagram?.date ?? new Date().toISOString().slice(0,10));
  const attrRows = dAttrs.map(([k,v],i)=>{
    const ry = sy + 54 + i*16;
    return `<path d="M${sx} ${ry} h${stampW}" stroke="${T.ink}" stroke-width=".7"/>
    <text x="${sx+9}" y="${ry+12}" font-family="ui-monospace,Menlo,monospace" font-size="9" letter-spacing="1" fill="${T.muted}">${esc(k.toUpperCase())}</text>
    <text x="${sx+stampW-9}" y="${ry+12}" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10" fill="${T.ink}">${esc(v)}</text>`;
  }).join('');
  const stamp = `<g>
    <rect x="${sx}" y="${sy}" width="${stampW}" height="${stampH}" fill="${T.boxFill}" stroke="${T.ink}" stroke-width="1.4"/>
    <path d="M${sx} ${sy+20} h${stampW} M${sx+150} ${sy+20} V${sy+54}" stroke="${T.ink}" stroke-width="1"/>
    <text x="${sx+9}" y="${sy+14.5}" font-family="ui-monospace,Menlo,monospace" font-size="10.5" font-weight="700" letter-spacing="1.2" fill="${T.ink}">${esc(title.toUpperCase())}</text>
    <text x="${sx+9}" y="${sy+37}" font-family="ui-monospace,Menlo,monospace" font-size="9" letter-spacing="1" fill="${T.muted}">DRAWN</text>
    <text x="${sx+9}" y="${sy+48}" font-family="ui-monospace,Menlo,monospace" font-size="10" fill="${T.ink}">netdiagram${VERSION ? ' v' + esc(VERSION) : ''}</text>
    <text x="${sx+159}" y="${sy+37}" font-family="ui-monospace,Menlo,monospace" font-size="9" letter-spacing="1" fill="${T.muted}">DATE</text>
    <text x="${sx+159}" y="${sy+48}" font-family="ui-monospace,Menlo,monospace" font-size="10" fill="${T.ink}">${esc(date)}</text>
    ${attrRows}
  </g>`;

  // the YAML source rides along, so a downloaded SVG can be imported and edited again
  const meta = opts.source != null
    ? `\n    <metadata id="netdiagram-source" data-type="text/yaml">${esc(opts.source)}</metadata>` : '';
  const nc = nodeMap.size, gc = groupMap.size, cc = (doc.connections||[]).length;
  const desc = `${nc} node${nc!==1?'s':''}, ${gc} group${gc!==1?'s':''}, ${cc} connection${cc!==1?'s':''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="nd-title nd-desc" width="${totW}" height="${totH}" viewBox="0 0 ${totW} ${totH}" font-family="ui-monospace,Menlo,monospace" data-theme="${T.name}" data-bg="${T.bg}">
    <title id="nd-title">${esc(title)}</title>
    <desc id="nd-desc">${esc(desc)}</desc>${meta}
    <defs>${defs}</defs>
    <rect width="${totW}" height="${totH}" fill="${T.bg}"/>
    <rect width="${totW}" height="${totH}" fill="url(#gridL)"/>
    <g transform="translate(${PAD},${PAD})">
      ${gGroups}
      ${gEdges}
      ${gNodes}
      ${gLabels}
    </g>
    ${stamp}
  </svg>`;
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { parseSpec, specFromDoc, sourceMap, buildElk, assignPorts, renderSVG,
    allTags, filterDoc, diffDocs, connectionRules, rulesToCsv, extractSource, encodeShare, decodeShare,
    CONNECTION_STYLES, GROUP_STYLES, GLYPHS, LABEL_PALETTE, THEMES,
    // helpers the browser app (concatenated after this file at build time) reuses
    esc, dirOf, ipsOf };
