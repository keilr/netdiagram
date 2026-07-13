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
const GROUP_STYLES = {
  zone:   { fill:'rgba(180,83,9,.05)',   stroke:'#c98a4b', dash:null,  label:'#9a5b17' },
  vlan:   { fill:'rgba(13,148,136,.05)', stroke:'#4fa9a0', dash:null,  label:'#0f766e' },
  subnet: { fill:'rgba(71,105,155,.06)', stroke:'#8aa2c4', dash:null,  label:'#3f5e8c' },
  cloud:  { fill:'rgba(124,58,237,.045)',stroke:'#a78bda', dash:'6 4', label:'#6d4fb3' },
  onprem: { fill:'rgba(60,72,88,.045)',  stroke:'#9aa6b4', dash:null,  label:'#4b5866' },
  trust:  { fill:'rgba(192,57,43,.03)',  stroke:'#d0685c', dash:'8 5', label:'#a83a2e' },
  default:{ fill:'rgba(60,72,88,.04)',   stroke:'#a8b2bd', dash:null,  label:'#5b6874' }
};

/* colors assigned to shared connection labels */
const LABEL_PALETTE = ['#0f766e','#7c3aed','#1d4ed8','#9d174d','#4d7c0f','#0e7490','#a21caf','#b45309'];

/* Named group colors (group style.color / style.colour) — a coordinated
 * fill/stroke/label scheme derived from one base hex, so every color shares the
 * same muted, blueprint feel. Names are CSS color names; the tint is toned down. */
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
  accelerator:'gpu', cuda:'gpu'
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
const NODE_KNOWN_KEYS = new Set(['id','label','type','icon','ip','ips','addr','os','tags']);
/* option keys control rendering; every other scalar key is a displayed attribute */
const DIAGRAM_OPTION_KEYS = new Set(['title','direction']);
const GROUP_KNOWN_KEYS = new Set(['id','label','class','cidr','nodes','groups','style']);
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
  const doc = jsyaml.load(text);
  if (!doc || typeof doc !== 'object') throw new Error('Empty document — define nodes and connections.');
  const errors = [];
  if (doc.links != null) errors.push('"links:" has been renamed — use "connections:" instead');
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  if (!nodes.length) errors.push('No nodes defined.');
  const nodeMap = new Map();
  nodes.forEach((n,i)=>{
    if (!n || !n.id) { errors.push(`nodes[${i}]: missing id`); return; }
    if (nodeMap.has(String(n.id))) errors.push(`duplicate node id "${n.id}"`);
    if (n.tags != null && (
        (typeof n.tags === 'object' && !Array.isArray(n.tags)) ||
        (Array.isArray(n.tags) && n.tags.some(t => t != null && typeof t === 'object'))))
      errors.push(`nodes[${i}] "${n.id}": tags must be a scalar or a list of scalars`);
    nodeMap.set(String(n.id), n);
  });

  const groupMap = new Map();
  const claimed = new Map(); // nodeId -> groupId
  function walkGroups(list, path){
    (list||[]).forEach((g,i)=>{
      if (!g || !g.id) { errors.push(`${path}[${i}]: group missing id`); return; }
      const gid = String(g.id);
      if (groupMap.has(gid) || nodeMap.has(gid)) errors.push(`duplicate id "${gid}"`);
      groupMap.set(gid, g);
      (g.nodes||[]).forEach(nid=>{
        nid = String(nid);
        if (!nodeMap.has(nid)) errors.push(`group "${gid}": unknown node "${nid}"`);
        else if (claimed.has(nid)) errors.push(`node "${nid}" is in both "${claimed.get(nid)}" and "${gid}"`);
        else claimed.set(nid, gid);
      });
      walkGroups(g.groups, `${path}[${i}].groups`);
    });
  }
  walkGroups(doc.groups, 'groups');

  const connections = Array.isArray(doc.connections) ? doc.connections : [];
  connections.forEach((l,i)=>{
    if (!l || l.from == null || l.to == null) { errors.push(`connections[${i}]: needs from + to`); return; }
    for (const end of [String(l.from), String(l.to)])
      if (!nodeMap.has(end) && !groupMap.has(end))
        errors.push(`connections[${i}]: unknown endpoint "${end}"`);
  });

  if (errors.length) { const e = new Error(errors.join('\n')); e.isSpec = true; throw e; }
  return { doc, nodeMap, groupMap, claimed };
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
  function elkGroup(g){
    const hdr = groupHeader(g);
    return {
      id:String(g.id),
      layoutOptions:{
        'elk.padding': `[top=${hdr.padTop},left=22,bottom=${hdr.padBottom},right=22]`,
        ...ELK_SPACING
      },
      children:[
        ...(g.nodes||[]).map(id => elkNode(nodeMap.get(String(id)))),
        ...(g.groups||[]).map(elkGroup)
      ]
    };
  }
  const rootChildren = [
    ...(doc.groups||[]).map(elkGroup),
    ...[...nodeMap.values()].filter(n=>!claimed.has(String(n.id))).map(elkNode)
  ];
  const edges = (doc.connections||[]).map((l,i)=>({ id:edgeId(i), sources:[String(l.from)], targets:[String(l.to)] }));

  return {
    id:'root',
    layoutOptions:{
      'elk.algorithm':'layered',
      'elk.direction':direction,
      'elk.hierarchyHandling':'INCLUDE_CHILDREN',
      'elk.spacing.componentComponent':'64',
      'elk.edgeRouting':'ORTHOGONAL',
      'elk.spacing.edgeLabel':'8',
      'elk.padding':'[top=16,left=16,bottom=16,right=16]',
      ...ELK_SPACING
    },
    children:rootChildren,
    edges
  };
}

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

