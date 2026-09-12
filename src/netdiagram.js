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
/* ---------------- node containment ----------------
 * A node may carry `nodes:` — child nodes drawn INSIDE its box (a hypervisor's
 * VMs, a host's containers, a chassis' line cards). Children are full node
 * objects, mirroring the way groups nest groups; the top-level nodes: array
 * therefore holds what is not inside something else. Groups stay a separate
 * concept: a group is a boundary drawn around nodes, a host IS a node. */
const childrenOf = n => (Array.isArray(n?.nodes) ? n.nodes.filter(Boolean) : []);
/* every node at every depth, parents before children, in document order;
 * fn(node, host) — host is null at the top level */
function walkNodes(list, fn, host = null){
  (list || []).forEach(n => {
    if (!n || typeof n !== 'object') return;
    fn(n, host);
    walkNodes(n.nodes, fn, n);
  });
}
function flatNodes(doc){ const out = []; walkNodes(doc?.nodes, n => out.push(n)); return out; }
/* A narrowed document is a PICTURE of the model, not the model: it must not
 * carry views: onward. Keeping them re-validates focus ids against a document
 * the narrowing may have pruned, which fails on a view that is not even the
 * one being drawn. */
const withoutViews = d => { const out = { ...d }; delete out.views; return out; };
const NODE_KNOWN_KEYS = new Set(['id','label','type','icon','ip','ips','addr','os','tags','rank','nodes']);
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
  const hosted = new Map();   // nodeId -> id of the node it sits inside
  /* nodes nest: walk every depth, registering ids in one flat namespace.
   * `prefix` reproduces the document position in messages (nodes[2].nodes[0]) */
  (function walkNodeList(list, path, prefix, host){
    (list||[]).forEach((n,i)=>{
      const np = [...path, i], at = `${prefix}[${i}]`;
      if (!n || !n.id) { err(np, `${at}: missing id`); return; }
      const id = String(n.id);
      if (nodeMap.has(id)) err([...np, 'id'], `duplicate node id "${n.id}"`);
      if (badTags(n.tags))
        err([...np, 'tags'], `${at} "${n.id}": tags must be a scalar or a list of scalars`);
      if (n.rank != null && !Number.isFinite(Number(n.rank)))
        err([...np, 'rank'], `${at} "${n.id}": rank must be a number`);
      nodeMap.set(id, n);
      if (host) hosted.set(id, String(host.id));
      walkNodeList(n.nodes, [...np, 'nodes'], `${at}.nodes`, n);
    });
  })(nodes, ['nodes'], 'nodes', null);

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
        else if (hosted.has(nid)) err([...gp, 'nodes', k], `node "${nid}" is inside "${hosted.get(nid)}" and cannot also be a member of "${gid}"`);
        else if (claimed.has(nid)) err([...gp, 'nodes', k], `node "${nid}" is in both "${claimed.get(nid)}" and "${gid}"`);
        else claimed.set(nid, gid);
      });
      walkGroups(g.groups, [...gp, 'groups']);
    });
  }
  walkGroups(doc.groups, ['groups']);

  /* from/to accept a list, which fans out into one connection per pair.
   * Error paths keep the AUTHORED index (and the position within the list), so
   * the editor underlines the id actually at fault. */
  const endsOf = v => Array.isArray(v) ? v : [v];
  const connections = Array.isArray(doc.connections) ? doc.connections : [];
  connections.forEach((l,i)=>{
    if (!l || l.from == null || l.to == null) { err(['connections', i], `connections[${i}]: needs from + to`); return; }
    for (const end of ['from', 'to']){
      const isList = Array.isArray(l[end]), ids = endsOf(l[end]);
      if (isList && !ids.length){
        err(['connections', i, end], `connections[${i}]: ${end} is an empty list`);
        continue;
      }
      ids.forEach((id, k) => {
        const path = isList ? ['connections', i, end, k] : ['connections', i, end];
        if (id == null || typeof id === 'object'){
          err(path, `connections[${i}]: ${end} must be an id, or a list of ids`);
          return;
        }
        if (!nodeMap.has(String(id)) && !groupMap.has(String(id)))
          err(path, `connections[${i}]: unknown endpoint "${id}"`);
      });
    }
  });

  const viewIds = new Set();
  (Array.isArray(doc.views) ? doc.views : []).forEach((v, i) => {
    if (!v || v.id == null) { err(['views', i], `views[${i}]: missing id`); return; }
    const vid = String(v.id);
    if (viewIds.has(vid)) err(['views', i, 'id'], `duplicate view id "${vid}"`);
    viewIds.add(vid);
    if (badTags(v.tags))
      err(['views', i, 'tags'], `view "${vid}": tags must be a scalar or a list of scalars`);
    if (v.focus != null && !nodeMap.has(String(v.focus)) && !groupMap.has(String(v.focus)))
      err(['views', i, 'focus'], `view "${vid}": unknown focus "${v.focus}"`);
    if (v.depth != null && !Number.isFinite(Number(v.depth)))
      err(['views', i, 'depth'], `view "${vid}": depth must be a number`);
  });

  if (errors.length){
    const e = new Error(errors.map(x => x.message).join('\n'));
    e.isSpec = true; e.errors = errors;
    throw e;
  }

  /* ---- desugar list endpoints, HERE and nowhere later ----
   * Every lens (filterDoc, focusDoc, diffDocs) matches endpoints with
   * String(l.to). A list would stringify to "a,b", match no id, and silently
   * drop the edge — and diffDocs would key the whole line, reporting a grown
   * list as one rewritten rule instead of one added rule. Expanding before any
   * of them runs means they all keep seeing simple pairs and need no changes.
   *
   * Each pair carries a NON-ENUMERABLE back-pointer to the connection that
   * authored it, so click-to-source can find the YAML line while canon() and
   * JSON.stringify stay blind to it (an enumerable key would make compare
   * report phantom changes). Never overwrite one that already exists:
   * specFromDoc runs again on narrowed documents whose connection objects are
   * the SAME references, and that would rewrite authored indices into
   * narrowed ones. */
  const tag = (conn, i) => {
    if (conn._src === undefined)
      Object.defineProperty(conn, '_src', { value: i, enumerable: false, configurable: true });
    return conn;
  };
  const expanded = [];
  connections.forEach((l, i) => {
    /* Key off "was a list written?", NOT "did it expand to one pair?" — a
     * single-element `to: [w1]` must still be rewritten to a scalar, or the
     * array survives into the document and canon() sees ["w1"] != "w1",
     * reporting a phantom change in compare. */
    if (!Array.isArray(l.from) && !Array.isArray(l.to)){ expanded.push(tag(l, i)); return; }
    for (const f of endsOf(l.from)) for (const t of endsOf(l.to)){
      if (String(f) === String(t)) continue;      // a cross product can pair an id with itself
      expanded.push(tag({ ...l, from: f, to: t }, i));
    }
  });
  /* a document without lists keeps its identity, so nothing downstream that
   * compares docs by reference changes behaviour */
  const same = expanded.length === connections.length && expanded.every((c, k) => c === connections[k]);
  return { doc: same ? doc : { ...doc, connections: expanded }, nodeMap, groupMap, claimed, hosted };
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
  function findNode(list, id){        // nodes nest, so search every depth
    for (const n of (list && list.kind === 'seq') ? list.items : []){
      if (idOf(n) === id) return n;
      const sub = findNode(treeGet(n, 'nodes'), id);
      if (sub) return sub;
    }
    return null;
  }
  function itemRange(kind, key){
    let n = null;
    if (kind === 'node') n = findNode(treeGet(root, 'nodes'), key);
    else if (kind === 'group') n = findGroup(treeGet(root, 'groups'), key);
    else if (kind === 'connection') n = (treeGet(root, 'connections')?.items || [])[key];
    return n ? { from:n.from, to:n.to } : null;
  }
  /* what the cursor is on: a node / group / connection item, or a member id
   * inside a group's nodes: list (that node) */
  function itemAt(pos){
    /* innermost wins: the cursor on a child picks the child, not its host */
    function inNodes(list){
      for (const it of (list && list.kind === 'seq') ? list.items : []){
        if (!inside(it, pos)) continue;
        const deeper = inNodes(treeGet(it, 'nodes'));
        if (deeper) return deeper;
        return idOf(it) ? { kind:'node', id:idOf(it) } : null;
      }
      return null;
    }
    const onNode = inNodes(treeGet(root, 'nodes'));
    if (onNode) return onNode;
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
  walkNodes(doc?.nodes, n => tagsOf(n).forEach(t => out.add(t)));
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
  const keep = new Set(), grouped = new Set(), pruned = new Map();
  /* A node survives when it is tagged, inherits a tag from its host or group,
   * or still has a surviving child. Leaf nodes are kept BY REFERENCE; only a
   * host whose child list actually changed is rebuilt. */
  function pruneNode(n, on){
    if (!n || n.id == null) return null;
    const inTag = on || hit(n);
    const kids = childrenOf(n);
    const kept = kids.map(k => pruneNode(k, inTag)).filter(Boolean);
    if (!inTag && !kept.length) return null;
    keep.add(String(n.id));
    return kids.length ? { ...n, nodes: kept } : n;
  }
  function walk(list, on){
    return (list || []).flatMap(g => {
      if (!g || g.id == null) return [];
      const inTag = on || hit(g);
      (g.nodes || []).forEach(id => grouped.add(String(id)));
      const nodes = (g.nodes || []).filter(id => {
        const p = pruneNode(byId.get(String(id)), inTag);
        if (p) pruned.set(String(id), p);
        return !!p;
      });
      const groups = walk(g.groups, inTag);
      if (!inTag && !nodes.length && !groups.length) return [];
      keep.add(String(g.id));
      return [{ ...g, nodes, groups }];
    });
  }
  const groups = walk(doc.groups, false);
  for (const [id, n] of byId){
    if (grouped.has(id)) continue;
    const p = pruneNode(n, false);
    if (p) pruned.set(id, p);
  }
  return withoutViews({
    ...doc,
    nodes: (doc.nodes || []).filter(n => n && pruned.has(String(n.id))).map(n => pruned.get(String(n.id))),
    groups,
    connections: (doc.connections || []).filter(l => l && keep.has(String(l.from)) && keep.has(String(l.to)))
  });
}

