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
  // one directed row per connection; a bidirectional one (direction: both) yields
  // two; a blocked one (direction: none) is not a rule, so it is left out
  const flows = [];
  for (const l of filtered){
    const dir = dirOf(l);
    if (dir === 'none') continue;
    const meta = {
      proto:   l.protocol != null ? String(l.protocol) : '',
      port:    l.port     != null ? String(l.port)     : '',
      label:   l.label    != null ? String(l.label)    : '',
      comment: l.comment  != null ? String(l.comment)  : '',
    };
    flows.push({ src: endpoint(l.from), dst: endpoint(l.to), ...meta });
    if (dir === 'both')
      flows.push({ src: endpoint(l.to), dst: endpoint(l.from), ...meta });
  }
  if (!flows.length){
    connEl.innerHTML = '<p class="conn-empty">No forwarding rules to list.</p>';
    lastCsv = '';
    return;
  }
  const hasComment = flows.some(f => f.comment.trim() !== '');
  const dash = '<span class="conn-dash">—</span>';
  // endpoint = name with its address beneath it, so the address is unambiguous
  const epCell = ep =>
    `<td class="conn-ep"><span class="conn-name">${esc(ep.name)}</span>${
      ep.addr && ep.addr !== '—' ? `<span class="conn-addr">${esc(ep.addr)}</span>` : ''}</td>`;

  const rows = flows.map((f, i) => `<tr>
      <td class="conn-n">${i+1}</td>
      ${epCell(f.src)}${epCell(f.dst)}
      <td class="conn-proto">${f.proto ? esc(f.proto).toUpperCase() : dash}</td>
      <td class="conn-port">${f.port ? esc(f.port) : dash}</td>
      <td class="conn-label">${f.label ? esc(f.label) : ''}</td>
      ${hasComment ? `<td class="conn-comment">${f.comment ? esc(f.comment) : ''}</td>` : ''}
    </tr>`).join('');

  const csvHead = ['#','Source','Source Address','Destination','Dest Address','Protocol','Port','Label'];
  if (hasComment) csvHead.push('Comment');
  const csvRows = [csvHead, ...flows.map((f, i) => {
    const r = [i+1, f.src.name, f.src.addr, f.dst.name, f.dst.addr, f.proto, f.port, f.label];
    if (hasComment) r.push(f.comment);
    return r;
  })];
  lastCsv = csvRows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');

  const excl = excluded ? `<span class="conn-excl">${excluded} same-zone excluded</span>` : '';
  connEl.innerHTML = `
    <div class="conn-toolbar">
      <h2>Connections &mdash; ${flows.length} rule${flows.length !== 1 ? 's' : ''} ${excl}</h2>
      <button id="btn-copy-csv">Copy CSV</button>
    </div>
    <table class="conn-table">
      <thead><tr>
        <th>#</th><th>Source</th><th>Destination</th>
        <th>Protocol</th><th>Port</th><th>Label</th>${hasComment ? '<th>Comment</th>' : ''}
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

/* ---------------- canvas zoom + pan ---------------- */
/* Zoom scales the SVG's width/height attributes (viewBox stays fixed), so the
 * pane's native scrolling doubles as panning; drag-to-pan drives scrollLeft/Top. */
const zoomPct = $('#zoom-pct');
let zoom = 1;
let fitNextRender = false;   // set when a whole new doc is loaded: fit it to the view once
function applyZoom(){
  const svg = canvasEl.querySelector('svg'); if (!svg) return;
  if (!svg.dataset.w){   // natural size, stashed once per rendered SVG
    svg.dataset.w = svg.getAttribute('width');
    svg.dataset.h = svg.getAttribute('height');
  }
  svg.setAttribute('width',  Math.round(svg.dataset.w * zoom));
  svg.setAttribute('height', Math.round(svg.dataset.h * zoom));
  zoomPct.textContent = Math.round(zoom * 100) + '%';
}
/* (cx, cy): pane point to keep stationary — defaults to the pane center */
function setZoom(z, cx = canvasEl.clientWidth / 2, cy = canvasEl.clientHeight / 2){
  z = Math.min(8, Math.max(.1, z));
  const prev = zoom; zoom = z;
  const sl = (canvasEl.scrollLeft + cx) * (z / prev) - cx;
  const st = (canvasEl.scrollTop  + cy) * (z / prev) - cy;
  applyZoom();
  canvasEl.scrollLeft = sl; canvasEl.scrollTop = st;
}
function fitZoom(){
  const svg = canvasEl.querySelector('svg'); if (!svg) return;
  const w = +(svg.dataset.w || svg.getAttribute('width'));
  const h = +(svg.dataset.h || svg.getAttribute('height'));
  if (!w || !h || !canvasEl.clientWidth) return;
  zoom = Math.min(canvasEl.clientWidth / w, canvasEl.clientHeight / h) * .99;
  applyZoom();
  canvasEl.scrollLeft = canvasEl.scrollTop = 0;
}
$('#zoom-in').addEventListener('click',  () => setZoom(zoom * 1.25));
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zoom-fit').addEventListener('click', fitZoom);
zoomPct.addEventListener('click', () => setZoom(1));

/* Ctrl+wheel / trackpad pinch zooms toward the cursor; plain wheel scrolls */
canvasEl.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = canvasEl.getBoundingClientRect();
  setZoom(zoom * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

/* drag to pan; a real drag (>4px) suppresses the edge-highlight click */
let pan = null, suppressClick = false;
canvasEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  pan = { x: e.clientX, y: e.clientY, sl: canvasEl.scrollLeft, st: canvasEl.scrollTop,
          id: e.pointerId, moved: false };
});
canvasEl.addEventListener('pointermove', e => {
  if (!pan) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (!pan.moved){
    if (Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    canvasEl.setPointerCapture(pan.id);
    canvasEl.classList.add('panning');
  }
  canvasEl.scrollLeft = pan.sl - dx;
  canvasEl.scrollTop  = pan.st - dy;
});
const endPan = () => {
  if (pan?.moved){ suppressClick = true; canvasEl.classList.remove('panning'); }
  pan = null;
};
canvasEl.addEventListener('pointerup', endPan);
canvasEl.addEventListener('pointercancel', endPan);

/* ---------------- tab switching ---------------- */
const zoomTools = $('#zoom-tools');
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.pane;
    canvasEl.hidden = target !== 'canvas-pane';
    connEl.hidden   = target !== 'connections-pane';
    zoomTools.hidden = target !== 'canvas-pane';
  });
});

/* ---------------- diagram render ---------------- */
async function render(text){
  const seq = ++renderSeq;
  try{
    const spec = parseSpec(text);
    const pass1 = await elk.layout(buildElk(spec));
    /* second pass with FIXED_ORDER hub ports (fresh graph — pass 1 mutated its own) */
    const ported = assignPorts(buildElk(spec), pass1);
    const layout = ported ? await elk.layout(ported) : pass1;
    if (seq !== renderSeq) return;
    activeLabel = null;
    lastSpec = spec;
    canvasEl.innerHTML = renderSVG(spec, layout);
    if (fitNextRender){ fitNextRender = false; fitZoom(); }  // a freshly loaded doc: show all of it
    else applyZoom();               // an edit: keep the current zoom level
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
  if (suppressClick){ suppressClick = false; return; }   // tail end of a pan drag
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
  saveDraft(text);     // autosave the live buffer so a reload restores it
  updateDirty();       // reflect unsaved changes vs the active project
});

/* example picker (below the editor): choosing an entry loads it into the editor */
const exampleSel = $('#sel-example');
EXAMPLES.forEach((ex, i)=>{
  const o = document.createElement('option');
  o.value = i; o.textContent = ex.name;
  exampleSel.appendChild(o);
});
// the list is sorted by name; preselect the default (def) example for first load
exampleSel.value = String(Math.max(0, EXAMPLES.findIndex(ex => ex.def)));
function loadExample(){
  const yaml = EXAMPLES[exampleSel.value].yaml;
  setActive('');            // an example is a fresh, unsaved draft
  editor.setValue(yaml);
  clearTimeout(timer);
  fitNextRender = true;     // show the whole diagram on load
  render(yaml);
  refreshProjects();
}
exampleSel.addEventListener('change', loadExample);
/* dash-concatenated file name from the diagram title (or any base string) */
const slugName = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g,'-')
  .replace(/^-+|-+$/g,'') || 'network-diagram';

$('#btn-download').addEventListener('click', ()=>{
  const svg = canvasEl.querySelector('svg'); if (!svg) return;
  const clone = svg.cloneNode(true);       // download at natural size, zoom-free
  if (svg.dataset.w){
    clone.setAttribute('width', svg.dataset.w);
    clone.setAttribute('height', svg.dataset.h);
  }
  delete clone.dataset.w; delete clone.dataset.h;
  const blob = new Blob([clone.outerHTML], {type:'image/svg+xml'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slugName(lastSpec?.doc.diagram?.title) + '.svg';  // the SVG on screen came from lastSpec
  a.click(); URL.revokeObjectURL(a.href);
});

/* Download YAML — save the current editor source to a file (as typed, even if
 * it doesn't parse). Name it after the active project, else the diagram title. */
$('#btn-yaml').addEventListener('click', ()=>{
  const text = editor.value;
  const title = /^\s*title:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/^["']|["']$/g,'');
  const name = slugName(getActive() || title);
  const blob = new Blob([text], {type:'text/yaml;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.yaml';
  a.click(); URL.revokeObjectURL(a.href);
});

/* Import YAML — load a .yaml file from disk into the editor as a fresh draft */
const fileInput = $('#file-yaml');
$('#btn-import').addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', ()=>{
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';                 // let the same file be picked again later
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    const text = String(reader.result);
    setActive('');                      // imported content is a fresh, unsaved draft
    editor.setValue(text);
    clearTimeout(timer); fitNextRender = true; render(text);
    refreshProjects();
  };
  reader.onerror = ()=>{ statusEl.className = 'error'; statusEl.textContent = 'Could not read the file.'; };
  reader.readAsText(file);
});

/* Export PDF — print a page holding just the diagram; the browser's print
 * dialog does the SVG->PDF conversion (stays vector, no extra libraries).
 * A hidden iframe avoids popup blockers. @page pins A4 as the default paper,
 * oriented by the diagram's aspect; the frame's <title> is the slugged
 * diagram title, which browsers suggest as the PDF file name. */
$('#btn-pdf').addEventListener('click', ()=>{
  const svg = canvasEl.querySelector('svg'); if (!svg) return;
  const clone = svg.cloneNode(true);        // print at natural size, zoom-free
  if (svg.dataset.w){
    clone.setAttribute('width', svg.dataset.w);
    clone.setAttribute('height', svg.dataset.h);
  }
  delete clone.dataset.w; delete clone.dataset.h;
  const landscape = (+clone.getAttribute('width') || 1) >= (+clone.getAttribute('height') || 1);
  const title = esc(slugName(lastSpec?.doc.diagram?.title));
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const d = frame.contentDocument;
  d.open();
  d.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>@page{size:A4 ${landscape?'landscape':'portrait'};margin:8mm}`
    + `html,body{margin:0;padding:0;height:100%}`
    + `body{display:flex;align-items:center;justify-content:center}`
    + `svg{max-width:100%;max-height:100%}</style></head>`
    + `<body>${clone.outerHTML}</body></html>`);
  d.close();
  const win = frame.contentWindow;
  const go = ()=>{ win.focus(); win.print(); setTimeout(()=>frame.remove(), 1000); };
  if (d.readyState === 'complete') go(); else win.onload = go;
});
window.addEventListener('error', e=>{ statusEl.className='error'; statusEl.textContent = 'Runtime: ' + e.message; });

