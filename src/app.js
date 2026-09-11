"use strict";
/* ---------------- wire up ---------------- */
const $ = s => document.querySelector(s);
const elk = new ELK();
const statusEl = $('#status'), canvasEl = $('#canvas-pane'), connEl = $('#connections-pane');
let renderSeq = 0;
let lastCsv = '';
let lastSpec = null;   // spec of the SVG on screen (the view: filtered / compared)
let lastSvg = '';      // renderSVG output on screen — downloads use it (zoom-free, no UI classes)
let lastView = null;   // { source: doc parsed from the editor, doc: the doc actually drawn }
let statusNote = '';   // one-shot note appended to the next OK status (imports, shared links)
const tagFilter = new Set();   // selected tags, lowercase; empty = show everything
let compare = null;            // { kind: 'project' | 'file', name, doc } baseline of the compare view

function setStatus(text, isError){
  statusEl.className = isError ? 'error' : '';
  statusEl.textContent = text;
}

/* ---------------- connections table ---------------- */
/* rules come from connectionRules() in the core; `change` (connection index ->
 * added/removed/changed) adds a change marker column in the compare view */
function renderConnections(spec, change){
  const { rules, excluded, considered } = connectionRules(spec);
  if (!considered){
    connEl.innerHTML = '<p class="conn-empty">All connections are within the same zone — no firewall rules needed.</p>';
    lastCsv = '';
    return;
  }
  if (!rules.length){
    connEl.innerHTML = '<p class="conn-empty">No forwarding rules to list.</p>';
    lastCsv = '';
    return;
  }
  const hasComment = rules.some(r => r.comment.trim() !== '');
  const dash = '<span class="conn-dash">—</span>';
  const MARK = { added:'+', removed:'−', changed:'~' };
  // endpoint = name with its address beneath it, so the address is unambiguous
  const epCell = ep =>
    `<td class="conn-ep"><span class="conn-name">${esc(ep.name)}</span>${
      ep.addr && ep.addr !== '—' ? `<span class="conn-addr">${esc(ep.addr)}</span>` : ''}</td>`;

  const rows = rules.map((r, i) => {
    const s = change && change.get(r.conn);
    return `<tr${s ? ` class="chg-${s}"` : ''}>
      ${change ? `<td class="conn-chg">${s ? MARK[s] : ''}</td>` : ''}
      <td class="conn-n">${i+1}</td>
      ${epCell(r.src)}${epCell(r.dst)}
      <td class="conn-proto">${r.proto ? esc(r.proto).toUpperCase() : dash}</td>
      <td class="conn-port">${r.port ? esc(r.port) : dash}</td>
      <td class="conn-label">${r.label ? esc(r.label) : ''}</td>
      ${hasComment ? `<td class="conn-comment">${r.comment ? esc(r.comment) : ''}</td>` : ''}
    </tr>`;
  }).join('');
  lastCsv = rulesToCsv(rules, change);

  const notes = [
    excluded ? `${excluded} same-zone excluded` : '',
    tagFilter.size ? `tags: ${[...tagFilter].join(', ')}` : '',
    compare ? `vs ${compare.name}` : '',
  ].filter(Boolean).map(t => `<span class="conn-excl">${esc(t)}</span>`).join('');
  connEl.innerHTML = `
    <div class="conn-toolbar">
      <h2>Connections &mdash; ${rules.length} rule${rules.length !== 1 ? 's' : ''} ${notes}</h2>
      <button id="btn-copy-csv">Copy CSV</button>
    </div>
    <table class="conn-table">
      <thead><tr>
        ${change ? '<th></th>' : ''}<th>#</th><th>Source</th><th>Destination</th>
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

/* ---------------- tag filter ---------------- */
/* one toggle chip per tag in the document; selected tags narrow both the
 * diagram and the Connections table (filterDoc in the core) */
const tagBar = $('#tag-filter'), tagChips = $('#tag-chips');
let tagKey = null;
function updateTagBar(doc){
  const tags = allTags(doc);
  const present = new Set(tags.map(t => t.toLowerCase()));
  for (const t of [...tagFilter]) if (!present.has(t)) tagFilter.delete(t);
  const key = tags.join(' ') + '' + [...tagFilter].join(' ');
  if (key === tagKey) return;
  tagKey = key;
  tagBar.hidden = !tags.length;
  tagChips.innerHTML = tags.map(t =>
    `<button class="tag-chip" data-tag="${esc(t)}" aria-pressed="${tagFilter.has(t.toLowerCase())}">${esc(t)}</button>`).join('');
}
tagChips.addEventListener('click', e => {
  const chip = e.target.closest('.tag-chip'); if (!chip) return;
  const t = chip.dataset.tag.toLowerCase();
  if (tagFilter.has(t)) tagFilter.delete(t); else tagFilter.add(t);
  tagKey = null;
  fitNextRender = true;
  renderNow();
});

/* ---------------- diagram render ---------------- */
async function render(text){
  const seq = ++renderSeq;
  try{
    const source = jsyaml.load(text);
    const sourceSpec = specFromDoc(source);   // validate what the author wrote, before any view narrows it
    updateTagBar(source);
    let doc = tagFilter.size ? filterDoc(source, [...tagFilter]) : source;
    if (tagFilter.size && !flatNodes(doc).length){
      const e = new Error(`Nothing is tagged ${[...tagFilter].join(' / ')} — click a highlighted tag to clear the filter.`);
      e.isSpec = true; throw e;
    }
    let diff = null;
    if (compare){
      diff = diffDocs(tagFilter.size ? filterDoc(compare.doc, [...tagFilter]) : compare.doc, doc);
      doc = diff.doc;
    }
    const spec = doc === source ? sourceSpec : specFromDoc(doc);
    const pass1 = await elk.layout(buildElk(spec));
    /* second pass with FIXED_ORDER hub ports (fresh graph — pass 1 mutated its own) */
    const ported = assignPorts(buildElk(spec), pass1);
    const layout = ported ? await elk.layout(ported) : pass1;
    if (seq !== renderSeq) return;
    const rows = tagFilter.size ? [['filter', 'tags: ' + [...tagFilter].join(', ')]] : [];
    const svg = renderSVG(spec, layout, { source: text, rows, diff: diff && { ...diff, base: compare.name } });
    activeLabel = null;
    lastSpec = spec; lastSvg = svg; lastView = { source, doc };
    canvasEl.innerHTML = svg;
    canvasEl.style.background = canvasEl.querySelector('svg')?.dataset.bg || '';
    if (fitNextRender){ fitNextRender = false; fitZoom(); }  // a freshly loaded doc: show all of it
    else applyZoom();               // an edit: keep the current zoom level
    renderConnections(spec, diff && diff.status.connections);
    applyCursorHighlight();
    const n = sourceSpec.nodeMap.size, g = sourceSpec.groupMap.size, c = (source.connections||[]).length;
    const parts = [`OK — ${n} nodes · ${g} groups · ${c} connections`];
    if (tagFilter.size) parts.push(`showing ${spec.nodeMap.size} tagged ${[...tagFilter].join(' / ')}`);
    if (diff) parts.push(`vs ${compare.name}: +${diff.counts.added} −${diff.counts.removed} ~${diff.counts.changed}`);
    if (statusNote) parts.push(statusNote);
    statusNote = '';
    setStatus(parts.join(' · '));
  }catch(err){
    if (seq !== renderSeq) return;
    setStatus((err.isSpec ? '' : 'YAML: ') + err.message, true);
  }
}

let timer = null;
let activeLabel = null;
const renderNow = () => { clearTimeout(timer); render(editor.value); };

/* ---------------- diagram <-> YAML ---------------- */
/* sourceMap of the editor text, memoized per text */
let mapCache = { text: null, map: null };
function currentMap(){
  const text = editor.value;
  if (mapCache.text !== text) mapCache = { text, map: sourceMap(text) };
  return mapCache.map;
}
/* connection indices differ between the editor doc and the drawn view (tag
 * filter drops some, compare appends removed ones); both keep the connection
 * objects by reference, so indexOf maps between them */
const viewIndexOf = i => lastView ? (lastView.doc.connections || []).indexOf((lastView.source.connections || [])[i]) : -1;
const sourceIndexOf = i => lastView ? (lastView.source.connections || []).indexOf((lastView.doc.connections || [])[i]) : -1;

/* the diagram item under a click: selection key + YAML range (range is null
 * for items only the compare view draws); null for empty paper */
function clickedItem(target){
  const map = currentMap();
  if (!map || !lastView) return null;
  const conn = target.closest('[data-conn]');
  if (conn){
    const si = sourceIndexOf(+conn.dataset.conn);
    return si < 0 ? null : { key: `connection:${si}`, range: map.itemRange('connection', si) };
  }
  const el = target.closest('.nd-node, .nd-group');
  if (!el) return null;
  const kind = el.classList.contains('nd-node') ? 'node' : 'group';
  return { key: `${kind}:${el.dataset.id}`, range: map.itemRange(kind, el.dataset.id) };
}
/* cursor in the editor: the item it sits on glows, pulsing briefly when the
 * selection changes. A click on empty paper — or on the selected item again —
 * hides the glow until the cursor moves. */
let cursorPos = null, cursorFrame = 0;
let selKey = null;       // item shown as selected: 'node:web1', 'group:dmz', 'connection:3'
let selHidden = false;
function applyCursorHighlight(){
  const item = cursorPos == null || !lastView || selHidden ? null : currentMap()?.itemAt(cursorPos);
  const key = item ? `${item.kind}:${item.kind === 'connection' ? item.index : item.id}` : null;
  let els = [];
  if (item?.kind === 'connection'){
    const vi = viewIndexOf(item.index);
    if (vi >= 0) els = [...canvasEl.querySelectorAll(`[data-conn="${vi}"]`)];   // path + its label
  } else if (item){
    els = [...canvasEl.querySelectorAll(item.kind === 'node' ? '.nd-node' : '.nd-group')]
      .filter(el => el.dataset.id === item.id);
  }
  const current = [...canvasEl.querySelectorAll('.nd-sel')];
  // unchanged (cursor moved within the item): leave a running pulse alone
  if (key === selKey && els.length === current.length && els.every(el => current.includes(el))) return;
  current.forEach(el => el.classList.remove('nd-sel', 'nd-pulse'));
  const pulse = key !== selKey;          // a new selection pulses; re-rendering the same one doesn't
  els.forEach(el => el.classList.add('nd-sel', ...(pulse ? ['nd-pulse'] : [])));
  selKey = els.length ? key : null;
}
function hideSelection(){
  selHidden = true;
  applyCursorHighlight();
}
/* click in the diagram: reveal the item in the editor (whose cursor then drives
 * the glow); empty paper or the selected item again clears the selection */
function selectFromDiagram(target){
  const item = clickedItem(target);
  if (!item || item.key === selKey) return hideSelection();
  if (item.range) editor.reveal(item.range.from, item.range.to);
}

/* Edge click: highlight all edges sharing the same label, dim the rest; any
 * click also selects (or clears) in the diagram. Lives on the container so it
 * survives SVG re-renders. */
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
  selectFromDiagram(e.target);
});

/* spec validation as editor diagnostics, placed on the offending YAML (YAML
 * syntax errors are left to the schema linter and the status line) */
function specDiagnostics(text){
  let doc;
  try { doc = jsyaml.load(text); } catch (e) { return []; }
  try { specFromDoc(doc); return []; }
  catch (e) {
    if (!e.errors) return [];
    const map = sourceMap(text);
    return e.errors.map(x => {
      const r = map ? map.rangeOf(x.path) : null;
      const at = r && r.depth ? r : { from: 0, to: 0 };
      return { from: at.from, to: at.to, severity: 'error', source: 'netdiagram', message: x.message };
    });
  }
}

const editor = makeEditor($('#editor'), SCHEMA, text => {
  clearTimeout(timer);
  timer = setTimeout(() => render(text), 350);
  saveDraft(text);     // autosave the live buffer so a reload restores it
  updateDirty();       // reflect unsaved changes vs the active project
}, {
  lint: specDiagnostics,
  onCursor: pos => {
    cursorPos = pos;
    selHidden = false;   // the cursor moved: show its item again
    cancelAnimationFrame(cursorFrame);
    cursorFrame = requestAnimationFrame(applyCursorHighlight);
  },
});

/* replace the editor buffer with a fresh, unsaved draft and show all of it */
function loadText(text, note){
  setActive('');
  editor.setValue(text);
  statusNote = note || '';
  clearTimeout(timer); fitNextRender = true; render(text);
  refreshProjects();
}

/* example picker (below the editor): choosing an entry loads it into the editor */
const exampleSel = $('#sel-example');
EXAMPLES.forEach((ex, i)=>{
  const o = document.createElement('option');
  o.value = i; o.textContent = ex.name;
  exampleSel.appendChild(o);
});
// the list is sorted by name; preselect the default (def) example for first load
exampleSel.value = String(Math.max(0, EXAMPLES.findIndex(ex => ex.def)));
function loadExample(){ loadText(EXAMPLES[exampleSel.value].yaml); }
exampleSel.addEventListener('change', loadExample);
/* dash-concatenated file name from the diagram title (or any base string) */
const slugName = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g,'-')
  .replace(/^-+|-+$/g,'') || 'network-diagram';
function downloadBlob(blob, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* Download SVG — the renderSVG output on screen: natural size, YAML source embedded */
$('#btn-download').addEventListener('click', ()=>{
  if (!lastSvg) return;
  downloadBlob(new Blob([lastSvg], {type:'image/svg+xml'}), slugName(lastSpec?.doc.diagram?.title) + '.svg');
});

/* Download YAML — save the current editor source to a file (as typed, even if
 * it doesn't parse). Name it after the active project, else the diagram title. */
$('#btn-yaml').addEventListener('click', ()=>{
  const text = editor.value;
  const title = /^\s*title:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/^["']|["']$/g,'');
  downloadBlob(new Blob([text], {type:'text/yaml;charset=utf-8'}), slugName(getActive() || title) + '.yaml');
});

/* ---------------- import (file picker + drag and drop) ---------------- */
function readFile(file, then){
  const reader = new FileReader();
  reader.onload = () => then(String(reader.result), file.name);
  reader.onerror = () => setStatus('Could not read the file.', true);
  reader.readAsText(file);
}
const looksLikeSvg = (text, name) => /\.svg$/i.test(name || '') || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);
/* netdiagram YAML loads as-is; an SVG exported by netdiagram opens its embedded
 * source; inventories (Ansible / Terraform / NetBox) are converted to YAML */
function importText(text, name){
  if (looksLikeSvg(text, name)){
    const src = extractSource(text);
    if (src == null) setStatus(`${name || 'This SVG'} has no embedded netdiagram source — only SVGs downloaded from netdiagram can be opened.`, true);
    else loadText(src, `opened the source embedded in ${name || 'the SVG'}`);
    return;
  }
  let imported;
  try { imported = Importers.detectImport(text, name); }
  catch (e) { setStatus(`Import failed: ${e.message}`, true); return; }
  if (imported) loadText(imported.yaml, `imported ${imported.label} (${imported.summary}) — add connections to finish`);
  else loadText(text);
}
const fileInput = $('#file-yaml');
$('#btn-import').addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', ()=>{
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';                 // let the same file be picked again later
  if (file) readFile(file, importText);
});
let dragDepth = 0;
const draggingFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => {
  if (!draggingFiles(e)) return;
  dragDepth++; document.body.classList.add('dropping');
});
window.addEventListener('dragleave', e => {
  if (!draggingFiles(e)) return;
  if (--dragDepth <= 0){ dragDepth = 0; document.body.classList.remove('dropping'); }
});
window.addEventListener('dragover', e => { if (draggingFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dropping');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file, importText);
});

/* Export PDF — print a page holding just the diagram; the browser's print
 * dialog does the SVG->PDF conversion (stays vector, no extra libraries).
 * A hidden iframe avoids popup blockers. @page pins A4 as the default paper,
 * oriented by the diagram's aspect; the frame's <title> is the slugged
 * diagram title, which browsers suggest as the PDF file name. */
$('#btn-pdf').addEventListener('click', ()=>{
  if (!lastSvg) return;
  const size = /width="(\d+)" height="(\d+)"/.exec(lastSvg);
  const landscape = !size || +size[1] >= +size[2];
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
    + `<body>${lastSvg}</body></html>`);
  d.close();
  const win = frame.contentWindow;
  const go = ()=>{ win.focus(); win.print(); setTimeout(()=>frame.remove(), 1000); };
  if (d.readyState === 'complete') go(); else win.onload = go;
});
window.addEventListener('error', e=>{ setStatus('Runtime: ' + e.message, true); });

/* ---------------- share links ---------------- */
/* The YAML travels deflated in the URL fragment (#src=…), which browsers never
 * send to a server. Opened from a file, the link points at the hosted copy. */
const HOMEPAGE = window.NETDIAGRAM_HOMEPAGE || '';
const shareBase = () => /^https?:$/.test(location.protocol) || !HOMEPAGE
  ? location.href.split('#')[0] : HOMEPAGE;
$('#btn-share').addEventListener('click', async ()=>{
  try {
    const url = shareBase() + '#src=' + await encodeShare(editor.value);
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {}
    if (!copied) window.prompt('Copy this link:', url);
    const hosted = shareBase() !== location.href.split('#')[0] ? ` — it opens ${HOMEPAGE}` : '';
    setStatus(`Share link ${copied ? 'copied' : 'ready'} (${url.length} characters)${hosted}`);
  } catch (err) {
    setStatus('Could not create a share link: ' + err.message, true);
  }
});
/* read (and clear) a #src= fragment; null when there is none */
async function takeSharedText(){
  const m = /^#src=([\w-]+)$/.exec(location.hash);
  if (!m) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  try { return await decodeShare(m[1]); }
  catch (e) { setStatus('Share link: ' + e.message, true); return null; }
}
/* true when `text` exists nowhere but in the editor buffer */
const isUnsaved = text => !!text && !!text.trim() && !Object.values(readProjects()).some(p => p.yaml === text);
window.addEventListener('hashchange', async ()=>{
  const shared = await takeSharedText();
  if (shared == null || shared === editor.value) return;
  if (isUnsaved(editor.value) && !window.confirm('Open the shared diagram? It replaces your current unsaved draft.')) return;
  loadText(shared, 'opened a shared link');
});

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
  refreshCompare();
}
function suggestName(){
  const m = /^\s*title:\s*(.+?)\s*$/m.exec(editor.value);
  return m ? m[1].replace(/^["']|["']$/g, '') : 'my-network';
}
function saveProject(){
  if (!LS){ setStatus('This browser has no local storage available — cannot save.', true); return; }
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
  loadText('diagram:\n  title: New project\n  direction: down\n\nnodes:\n  - id: n1\n    label: node-1\n    type: server\n');
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

/* ---------------- compare view ---------------- */
/* Baseline: a saved project (e.g. the last saved state of the one being
 * edited) or a YAML / netdiagram SVG file. Kept in memory only. */
const compareSel = $('#sel-compare'), compareFile = $('#file-compare');
function refreshCompare(){
  const names = Object.keys(readProjects()).sort((a,b)=>a.localeCompare(b));
  const active = getActive();
  compareSel.innerHTML = '';
  const opt = (value, text) => {
    const o = document.createElement('option'); o.value = value; o.textContent = text;
    compareSel.appendChild(o);
  };
  opt('', 'Off');
  const loaded = compare && (compare.kind === 'file' || !names.includes(compare.name));
  if (loaded) opt('loaded', compare.name);
  names.forEach(n => opt('p:' + n, n === active ? `${n} (saved)` : n));
  opt('file', 'File…');
  compareSel.value = !compare ? '' : loaded ? 'loaded' : 'p:' + compare.name;
}
function baselineDoc(text, name){
  try { return parseSpec(text).doc; }
  catch (e) { setStatus(`Cannot compare with ${name}: ${e.message.split('\n')[0]}`, true); return null; }
}
function setCompare(next){
  compare = next;
  refreshCompare();
  renderNow();
}
compareSel.addEventListener('change', () => {
  const v = compareSel.value;
  if (v === '') return setCompare(null);
  if (v === 'loaded') return;
  if (v === 'file'){ refreshCompare(); compareFile.click(); return; }
  const name = v.slice(2), p = readProjects()[name];
  const doc = p && baselineDoc(p.yaml, name);
  if (doc) setCompare({ kind: 'project', name, doc }); else refreshCompare();
});
compareFile.addEventListener('change', () => {
  const file = compareFile.files && compareFile.files[0];
  compareFile.value = '';
  if (!file) return;
  readFile(file, (text, name) => {
    const src = looksLikeSvg(text, name) ? extractSource(text) : text;
    if (src == null){ setStatus(`${name} has no embedded netdiagram source.`, true); return; }
    const doc = baselineDoc(src, name);
    if (doc) setCompare({ kind: 'file', name, doc });
  });
});

/* initial load: a shared link wins (asking before it replaces unsaved work),
 * else the autosaved draft, else the default example */
(async () => {
  refreshProjects();
  const draft = readDraft();
  const shared = await takeSharedText();
  if (shared != null && (shared === draft || !isUnsaved(draft)
      || window.confirm('Open the shared diagram? It replaces your current unsaved draft.'))){
    loadText(shared, 'opened a shared link');
  } else if (draft && draft.trim()){
    editor.setValue(draft);
    clearTimeout(timer); fitNextRender = true; render(draft);
    refreshProjects();
  } else {
    loadExample();
  }
})();