function renderSVG(spec, layout){
  const { doc, nodeMap, groupMap } = spec;
  const title = String(doc.diagram?.title || 'untitled network');

  // connections with the same label share a palette color
  const labelColor = new Map();
  for (const l of (doc.connections||[])){
    if (l.label != null && !labelColor.has(String(l.label)))
      labelColor.set(String(l.label), LABEL_PALETTE[labelColor.size % LABEL_PALETTE.length]);
  }
  function styleOf(l){
    if (l.label != null) return { ...CONNECTION_STYLES.labeled, hex: labelColor.get(String(l.label)) };
    return CONNECTION_STYLES.default;
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
  const dAttrs = attrLines(doc.diagram, DIAGRAM_OPTION_KEYS);
  const attrKeyW = dAttrs.length ? Math.max(...dAttrs.map(([k]) => textW(k.toUpperCase(), '700 9px ui-monospace'))) : 0;
  const attrValW = dAttrs.length ? Math.max(...dAttrs.map(([,v]) => textW(v, '10px ui-monospace'))) : 0;
  const stampW = Math.max(232, Math.ceil(9 + attrKeyW + 24 + attrValW + 9));
  const stampH = 54 + dAttrs.length*16;
  const PAD = 26;
  const totW = W + PAD*2, totH = H + PAD*2 + stampH + 14;

  let defs = `
    <pattern id="gridS" width="12" height="12" patternUnits="userSpaceOnUse">
      <path d="M12 0H0v12" fill="none" stroke="#e7ece2" stroke-width=".6"/>
    </pattern>
    <pattern id="gridL" width="60" height="60" patternUnits="userSpaceOnUse">
      <rect width="60" height="60" fill="url(#gridS)"/>
      <path d="M60 0H0v60" fill="none" stroke="#dde3d7" stroke-width="1"/>
    </pattern>`;
  const markerHexes = [...new Set((doc.connections||[]).map(l => styleOf(l).hex))];
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
    const bName = String(gs.border ?? '').toLowerCase().trim();
    const dashVal = (bName in GROUP_BORDERS) ? GROUP_BORDERS[bName] : st.dash;
    const dash = dashVal ? ` stroke-dasharray="${dashVal}"` : '';
    const hdr = groupHeader(g);
    // cidr + attributes live in a small info box in the bottom-right corner
    let boxText = '';
    if (hdr.box){
      const bx = b.x + b.w - GBOX_MARGIN - hdr.box.w, by = b.y + b.h - GBOX_MARGIN - hdr.box.h;
      boxText = `<rect class="attr-box" x="${bx}" y="${by}" width="${hdr.box.w}" height="${hdr.box.h}" rx="3" fill="#ffffff" fill-opacity=".8" stroke="${st.stroke}" stroke-width=".9"/>`
        + hdr.box.lines.map(([k,v],i) =>
          `<text x="${bx+GBOX_PAD}" y="${by + 16 + i*GBOX_LINE_H}" font-family="ui-monospace,Menlo,monospace" font-size="10.5" fill="${st.label}"><tspan opacity=".6">${esc(k)}: </tspan><tspan opacity=".9">${esc(v)}</tspan></text>`).join('');
    }
    gGroups += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.4"${dash}/>
      <text x="${b.x+14}" y="${b.y+hdr.labelY}" font-family="ui-monospace,Menlo,monospace" font-size="11" font-weight="700" letter-spacing="1.6" fill="${st.label}">${esc(String(g.label||id).toUpperCase())}</text>
      ${boxText}`;
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
      ? `<rect x="${b.x+3}" y="${b.y+3}" width="${b.w-6}" height="${b.h-6}" rx="4" fill="none" stroke="#24344d" stroke-width=".8"/>` : '';
    // tag pills: right-aligned block in the corner, up to two per row
    let badge = '';
    pillRows.forEach((row, r) => {
      let px = b.x + b.w - 7 - pillRowW(row);
      const py = b.y + 6 + r * PILL_ROW_H;
      for (const p of row){
        badge += `<rect x="${px}" y="${py}" width="${p.w}" height="${PILL_H}" rx="6" fill="#eef1f4" stroke="#9aa7ba" stroke-width=".8"/>
      <text x="${px+p.w/2}" y="${py+9}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8" font-weight="700" letter-spacing=".8" fill="#5b6874">${esc(p.text)}</text>`;
        px += p.w + PILL_GAP;
      }
    });
    const kvText = kv.map(([k,v],i) =>
      `<text x="${tx}" y="${b.y + 38 + i*14}" font-family="ui-monospace,Menlo,monospace" font-size="10.5"><tspan fill="#7a8798">${esc(k)}: </tspan><tspan fill="#3f5e8c">${esc(v)}</tspan></text>`
    ).join('');
    gNodes += `<g>
      <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="#ffffff" stroke="#24344d" stroke-width="1.5"${borderDash}/>
      ${inner}
      ${glyph ? `<g transform="translate(${iconX},${b.y+9})"><g fill="none" stroke="#24344d" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="#24344d">${glyph}</g></g>` : ''}
      ${type ? `<text x="${capX}" y="${b.y + (glyph ? 46 : 26)}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8.5" font-weight="700" letter-spacing=".5" fill="#7a8798">${esc(type)}</text>` : ''}
      <text x="${tx}" y="${b.y + 22}" font-family="ui-monospace,Menlo,monospace" font-size="13" font-weight="600" fill="#1a2638">${esc(label)}</text>
      ${kvText}
      ${badge}
    </g>`;
  }

  // edges — ELK places hierarchical edges relative to a container node; offset to absolute
  const allEdges = [];
  (function collectEdges(node){
    (node.edges||[]).forEach(e => allEdges.push(e));
    (node.children||[]).forEach(collectEdges);
  })(layout);
  const offsetOf = id => (!id || id==='root') ? {x:0,y:0} : (abs.get(id) || {x:0,y:0});
  allEdges.forEach(e=>{
    const l = (doc.connections||[])[edgeIndex(e.id)] || {};
    const st = styleOf(l);
    const mk = 'ah-' + st.hex.slice(1);
    const sec = (e.sections||[])[0]; if (!sec) return;
    const off = offsetOf(e.container);
    const pts = [sec.startPoint, ...(sec.bendPoints||[]), sec.endPoint]
      .map(p => ({ x: p.x + off.x, y: p.y + off.y }));
    const d = 'M' + pts.map(p=>`${p.x} ${p.y}`).join(' L');
    const dirMode = dirOf(l);
    const mEnd = dirMode==='none' ? '' : ` marker-end="url(#${mk})"`;
    const mStart = dirMode==='both' ? ` marker-start="url(#${mk})"` : '';
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : '';
    const lblAttr = l.label != null ? ` data-label="${esc(String(l.label))}"` : '';
    gEdges += `<path class="edge"${lblAttr} d="${d}" fill="none" stroke="${st.hex}" stroke-width="${st.width}"${dash}${mEnd}${mStart}/>`;
    if (l.label){
      const m = midOfPolyline(pts);
      gLabels += `<text class="edge-lbl" data-label="${esc(String(l.label))}" x="${m.x}" y="${m.y-5}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="11" fill="${st.hex}" stroke="#fafbf7" stroke-width="4" paint-order="stroke" stroke-linejoin="round">${esc(String(l.label))}</text>`;
    }
  });

  // drafting title block
  const sx = totW - stampW - 18, sy = totH - stampH - 14;
  const today = new Date().toISOString().slice(0,10);
  const attrRows = dAttrs.map(([k,v],i)=>{
    const ry = sy + 54 + i*16;
    return `<path d="M${sx} ${ry} h${stampW}" stroke="#24344d" stroke-width=".7"/>
    <text x="${sx+9}" y="${ry+12}" font-family="ui-monospace,Menlo,monospace" font-size="9" letter-spacing="1" fill="#7a8798">${esc(k.toUpperCase())}</text>
    <text x="${sx+stampW-9}" y="${ry+12}" text-anchor="end" font-family="ui-monospace,Menlo,monospace" font-size="10" fill="#24344d">${esc(v)}</text>`;
  }).join('');
  const stamp = `<g>
    <rect x="${sx}" y="${sy}" width="${stampW}" height="${stampH}" fill="#ffffff" stroke="#24344d" stroke-width="1.4"/>
    <path d="M${sx} ${sy+20} h${stampW} M${sx+150} ${sy+20} V${sy+54}" stroke="#24344d" stroke-width="1"/>
    <text x="${sx+9}" y="${sy+14.5}" font-family="ui-monospace,Menlo,monospace" font-size="10.5" font-weight="700" letter-spacing="1.2" fill="#24344d">${esc(title.toUpperCase())}</text>
    <text x="${sx+9}" y="${sy+37}" font-family="ui-monospace,Menlo,monospace" font-size="9" letter-spacing="1" fill="#7a8798">DRAWN</text>
    <text x="${sx+9}" y="${sy+48}" font-family="ui-monospace,Menlo,monospace" font-size="10" fill="#24344d">netdiagram${VERSION ? ' v' + esc(VERSION) : ''}</text>
    <text x="${sx+159}" y="${sy+37}" font-family="ui-monospace,Menlo,monospace" font-size="9" letter-spacing="1" fill="#7a8798">DATE</text>
    <text x="${sx+159}" y="${sy+48}" font-family="ui-monospace,Menlo,monospace" font-size="10" fill="#24344d">${today}</text>
    ${attrRows}
  </g>`;

  const nc = nodeMap.size, gc = groupMap.size, cc = (doc.connections||[]).length;
  const desc = `${nc} node${nc!==1?'s':''}, ${gc} group${gc!==1?'s':''}, ${cc} connection${cc!==1?'s':''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="nd-title nd-desc" width="${totW}" height="${totH}" viewBox="0 0 ${totW} ${totH}" font-family="ui-monospace,Menlo,monospace">
    <title id="nd-title">${esc(title)}</title>
    <desc id="nd-desc">${esc(desc)}</desc>
    <defs>${defs}</defs>
    <rect width="${totW}" height="${totH}" fill="#fafbf7"/>
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
  module.exports = { parseSpec, buildElk, renderSVG, CONNECTION_STYLES, GROUP_STYLES, GLYPHS, LABEL_PALETTE,
    // helpers the browser app (concatenated after this file at build time) reuses
    esc, dirOf, ipsOf };