/* ---------------- local projects (autosave + named projects) ----------------
 * Everything lives in localStorage, which may be unavailable (private mode, or
 * an opaque file:// origin in some engines). Every access is guarded; when it is
 * missing the feature hides itself and the app still works from examples. */
const LS = (() => {
  try { const s = window.localStorage, k = '__nd_probe__';
        s.setItem(k, '1'); s.removeItem(k); return s; }
  catch (e) { return null; }
})();
const K_PROJECTS = 'netdiagram:v1:projects';   // { name: {yaml, updated} }
const K_DRAFT    = 'netdiagram:v1:draft';      // live editor buffer
const K_ACTIVE   = 'netdiagram:v1:active';     // name of the open project ('' = draft)
const NEW_ITEM   = '\x00new';                  // sentinel option value

const projectSel = $('#sel-project'), btnSave = $('#btn-save'), btnDel = $('#btn-del');

function readProjects(){
  if (!LS) return {};
  try { return JSON.parse(LS.getItem(K_PROJECTS) || '{}') || {}; } catch(e){ return {}; }
}
function writeProjects(p){ if (LS) try { LS.setItem(K_PROJECTS, JSON.stringify(p)); } catch(e){} }
function getActive(){ try { return (LS && LS.getItem(K_ACTIVE)) || ''; } catch(e){ return ''; } }
function setActive(name){ if (LS) try { name ? LS.setItem(K_ACTIVE, name) : LS.removeItem(K_ACTIVE); } catch(e){} }
function saveDraft(text){ if (LS) try { LS.setItem(K_DRAFT, text); } catch(e){} }
function readDraft(){ try { return LS ? LS.getItem(K_DRAFT) : null; } catch(e){ return null; } }