/* ---------------- views ----------------
 * One document, many pictures of it: an L3 overview, a per-zone detail, one
 * application's flow. A view narrows the doc and may override render options,
 * so every picture stays derived from the same model instead of drifting apart
 * in copied files. Narrowing runs tags first, then focus. */
const viewsOf = doc => (Array.isArray(doc?.views) ? doc.views.filter(v => v && v.id != null) : []);
const viewById = (doc, id) => viewsOf(doc).find(v => String(v.id) === String(id)) || null;

/* Keep `focusId` with everything inside it, plus whatever sits within `depth`
 * connection hops. Hops are counted over the connection graph as written, so a
 * group endpoint is one hop like any other. */
function focusDoc(doc, spec, focusId, depth = 1){
  const { nodeMap, groupMap, hosted } = spec;
  const start = String(focusId);
  if (!nodeMap.has(start) && !groupMap.has(start)) return doc;

  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const l of doc.connections || []){
    if (!l || l.from == null || l.to == null) continue;
    link(String(l.from), String(l.to));
    link(String(l.to), String(l.from));
  }
  const near = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < Math.max(0, Number(depth) || 0); d++){
    const next = [];
    for (const cur of frontier)
      for (const nb of adj.get(cur) || [])
        if (!near.has(nb)){ near.add(nb); next.push(nb); }
    frontier = next;
  }

  /* whatever is reached brings its contents along: a group its whole subtree,
   * a host its guests */
  const keep = new Set();
  const addNode = n => { if (!n || n.id == null) return; keep.add(String(n.id)); childrenOf(n).forEach(addNode); };
  const addGroup = g => {
    if (!g || g.id == null) return;
    keep.add(String(g.id));
    (g.nodes || []).forEach(id => addNode(nodeMap.get(String(id))));
    (g.groups || []).forEach(addGroup);
  };
  for (const id of near){
    if (groupMap.has(id)) addGroup(groupMap.get(id));
    else addNode(nodeMap.get(id));
  }
  /* A kept guest needs the host that DRAWS it: nodes are pruned from the
   * top-level list down, so dropping the host would drop the guest with it and
   * leave connections pointing at a node that is no longer there. Pull in the
   * whole host chain; each host survives as a shell holding only kept guests
   * (filterDoc does the same for tags). */
  for (const id of [...keep]){
    const seen = new Set();
    let h = hosted && hosted.get(id);
    while (h && !seen.has(h)){ seen.add(h); keep.add(h); h = hosted.get(h); }
  }

  const pruneNodes = list => (list || []).filter(n => n && keep.has(String(n.id)))
    .map(n => childrenOf(n).length ? { ...n, nodes: pruneNodes(n.nodes) } : n);
  const pruneGroups = list => (list || []).flatMap(g => {
    if (!g || g.id == null) return [];
    const nodes = (g.nodes || []).filter(id => keep.has(String(id)));
    const groups = pruneGroups(g.groups);
    if (!keep.has(String(g.id)) && !nodes.length && !groups.length) return [];
    return [{ ...g, nodes, groups }];
  });
  return withoutViews({
    ...doc,
    nodes: pruneNodes(doc.nodes),
    groups: pruneGroups(doc.groups),
    connections: (doc.connections || []).filter(l => l && keep.has(String(l.from)) && keep.has(String(l.to)))
  });
}

