"use strict";
/* ---------------- wire up ---------------- */
const $ = s => document.querySelector(s);
const elk = new ELK();
const statusEl = $('#status'), canvasEl = $('#canvas-pane'), connEl = $('#connections-pane');
let renderSeq = 0;
let lastCsv = '';
let lastSpec = null;   // last successfully rendered spec (the SVG on screen)

/* ---------------- connections table ---------------- */
function renderConnections(spec){
  const { doc, nodeMap, groupMap, claimed } = spec;
  const connections = doc.connections || [];

  /* A node's zone is its immediate parent group id (undefined if top-level).
   * A group endpoint is its own zone.
   * Connections where both ends share the same zone need no firewall rule. */
  function zoneOf(id){
    if (nodeMap.has(id)) return claimed.get(id);  // undefined = top-level / no group
    if (groupMap.has(id)) return id;              // group is its own zone boundary
    return undefined;
  }
  const filtered = connections.filter(l => {
    const fz = zoneOf(String(l.from)), tz = zoneOf(String(l.to));
    return fz === undefined || tz === undefined || fz !== tz;
  });
  const excluded = connections.length - filtered.length;

  if (!filtered.length){
    connEl.innerHTML = '<p class="conn-empty">All connections are within the same zone — no firewall rules needed.</p>';
    lastCsv = '';
    return;
  }
  function endpoint(id){
    id = String(id);
    const n = nodeMap.get(id);
    if (n) return { name: String(n.label ?? id), addr: ipsOf(n) || '—' };
    const g = groupMap.get(id);
    if (g) return { name: String(g.label ?? id), addr: g.cidr ? String(g.cidr) : '—' };
    return { name: id, addr: '—' };
  }
  const csvRows = [['#','Source','Src Address','Dir','Destination','Dst Address','Protocol','Port','Label']];
  const rows = filtered.map((l, i) => {
    const from  = endpoint(l.from);
    const to    = endpoint(l.to);
    const dir   = dirOf(l);
    const dirG  = dir === 'both' ? '↔' : dir === 'none' ? '─' : '→';
    const proto = l.protocol != null ? String(l.protocol) : '';
    const port  = l.port  != null ? String(l.port)  : '';
    const label = l.label != null ? String(l.label) : '';
    const dash  = '<span class="conn-dash">—</span>';
    csvRows.push([i+1, from.name, from.addr, dirG, to.name, to.addr, proto, port, label]);
    return `<tr>
      <td class="conn-n">${i+1}</td>
      <td>${esc(from.name)}</td><td class="conn-addr">${esc(from.addr)}</td>
      <td class="conn-dir">${dirG}</td>
      <td>${esc(to.name)}</td><td class="conn-addr">${esc(to.addr)}</td>
      <td class="conn-proto">${proto ? esc(proto).toUpperCase() : dash}</td>
      <td class="conn-port">${port ? esc(port) : dash}</td>
      <td class="conn-label">${label ? esc(label) : ''}</td>
    </tr>`;
  }).join('');

  lastCsv = csvRows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');

  const excl = excluded ? `<span class="conn-excl">${excluded} same-zone excluded</span>` : '';
  connEl.innerHTML = `
    <div class="conn-toolbar">
      <h2>Connections &mdash; ${filtered.length} rule${filtered.length !== 1 ? 's' : ''} ${excl}</h2>
      <button id="btn-copy-csv">Copy CSV</button>
    </div>
    <table class="conn-table">
      <thead><tr>
        <th>#</th><th>Source</th><th>Address</th><th></th>
        <th>Destination</th><th>Address</th><th>Protocol</th><th>Port</th><th>Label</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* Copy CSV — delegated since connEl content is replaced on each render */
connEl.addEventListener('click', e => {
  if (!e.target.matches('#btn-copy-csv')) return;
  const btn = e.target;
  navigator.clipboard.writeText(lastCsv).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy CSV'; }, 1500);
  });
});

/* ---------------- pane splitter ---------------- */
/* Drag resizes the editor pane (width in the row layout, height in the
 * stacked <=760px layout); double-click resets to the CSS default. */
const splitter = $('#splitter'), mainEl = $('main');
const stacked = () => matchMedia('(max-width:760px)').matches;
splitter.addEventListener('pointerdown', e => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  const move = ev => {
    const r = mainEl.getBoundingClientRect();
    if (stacked()){
      const h = Math.min(Math.max(ev.clientY - r.top, 120), r.height - 120);
      mainEl.style.setProperty('--editor-h', h + 'px');
    } else {
      const w = Math.min(Math.max(ev.clientX - r.left, 220), r.width - 320);
      mainEl.style.setProperty('--editor-w', w + 'px');
    }
  };
  const up = () => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', up);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});
splitter.addEventListener('dblclick', () => {
  mainEl.style.removeProperty('--editor-w');
  mainEl.style.removeProperty('--editor-h');
});

/* ---------------- tab switching ---------------- */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.pane;
    canvasEl.hidden = target !== 'canvas-pane';
    connEl.hidden   = target !== 'connections-pane';
  });
});

/* ---------------- diagram render ---------------- */
async function render(text){
  const seq = ++renderSeq;
  try{
    const spec = parseSpec(text);
    const graph = buildElk(spec);
    const layout = await elk.layout(graph);
    if (seq !== renderSeq) return;
    activeLabel = null;
    lastSpec = spec;
    canvasEl.innerHTML = renderSVG(spec, layout);
    renderConnections(spec);
    const n = spec.nodeMap.size, g = spec.groupMap.size, c = (spec.doc.connections||[]).length;
    statusEl.className = '';
    statusEl.textContent = `OK — ${n} nodes · ${g} groups · ${c} connections`;
  }catch(err){
    if (seq !== renderSeq) return;
    statusEl.className = 'error';
    statusEl.textContent = (err.isSpec ? '' : 'YAML: ') + err.message;
  }
}

let timer = null;
let activeLabel = null;

/* Edge click: highlight all edges sharing the same label, dim the rest.
 * Lives on the container so it survives SVG re-renders. */
canvasEl.addEventListener('click', e => {
  const hit = e.target.closest('.edge, .edge-lbl');
  const label = hit?.dataset?.label || null;
  const toggle = label && label === activeLabel;
  activeLabel = toggle ? null : label;
  const all = canvasEl.querySelectorAll('.edge, .edge-lbl');
  all.forEach(el => {
    el.classList.toggle('edge-lo', !!activeLabel && el.dataset.label !== activeLabel);
  });
});

const editor = makeEditor($('#editor'), SCHEMA, text => {
  clearTimeout(timer);
  timer = setTimeout(() => render(text), 350);
});

/* example picker: choosing an entry loads it; Reset reloads the current choice */
const exampleSel = $('#sel-example');
EXAMPLES.forEach((ex, i)=>{
  const o = document.createElement('option');
  o.value = i; o.textContent = ex.name;
  exampleSel.appendChild(o);
});
function loadExample(){
  const yaml = EXAMPLES[exampleSel.value].yaml;
  editor.setValue(yaml);
  clearTimeout(timer);
  render(yaml);
}
exampleSel.addEventListener('change', loadExample);
$('#btn-example').addEventListener('click', loadExample);
$('#btn-download').addEventListener('click', ()=>{
  const svg = canvasEl.querySelector('svg'); if (!svg) return;
  const blob = new Blob([svg.outerHTML], {type:'image/svg+xml'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const t = lastSpec?.doc.diagram?.title;   // the SVG on screen came from lastSpec
  a.download = (t ? String(t).toLowerCase().replace(/[^a-z0-9]+/g,'-') : 'network-diagram') + '.svg';
  a.click(); URL.revokeObjectURL(a.href);
});
window.addEventListener('error', e=>{ statusEl.className='error'; statusEl.textContent = 'Runtime: ' + e.message; });

loadExample();