function updateDirty(){
  const active = getActive(), projects = readProjects();
  const dirty = !!active && projects[active] != null && projects[active].yaml !== editor.value;
  btnSave.classList.toggle('dirty', dirty);
  btnSave.textContent = dirty ? 'Save •' : 'Save';
}
function refreshProjects(){
  const projects = readProjects();
  const names = Object.keys(projects).sort((a,b)=>a.localeCompare(b));
  const active = getActive();
  projectSel.innerHTML = '';
  const draft = document.createElement('option');
  draft.value = ''; draft.textContent = names.length ? '— Draft —' : 'No saved projects';
  projectSel.appendChild(draft);
  for (const n of names){
    const o = document.createElement('option'); o.value = n; o.textContent = n;
    projectSel.appendChild(o);
  }
  const add = document.createElement('option');
  add.value = NEW_ITEM; add.textContent = '＋ New project…';
  projectSel.appendChild(add);
  projectSel.value = (active && projects[active]) ? active : '';
  btnDel.hidden = !projectSel.value;
  updateDirty();
}
function suggestName(){
  const m = /^\s*title:\s*(.+?)\s*$/m.exec(editor.value);
  return m ? m[1].replace(/^["']|["']$/g, '') : 'my-network';
}
function saveProject(){
  if (!LS){ statusEl.className='error'; statusEl.textContent='This browser has no local storage available — cannot save.'; return; }
  let name = getActive();
  if (!name){
    name = (window.prompt('Save project as:', suggestName()) || '').trim();
    if (!name || name === NEW_ITEM) return;
    if (readProjects()[name] && !window.confirm(`A project named "${name}" already exists — overwrite it?`)) return;
  }
  const projects = readProjects();
  projects[name] = { yaml: editor.value, updated: Date.now() };
  writeProjects(projects); setActive(name); refreshProjects();
  btnSave.textContent = 'Saved';
  setTimeout(updateDirty, 1100);
}
function openProject(name){
  const p = readProjects()[name]; if (!p) return;
  setActive(name);
  editor.setValue(p.yaml);         // fires onChange -> saveDraft + updateDirty
  clearTimeout(timer); fitNextRender = true; render(p.yaml);
  refreshProjects();
}
function newProject(){
  const STARTER = 'diagram:\n  title: New project\n  direction: down\n\nnodes:\n  - id: n1\n    label: node-1\n    type: server\n';
  setActive('');
  editor.setValue(STARTER);
  clearTimeout(timer); fitNextRender = true; render(STARTER);
  refreshProjects();
}
function deleteProject(){
  const name = getActive(); if (!name) return;
  if (!window.confirm(`Delete project "${name}"? This cannot be undone.`)) return;
  const projects = readProjects(); delete projects[name];
  writeProjects(projects); setActive('');   // keep the buffer, now an untitled draft
  refreshProjects();
}
const dirtyVsActive = () => {
  const a = getActive(), p = readProjects();
  return a && p[a] && p[a].yaml !== editor.value;
};
projectSel.addEventListener('change', () => {
  const v = projectSel.value;
  if (v === NEW_ITEM){
    if (dirtyVsActive() && !window.confirm('Start a new project? Unsaved changes will be lost.')){
      refreshProjects(); return;
    }
    newProject(); return;
  }
  if (v === ''){ setActive(''); refreshProjects(); return; }   // detach to draft
  if (dirtyVsActive() && !window.confirm('Discard unsaved changes to the current project?')){
    projectSel.value = getActive(); return;
  }
  openProject(v);
});
btnSave.addEventListener('click', saveProject);
btnDel.addEventListener('click', deleteProject);
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's'){
    e.preventDefault(); saveProject();
  }
});

if (!LS){
  for (const el of [$('#project-picker'), btnSave, btnDel]) if (el) el.hidden = true;
}

/* initial load: restore the autosaved draft if present, else the default example */
refreshProjects();
const draft = readDraft();
if (draft && draft.trim()){
  editor.setValue(draft);
  clearTimeout(timer); fitNextRender = true; render(draft);
  refreshProjects();
} else {
  loadExample();
}