/* Narrow `doc` to `view` and fold its option overrides into diagram, so the
 * rest of the pipeline (buildElk direction, renderSVG theme/title) needs no
 * knowledge of views at all. Connection objects stay by reference. */
function applyView(doc, view, spec){
  if (!view) return doc;
  let out = doc;
  if (view.tags != null) out = filterDoc(out, [].concat(view.tags).map(String));
  if (view.focus != null) out = focusDoc(out, spec, view.focus, view.depth ?? 1);
  const over = {};
  for (const k of ['title', 'direction', 'theme']) if (view[k] != null) over[k] = view[k];
  if (Object.keys(over).length) out = { ...out, diagram: { ...(out.diagram || {}), ...over } };
  return withoutViews(out);
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
  /* nodes nest, so both maps are flat over every depth (parents first) and a
   * second map records which node each one sits inside */
  const byId = doc => { const m = new Map(); walkNodes(doc.nodes, n => { if (n.id != null) m.set(String(n.id), n); }); return m; };
  const hostOf = doc => { const m = new Map(); walkNodes(doc.nodes, (n, host) => { if (n.id != null && host) m.set(String(n.id), String(host.id)); }); return m; };
  const bNodes = byId(base), cNodes = byId(cur);
  const bHost = hostOf(base), cHost = hostOf(cur);
  const bGroups = flatGroups(base), cGroups = flatGroups(cur);
  const bMember = memberOf(bGroups), cMember = memberOf(cGroups);
  const status = { nodes:new Map(), groups:new Map(), connections:new Map() };
  const counts = { added:0, removed:0, changed:0 };
  const mark = (map, key, s) => { map.set(key, s); counts[s]++; };

  /* merged doc: deep copy of the current groups so re-parenting can't touch cur */
  const copyGroups = list => (list || []).map(g => (g && typeof g === 'object')
    ? { ...g, nodes:[...(g.nodes || [])], groups:copyGroups(g.groups) } : g);
  const copyNodes = list => (list || []).map(n => (n && typeof n === 'object' && childrenOf(n).length)
    ? { ...n, nodes:copyNodes(n.nodes) } : n);
  const doc = { ...cur, nodes:copyNodes(cur.nodes), groups:copyGroups(cur.groups), connections:[...(cur.connections || [])] };
  const merged = flatGroups(doc);
  const mergedNodes = new Map();
  walkNodes(doc.nodes, n => { if (n.id != null) mergedNodes.set(String(n.id), n); });
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
  /* a host's own change is judged without its children — each child carries
   * its own status, so a changed VM must not also repaint its hypervisor */
  const stripKids = x => canon({ ...x, nodes: undefined });
  for (const [id, n] of cNodes){
    const b = bNodes.get(id);
    if (!b) mark(status.nodes, id, 'added');
    else if (stripKids(b) !== stripKids(n) || bMember.get(id) !== cMember.get(id)
             || bHost.get(id) !== cHost.get(id)) mark(status.nodes, id, 'changed');
  }
  for (const [id, n] of bNodes){      // walk order: hosts before their children
    if (cNodes.has(id)) continue;
    mark(status.nodes, id, 'removed');
    if (taken.has(id)) continue;
    const copy = childrenOf(n).length ? { ...n, nodes:[] } : n;
    const inside = bHost.has(id) && mergedNodes.get(bHost.get(id));
    if (inside) (inside.nodes = inside.nodes || []).push(copy);   // back inside its old host
    else {
      doc.nodes.push(copy);
      const host = bMember.has(id) && merged.get(bMember.get(id));
      if (host) host.g.nodes.push(id);
    }
    mergedNodes.set(id, copy);
    taken.add(id);
  }

  const connKeys = list => {
    const seen = new Map();
    return (list || []).map(l => {
      const k = l ? String(l.from) + '\u0000' + String(l.to) : '';
      const nth = seen.get(k) || 0; seen.set(k, nth + 1);
      return k + '\u0000' + nth;
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

/* ---------------- architecture lint ----------------
 * parseSpec decides whether a document is well FORMED; lintSpec decides whether
 * the network it describes is COHERENT — an address in no declared subnet, the
 * same IP twice, a pair both blocked and allowed. Findings are non-fatal and
 * carry a document path, like validation errors, so an editor can place them.
 *   severity 'error'   — a contradiction in the model
 *   severity 'warning' — hygiene; the renderer degrades silently without it
 * Deliberately NOT checked: whether a connection crossing a trust boundary
 * passes a firewall. Connections are direct edges, not routes, so there is no
 * path to inspect — the check would be guesswork and fire on most documents. */
const ipToInt = s => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
  if (!m) return null;                       // not IPv4 (v6 / hostname): not checked
  const p = m.slice(1).map(Number);
  return p.some(x => x > 255) ? null : (p[0]*16777216 + p[1]*65536 + p[2]*256 + p[3]) >>> 0;
};
const parseCidr = s => {
  const m = /^(.+)\/(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const base = ipToInt(m[1]), bits = Number(m[2]);
  if (base == null || bits > 32) return null;
  const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
  return { net:(base & mask) >>> 0, mask, bits };
};
const ipInCidr = (ip, c) => ((ip & c.mask) >>> 0) === c.net;
const cidrsOverlap = (a, b) => ((a.net & b.mask) >>> 0) === b.net || ((b.net & a.mask) >>> 0) === a.net;

function lintSpec(spec){
  const { doc, nodeMap, groupMap, claimed, hosted } = spec;
  const findings = [];
  const add = (rule, severity, path, message) => findings.push({ rule, severity, path, message });

  /* document paths, so a finding can be placed in the source like an error */
  const nodePath = new Map(), groupPath = new Map(), gParent = new Map();
  (function walk(list, path){
    (list||[]).forEach((n,i) => {
      if (!n || n.id == null) return;
      nodePath.set(String(n.id), [...path, i]);
      walk(n.nodes, [...path, i, 'nodes']);
    });
  })(doc.nodes, ['nodes']);
  (function walk(list, path, parent){
    (list||[]).forEach((g,i) => {
      if (!g || g.id == null) return;
      const p = [...path, i];
      groupPath.set(String(g.id), p);
      gParent.set(String(g.id), parent);
      walk(g.groups, [...p, 'groups'], String(g.id));
    });
  })(doc.groups, ['groups'], null);

  /* the group a node belongs to, following its host chain out first */
  const ownerGroup = id => {
    let cur = id; const seen = new Set();
    while (hosted && hosted.has(cur) && !seen.has(cur)){ seen.add(cur); cur = hosted.get(cur); }
    return claimed.get(cur);
  };
  /* nearest ancestor group that declares a cidr */
  const nearestCidr = gid => {
    let g = gid; const seen = new Set();
    while (g && !seen.has(g)){
      seen.add(g);
      const o = groupMap.get(g);
      if (o && o.cidr != null){ const c = parseCidr(o.cidr); if (c) return { gid:g, cidr:c, raw:String(o.cidr) }; }
      g = gParent.get(g);
    }
    return null;
  };
  const declared = [...groupMap].map(([id, g]) => {
    const c = g.cidr == null ? null : parseCidr(g.cidr);
    return c ? { id, cidr:c, raw:String(g.cidr) } : null;
  }).filter(Boolean);

  /* --- addresses --- */
  const seenIp = new Map();
  for (const [id, n] of nodeMap){
    for (const raw of ipListOf(n)){
      const ip = ipToInt(raw);
      if (ip == null) continue;
      if (seenIp.has(raw))
        add('duplicate-ip', 'error', nodePath.get(id),
          `"${id}" and "${seenIp.get(raw)}" both use ${raw}`);
      else seenIp.set(raw, id);
      const g = ownerGroup(id), near = g ? nearestCidr(g) : null;
      /* an address outside its own subnet is fine when some OTHER declared
       * subnet holds it — that is a dual-homed interface, not a typo */
      if (near && !ipInCidr(ip, near.cidr) && !declared.some(d => ipInCidr(ip, d.cidr)))
        add('ip-outside-cidr', 'error', nodePath.get(id),
          `"${id}" has ${raw}, which is in no declared subnet (its group "${near.gid}" is ${near.raw})`);
    }
  }
  for (let i = 0; i < declared.length; i++)
    for (let j = i + 1; j < declared.length; j++){
      const a = declared[i], b = declared[j];
      const nested = (x, y) => { let c = y, s = new Set(); while (c && !s.has(c)){ if (c === x) return true; s.add(c); c = gParent.get(c); } return false; };
      if (nested(a.id, b.id) || nested(b.id, a.id)) continue;   // a subnet inside its supernet
      if (cidrsOverlap(a.cidr, b.cidr))
        add('cidr-overlap', 'error', groupPath.get(a.id),
          `"${a.id}" ${a.raw} overlaps "${b.id}" ${b.raw}`);
    }

  /* --- vocabulary that degrades silently --- */
  for (const [id, n] of nodeMap)
    for (const key of ['type', 'icon']){
      const v = n[key];
      if (v == null) continue;
      if (!GLYPHS[resolveKey(v)])
        add(`unknown-${key}`, 'warning', nodePath.get(id),
          `"${id}" has ${key}: ${v}, which draws no glyph`);
    }
  for (const [id, g] of groupMap){
    if (g.class == null) continue;
    if (!Object.hasOwn(GROUP_STYLES, String(g.class).toLowerCase().trim()))
      add('unknown-class', 'warning', groupPath.get(id),
        `"${id}" has class: ${g.class}, which falls back to the default styling`);
  }

  /* --- connections --- */
  const endpoints = new Set((doc.connections||[]).flatMap(l => l ? [String(l.from), String(l.to)] : []));
  const allowed = new Set(), blocked = new Map();
  /* connections are expanded by now, so report against the line the author
   * actually wrote (_src) rather than the position after fan-out */
  const at = (l, i) => (l && l._src !== undefined) ? l._src : i;
  (doc.connections||[]).forEach((l, i) => {
    if (!l) return;
    if (String(l.from) === String(l.to))
      add('self-connection', 'error', ['connections', at(l, i)],
        `connections[${at(l, i)}] joins "${l.from}" to itself`);
    const key = [String(l.from), String(l.to)].sort().join('\u0000');
    if (dirOf(l) === 'none'){ if (!blocked.has(key)) blocked.set(key, at(l, i)); }
    else allowed.add(key);
  });
  for (const [key, i] of blocked)
    if (allowed.has(key))
      add('blocked-contradiction', 'error', ['connections', i],
        `"${key.split('\u0000').join('" and "')}" are both blocked and allowed`);

  /* --- reachability --- */
  const touched = n => endpoints.has(String(n.id)) || childrenOf(n).some(touched);
  for (const [id, n] of nodeMap){
    if (endpoints.has(id) || (hosted && hosted.has(id)) || touched(n)) continue;
    let g = ownerGroup(id), viaGroup = false; const seen = new Set();
    while (g && !seen.has(g)){ seen.add(g); if (endpoints.has(g)){ viaGroup = true; break; } g = gParent.get(g); }
    if (!viaGroup) add('isolated', 'warning', nodePath.get(id), `"${id}" has no connection`);
  }
  return findings;
}

/* ---------------- drift against a live inventory ----------------
 * Compares an IMPORTED document (Terraform state, an Ansible inventory, a
 * NetBox export) with the authored one and reports what no longer agrees.
 * Ids differ between the two — importers slugify hostnames — so nodes are
 * matched on id, then on any shared IP, then on label, case-insensitively.
 * Group membership is deliberately NOT compared: group identity is not stable
 * across importers, so "moved" would be guesswork. */
function driftReport(live, authored){
  const keysOf = n => {
    const out = [];
    if (n.id != null) out.push('id:' + String(n.id).toLowerCase());
    ipListOf(n).forEach(ip => out.push('ip:' + ip));
    if (n.label != null) out.push('label:' + String(n.label).toLowerCase());
    return out;
  };
  const index = list => {
    const m = new Map();
    list.forEach(n => keysOf(n).forEach(k => { if (!m.has(k)) m.set(k, n); }));
    return m;
  };
  const liveNodes = flatNodes(live), authoredNodes = flatNodes(authored);
  const authoredIx = index(authoredNodes), liveIx = index(liveNodes);
  const match = (n, ix) => { for (const k of keysOf(n)) { const hit = ix.get(k); if (hit) return hit; } return null; };

  const findings = [];
  const matched = new Set();
  for (const n of liveNodes){
    const hit = match(n, authoredIx);
    if (!hit){
      findings.push({ rule:'missing', id:String(n.id),
        message:`"${n.label ?? n.id}" exists in the inventory but not in the diagram` });
      continue;
    }
    matched.add(hit);
    const a = new Set(ipListOf(hit)), b = ipListOf(n);
    const added = b.filter(ip => !a.has(ip));
    if (added.length && a.size)
      findings.push({ rule:'address', id:String(hit.id),
        message:`"${hit.id}" is ${[...a].join(', ')} in the diagram but ${b.join(', ')} in the inventory` });
  }
  for (const n of authoredNodes)
    if (!matched.has(n) && !match(n, liveIx))
      findings.push({ rule:'extra', id:String(n.id),
        message:`"${n.id}" is in the diagram but not in the inventory` });
  return findings;
}

/* ---------------- firewall rules (Connections table) ---------------- */
/* One directed rule per connection; direction: both yields two, direction:
 * none (blocked) none. Pairs whose endpoints share the same immediate zone
 * (a node's parent group; a group is its own zone) need no rule. `conn` is
 * the connection index each rule came from. */
function connectionRules(spec){
  const { doc, nodeMap, groupMap, claimed, hosted } = spec;
  const connections = doc.connections || [];
  /* A hosted node's immediate container is its host, so the host is its zone:
   * guests on one hypervisor need no rule between them, exactly as members of
   * one group don't. Inheriting the host's GROUP instead would collapse every
   * guest in a rack into a single zone and silently drop real cross-host flows. */
  const zoneOf = id => groupMap.has(id) ? id
    : !nodeMap.has(id) ? undefined
    : hosted && hosted.has(id) ? hosted.get(id)
    : claimed.get(id);
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

/* padding between a container node's border and the children inside it */
const NODE_PAD = 14;
/* chrome size of container nodes, keyed by the ELK node object buildElk made.
 * ELK derives a compound node's size from its children, so a host whose own
 * chrome is wider than the child grid needs correcting once pass-1 geometry
 * exists (assignPorts). elkjs does NOT honor elk.nodeSize.minimum — every
 * encoding either ignores the width or corrupts the height — so this is the
 * supported way to impose one. */
const CHROME = new WeakMap();

function buildElk(spec){
  const { doc, nodeMap, claimed } = spec;
  const dirRaw = String(doc.diagram?.direction || 'down').toLowerCase();
  const direction = /right|lr/.test(dirRaw) ? 'RIGHT' : 'DOWN';

  /* A node carrying `nodes:` becomes an ELK compound node: its own chrome
   * (glyph, label, attribute lines) is reserved as top padding and the children
   * lay out underneath. Leaf nodes keep the exact shape they always had. */
  function elkNode(n){
    const m = nodeMetrics(n);
    const kids = childrenOf(n);
    if (!kids.length) return { id:String(n.id), width:m.w, height:m.h };
    const children = kids.map(elkNode);
    const layoutOptions = {
      'elk.padding': `[top=${m.h},left=${NODE_PAD},bottom=${NODE_PAD},right=${NODE_PAD}]`,
      ...ELK_SPACING,
      ...(kids.some(nodeTouched) ? {} : PACK_OPTIONS)
    };
    applyRanks(kids, children, layoutOptions);
    const node = { id:String(n.id), layoutOptions, children };
    CHROME.set(node, { w:m.w, top:m.h });
    return node;
  }
  /* Auto-packing: layered assigns every neighbor of a hub to the same layer, so
   * "hub -> group of N" renders the N members as one very wide row. When no
   * connection touches a group's INTERIOR (edges may end at the group itself),
   * the group can be laid out as SEPARATE_CHILDREN — safe because no edge
   * crosses its boundary to a member — which re-enables ELK's component packing
   * and grids the disconnected members near the root aspect ratio instead. */
  const endpoints = new Set((doc.connections||[]).flatMap(l => [String(l.from), String(l.to)]));
  /* a node is "touched" when it or anything nested inside it is an endpoint */
  const nodeTouched = n => endpoints.has(String(n.id)) || childrenOf(n).some(nodeTouched);
  function touchesInterior(g){
    return (g.nodes||[]).some(id => {
          const n = nodeMap.get(String(id));
          return n ? nodeTouched(n) : endpoints.has(String(id));
        })
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
  /* only top-level nodes sit at the root — nested ones are drawn by their host */
  const topNodes = (Array.isArray(doc.nodes) ? doc.nodes : []).filter(n => n && n.id != null);
  const looseNodes = topNodes.filter(n=>!claimed.has(String(n.id)));
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
/* Three fixes that need pass-1 geometry, applied to a fresh graph for pass 2:
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
  /* 3. container nodes: ELK sizes a compound node from its children, so a host
   *    whose own chrome is wider than the child grid would have its label spill
   *    out of the box. Pass-1 gives the natural width; reserve the shortfall as
   *    extra right padding for pass 2 (see CHROME). */
  (function fixContainers(n){
    for (const c of n.children||[]){
      const chrome = CHROME.get(c), box = abs[c.id];
      if (chrome && box){
        const grow = Math.ceil(chrome.w - (box.x1 - box.x0));
        if (grow > 0){
          c.layoutOptions = { ...(c.layoutOptions||{}),
            'elk.padding': `[top=${chrome.top},left=${NODE_PAD},bottom=${NODE_PAD},right=${NODE_PAD + grow}]` };
          assigned = true;
        }
      }
      fixContainers(c);
    }
  })(graph);

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

  let gGroups = '', gContainers = '', gNodes = '', gEdges = '', gLabels = '';

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
    const markup = `<g class="nd-node" data-id="${esc(id)}"${ds === 'removed' ? ' opacity=".5"' : ''}>
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${T.nodeFill}" stroke="${T.ink}" stroke-width="1.5"${borderDash}/>
      ${inner}${diffHalo(ds, b, 10)}
      ${glyph ? `<g transform="translate(${iconX},${b.y+9})"><g fill="none" stroke="${T.ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="${T.ink}">${glyph}</g></g>` : ''}
      ${type ? `<text x="${capX}" y="${b.y + (glyph ? 46 : 26)}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8.5" font-weight="700" letter-spacing=".5" fill="${T.muted}">${esc(type)}</text>` : ''}
      <text x="${tx}" y="${b.y + 22}" font-family="ui-monospace,Menlo,monospace" font-size="13" font-weight="600" fill="${T.text}">${esc(label)}</text>
      ${kvText}
      ${badge}${diffMark(ds, b.x, b.y)}
    </g>`;
    /* A node holding other nodes is a CONTAINER, and its box is opaque: painted
     * after the edges it would cover every edge routed inside it (an edge
     * between two of its guests is then invisible, leaving only its label).
     * Containers therefore paint with the groups, BEFORE the edges — exactly
     * as a group does — while leaf nodes still paint after, so edge ends stay
     * tucked under the box they terminate at. See gotcha 19. */
    if (childrenOf(n).length) gContainers += markup;
    else gNodes += markup;
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
      ${gGroups}${gContainers ? '\n      ' + gContainers : ''}
      ${gEdges}
      ${gNodes}
      ${gLabels}
    </g>
    ${stamp}
  </svg>`;
}

if (typeof module !== "undefined" && module.exports)
  module.exports = { parseSpec, specFromDoc, sourceMap, buildElk, assignPorts, renderSVG,
    allTags, filterDoc, diffDocs, flatNodes, lintSpec, driftReport,
    viewsOf, viewById, applyView, focusDoc,
    connectionRules, rulesToCsv, extractSource, encodeShare, decodeShare,
    CONNECTION_STYLES, GROUP_STYLES, GLYPHS, LABEL_PALETTE, THEMES,
    // helpers the browser app (concatenated after this file at build time) reuses
    esc, dirOf, ipsOf };
