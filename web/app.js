// Cube Write's page: the Editor (kit/persona-float.js), the page (editor.bundle.js), the vault. Files on disk are the truth:
// the page saves what you type, and takes what anyone else writes (an agent, Obsidian, git) as it lands.
import { applyTheme } from '/kit/persona.js';
import { mountFloatingPersona } from '/kit/persona-float.js';
import { createEditor } from '/web/editor.bundle.js';
applyTheme();

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const api = async (p, opts = {}) => {
  const r = await fetch(p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const b = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(b?.error || r.statusText); e.status = r.status; e.body = b; throw e; }
  return b;
};
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });
const toast = msg => { $('toast').innerHTML = `<div>${esc(msg)}</div>`; clearTimeout(toast.t); toast.t = setTimeout(() => { $('toast').innerHTML = ''; }, 2600); };

const ICON = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  hash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8 7h6"/></svg>',
};

// ---- state ----
const S = {
  tree: { notes: [], folders: [], files: [] }, tags: [], vault: {},
  path: null, base: null, dirty: false, saving: null, conflict: null,
  back: [], fwd: [], open: new Set(JSON.parse(localStorage.getItem('notes-open') || '[]')),
  closed: new Set(JSON.parse(localStorage.getItem('notes-closed') || '[]')),
  q: '', tagFilter: null, results: null,
};
const keep = () => { try { localStorage.setItem('notes-open', JSON.stringify([...S.open])); localStorage.setItem('notes-closed', JSON.stringify([...S.closed])); } catch {} };
const names = () => S.tree.notes.map(n => ({ name: n.name, dir: n.dir }));
const known = () => { const s = new Set(); for (const n of S.tree.notes) { s.add(n.name.toLowerCase()); s.add(n.path.toLowerCase().replace(/\.md$/, '')); } return s; };
let knownSet = new Set();

// ---- the editor ----
const editor = createEditor($('editor'), {
  doc: '',
  placeholder: 'Start writing, or type / for blocks and [[ to link a note…',
  resolve: target => knownSet.has(String(target).toLowerCase().replace(/\.md$/, '')) || knownSet.has(String(target).toLowerCase().split('/').pop()),
  noteNames: names,
  tags: () => S.tags.map(t => t.tag),
  fileUrl: src => /^(https?:|data:)/.test(src) ? src : `/api/file?path=${encodeURIComponent(decodeURIComponent(src))}&from=${encodeURIComponent(S.path || '')}`,
  openLink: (target, { newPane } = {}) => openLink(target),
  openUrl: url => /^(https?:|mailto:)/.test(url) ? open(url, '_blank', 'noopener') : openLink(url.replace(/\.md$/, '')),
  openTag: tag => showTag(tag),
  uploadImage: async file => {
    const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name || 'image.png')}&from=${encodeURIComponent(S.path || '')}`, { method: 'POST', body: file });
    if (!r.ok) throw new Error('upload failed');
    return (await r.json()).name;
  },
  onChange: () => { if (applying) return; S.dirty = true; saveState(); scheduleSave(); },
  onSelection: () => { persona?.refreshContext(); },
  onSave: () => save(),
});
let applying = false;            // true while the page writes into the editor itself (loading, taking disk changes)
const setText = (text, { reset = false } = {}) => {
  applying = true;
  try { if (reset) { editor.view.dispatch({ changes: { from: 0, to: editor.view.state.doc.length, insert: text }, selection: { anchor: 0 } }); } else editor.setDoc(text); }
  finally { applying = false; }
};

// ---- saving: debounced, never over someone else's change ----
let saveTimer = null;
const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); };
function saveState() {
  $('saveState').textContent = S.conflict ? 'Not saved' : S.saving ? 'Saving…' : S.dirty ? 'Edited' : S.path ? 'Saved' : '';
}
async function save() {
  clearTimeout(saveTimer);
  if (!S.path || !S.dirty || S.conflict) return;
  if (S.saving) { await S.saving; return save(); }
  const text = editor.getDoc(), path = S.path;
  S.saving = (async () => {
    try {
      const r = await api('/api/note', { method: 'PUT', body: JSON.stringify({ path, text, base: S.base }) });
      if (S.path === path) { S.base = r.hash; S.dirty = editor.getDoc() !== text; }
    } catch (e) {
      if (e.status === 409 && S.path === path) showConflict(e.body.text, e.body.hash);
      else toast(`Couldn’t save: ${e.message}`);
    } finally { S.saving = null; saveState(); }
  })();
  saveState();
  await S.saving;
  if (S.dirty && !S.conflict) scheduleSave();
}
function showConflict(text, hash) {
  S.conflict = { text, hash };
  $('banner').hidden = false;
  $('banner').innerHTML = `<b>This note changed on disk</b> while you were typing (an agent, Obsidian or git).<span class="gap"></span>
    <button class="btn" data-c="theirs">Use the disk version</button><button class="btn primary" data-c="mine">Keep mine</button>`;
  saveState();
}
$('banner').onclick = async e => {
  const b = e.target.closest('[data-c]'); if (!b || !S.conflict) return;
  const { text, hash } = S.conflict;
  S.conflict = null; $('banner').hidden = true;
  if (b.dataset.c === 'theirs') { setText(text); S.base = hash; S.dirty = false; saveState(); }
  else { S.base = hash; S.dirty = true; await save(); }
};

// ---- opening notes ----
async function openNote(path, { push = true, line } = {}) {
  if (!path) return;
  await save();
  let note;
  try { note = await api(`/api/note?path=${encodeURIComponent(path)}`); }
  catch { toast('That note no longer exists'); return; }
  if (push && S.path && S.path !== path) { S.back.push(S.path); S.fwd = []; }
  S.path = note.path; S.base = note.hash; S.dirty = false; S.conflict = null; $('banner').hidden = true;
  setText(note.text, { reset: true });
  for (const part of note.path.split('/').slice(0, -1).reduce((a, p) => [...a, a.length ? `${a[a.length - 1]}/${p}` : p], [])) S.open.add(part);
  keep();
  history.replaceState(null, '', '#' + encodeURI(note.path));
  try { localStorage.setItem('notes-last', note.path); } catch {}
  showPage(true);
  renderHeader(); renderSide(); loadLinked(); saveState();
  if (line) editor.scrollToLine(line); else $('scroll').scrollTop = 0;
  persona?.refreshContext();
}
async function openLink(target) {
  const t = String(target).split('#')[0].split('|')[0].trim();
  if (!t) return;
  const r = await api(`/api/resolve?target=${encodeURIComponent(t)}&from=${encodeURIComponent(S.path || '')}`);
  if (r.path) return openNote(r.path);
  if (r.file) return open(`/api/file?path=${encodeURIComponent(r.file)}`, '_blank', 'noopener');
  // like Obsidian: following a link to a note that doesn't exist yet creates it
  const parts = t.split('/'), name = parts.pop();
  const made = await post('/api/note/new', { name, dir: parts.join('/') || undefined });
  await loadTree(); openNote(made.path);
}
async function newNote(name) {
  await save();
  const r = await post('/api/note/new', { name: name || 'Untitled' });
  await loadTree(); await openNote(r.path);
  $('title').focus(); $('title').select();
}
async function today() { const r = await api('/api/daily'); await loadTree(); openNote(r.path); }

// the title is the file name, as in Obsidian: changing it renames the file (and the links to it)
function renderHeader() {
  const n = S.tree.notes.find(x => x.path === S.path);
  const parts = S.path ? S.path.replace(/\.md$/, '').split('/') : [];
  $('crumbs').innerHTML = parts.map((p, i) => `<span>${esc(p)}</span>`).join('<i>/</i>');
  if (document.activeElement !== $('title')) $('title').value = parts[parts.length - 1] || '';
  $('back').disabled = !S.back.length; $('fwd').disabled = !S.fwd.length;
  void n;
}
async function renameFromTitle() {
  const name = $('title').value.trim().replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
  const cur = S.path?.split('/').pop().replace(/\.md$/, '');
  if (!S.path || !name || name === cur) { renderHeader(); return; }
  await save();
  try {
    const r = await post('/api/note/rename', { path: S.path, to: name });
    S.path = r.path; history.replaceState(null, '', '#' + encodeURI(r.path));
    if (r.relinked.length) toast(`Renamed, and updated links in ${r.relinked.length} note${r.relinked.length > 1 ? 's' : ''}`);
    await loadTree(); renderHeader(); loadLinked();
  } catch (e) { toast(e.message); renderHeader(); }
}
$('title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); renameFromTitle().then(() => editor.focus()); }
  if (e.key === 'Escape') { renderHeader(); editor.focus(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); editor.focus(); }
});
$('title').addEventListener('blur', renameFromTitle);
$('back').onclick = () => { const p = S.back.pop(); if (p) { S.fwd.push(S.path); openNote(p, { push: false }); } };
$('fwd').onclick = () => { const p = S.fwd.pop(); if (p) { S.back.push(S.path); openNote(p, { push: false }); } };

// ---- linked mentions under the page ----
async function loadLinked() {
  if (!S.path) { $('linked').innerHTML = ''; return; }
  const path = S.path;
  const [links, mentions] = await Promise.all([api(`/api/backlinks?path=${encodeURIComponent(path)}`), api(`/api/mentions?path=${encodeURIComponent(path)}`)]);
  if (S.path !== path) return;
  const row = r => `<button class="ref" data-open="${esc(r.path)}"><b>${esc(r.name)}</b>${(r.snippets || []).slice(0, 2).map(s => `<span>${esc(s)}</span>`).join('')}</button>`;
  $('linked').innerHTML =
    (links.length ? `<h3>Linked mentions · ${links.length}</h3>${links.map(row).join('')}` : '') +
    (mentions.length ? `<h3 class="gap">Unlinked mentions · ${mentions.length}</h3>${mentions.slice(0, 8).map(row).join('')}` : '');
}
$('linked').onclick = e => { const b = e.target.closest('[data-open]'); if (b) openNote(b.dataset.open); };

// ---- the vault column: search, files, outline, tags ----
function tree() {
  const root = { folders: new Map(), notes: [] };
  const at = path => {
    let node = root;
    for (const part of path ? path.split('/') : []) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [], path: node.path ? `${node.path}/${part}` : part });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const f of S.tree.folders) at(f);
  for (const n of S.tree.notes) at(n.dir).notes.push(n);
  return root;
}
function renderTree(node, depth = 0) {
  let html = '';
  for (const [name, f] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    if (/^(attachments|assets)$/i.test(name) && !f.notes.length && !f.folders.size) continue;
    const open = S.open.has(f.path);
    html += `<button class="tn${open ? ' open' : ''}" data-folder="${esc(f.path)}" style="padding-left:${8 + depth * 12}px">${ICON.chev}<span class="nm">${esc(name)}</span></button>`;
    if (open) html += renderTree(f, depth + 1);
  }
  for (const n of node.notes.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    html += `<button class="tn${n.path === S.path ? ' on' : ''}" data-open="${esc(n.path)}" style="padding-left:${8 + depth * 12 + 16}px" title="${esc(n.path)}">${ICON.doc}<span class="nm">${esc(n.name)}</span>${n.open ? `<span class="meta" title="${n.open} open task${n.open > 1 ? 's' : ''}">${n.open}</span>` : ''}</button>`;
  }
  return html;
}
function group(id, title, body, end = '') {
  const closed = S.closed.has(id);
  return `<div class="grp${closed ? ' closed' : ''}" data-grp="${id}"><button class="grp-h" data-toggle="${id}">${ICON.chev}${esc(title)}<span class="end">${end}</span></button><div class="grp-b">${body}</div></div>`;
}
function renderSide() {
  if (S.results) {
    const rs = S.results;
    $('side').innerHTML = group('results', S.tagFilter ? `#${S.tagFilter}` : 'Results', rs.length ? rs.map(r => `<button class="res" data-open="${esc(r.path)}"><b>${esc(r.name)}</b>${r.dir ? `<i>${esc(r.dir)}</i>` : ''}${r.snippet ? `<span>${esc(r.snippet)}</span>` : ''}</button>`).join('') : '<div class="empty" style="padding:6px 8px">Nothing found.</div>', `${rs.length}`);
    return;
  }
  const recent = [...S.tree.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 5);
  const n = S.tree.notes.find(x => x.path === S.path);
  const outline = n ? (outlineOf(editor.getDoc())) : [];
  $('side').innerHTML =
    group('recent', 'Recent', recent.map(r => `<button class="tn${r.path === S.path ? ' on' : ''}" data-open="${esc(r.path)}">${ICON.doc}<span class="nm">${esc(r.name)}</span></button>`).join('') || '<div class="empty" style="padding:4px 8px">No notes yet.</div>') +
    group('files', 'Notes', renderTree(tree()) || '<div class="empty" style="padding:4px 8px">Empty vault.</div>', `${S.tree.notes.length}`) +
    (outline.length ? `<div class="outline">${group('outline', 'Outline', outline.map(h => `<button class="tn" data-line="${h.line}" style="padding-left:${8 + (h.level - 1) * 12}px"><span class="nm">${esc(h.text)}</span></button>`).join(''))}</div>` : '') +
    (S.tags.length ? group('tags', 'Tags', `<div class="tagcloud">${S.tags.slice(0, 40).map(t => `<button data-tag="${esc(t.tag)}">#${esc(t.tag)}</button>`).join('')}</div>`) : '');
}
const outlineOf = text => {
  const out = []; let code = false;
  text.split('\n').forEach((l, i) => { if (/^\s*(```|~~~)/.test(l)) code = !code; const m = !code && /^(#{1,6})\s+(.+)$/.exec(l); if (m) out.push({ line: i + 1, level: m[1].length, text: m[2] }); });
  return out;
};
$('side').onclick = e => {
  const t = e.target.closest('[data-toggle]'); if (t) { const id = t.dataset.toggle; S.closed.has(id) ? S.closed.delete(id) : S.closed.add(id); keep(); renderSide(); return; }
  const f = e.target.closest('[data-folder]'); if (f) { const p = f.dataset.folder; S.open.has(p) ? S.open.delete(p) : S.open.add(p); keep(); renderSide(); return; }
  const o = e.target.closest('[data-open]'); if (o) { openNote(o.dataset.open); return; }
  const l = e.target.closest('[data-line]'); if (l) { editor.scrollToLine(Number(l.dataset.line)); editor.focus(); return; }
  const g = e.target.closest('[data-tag]'); if (g) showTag(g.dataset.tag);
};
let searchTimer = null;
$('q').oninput = e => {
  S.q = e.target.value; S.tagFilter = null;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { S.results = S.q.trim() ? await api(`/api/search?q=${encodeURIComponent(S.q)}`) : null; renderSide(); }, 150);
};
$('q').onkeydown = e => { if (e.key === 'Escape') { $('q').value = ''; S.q = ''; S.results = null; renderSide(); } if (e.key === 'Enter' && S.results?.[0]) openNote(S.results[0].path); };
async function showTag(tag) {
  S.tagFilter = tag; S.q = `#${tag}`; $('q').value = S.q;
  S.results = (await api(`/api/tagged?tag=${encodeURIComponent(tag)}`)).map(r => ({ ...r, snippet: '' }));
  renderSide();
}
$('newNote').onclick = () => newNote();
$('today').onclick = () => today();

// ---- the More menu ----
$('more').onclick = e => {
  if (!S.path) return;
  const r = e.currentTarget.getBoundingClientRect();
  $('menu').innerHTML = `<div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
    <button data-m="rename">Rename</button><button data-m="move">Move to folder…</button><button data-m="copy">Copy link</button><button data-m="editor">Ask the Editor about this note</button>
    <hr><button class="danger" data-m="delete">Move to trash</button></div>`;
};
addEventListener('mousedown', e => { if ($('menu').innerHTML && !e.target.closest('.menu, #more')) $('menu').innerHTML = ''; });
$('menu').onclick = async e => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  $('menu').innerHTML = '';
  const name = S.path.split('/').pop().replace(/\.md$/, '');
  if (b.dataset.m === 'rename') { $('title').focus(); $('title').select(); }
  if (b.dataset.m === 'copy') { await navigator.clipboard.writeText(`[[${name}]]`).catch(() => {}); toast(`Copied [[${name}]]`); }
  if (b.dataset.m === 'editor') persona.prefill('About this note: ');
  if (b.dataset.m === 'move') {
    const dir = prompt('Move to which folder? (empty for the top of the vault)', S.path.includes('/') ? S.path.slice(0, S.path.lastIndexOf('/')) : '');
    if (dir === null) return;
    await save();
    try { const r = await post('/api/note/rename', { path: S.path, to: `${dir.replace(/^\/|\/$/g, '')}${dir ? '/' : ''}${name}.md` }); S.path = r.path; await loadTree(); openNote(r.path, { push: false }); }
    catch (err) { toast(err.message); }
  }
  if (b.dataset.m === 'delete' && confirm(`Move “${name}” to the trash? It goes to the vault’s .trash folder, as in Obsidian.`)) {
    await post('/api/note/delete', { path: S.path });
    S.path = null; S.dirty = false; await loadTree(); showPage(false); renderSide();
  }
};

// ---- the blank page ----
function showPage(on) {
  $('page').hidden = !on; $('blank').hidden = on;
  if (!on) {
    $('crumbs').innerHTML = ''; $('saveState').textContent = '';
    $('blank').innerHTML = `<div><div class="glyph">${ICON.book}</div><b>${S.tree.notes.length ? 'Pick a note, or start one' : 'Your notes'}</b>
      <p>Plain Markdown in ${esc(S.vault.home ? S.vault.home.replace(/^\/(home|Users)\/[^/]+|^\/workspace\/home/, '~') : 'your vault')}, ready for Obsidian, git and your agents.</p>
      <div class="row-btns"><button class="btn primary" data-b="new">New note</button><button class="btn" data-b="today">Today’s note</button></div></div>`;
  }
}
$('blank').onclick = e => { const b = e.target.closest('[data-b]'); if (b?.dataset.b === 'new') newNote(); if (b?.dataset.b === 'today') today(); };

// ---- keyboard ----
addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'n') { e.preventDefault(); newNote(); }
  if (mod && e.key === 'o') { e.preventDefault(); $('q').focus(); }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('q').focus(); }
  if (mod && e.key === '[') { e.preventDefault(); $('back').click(); }
  if (mod && e.key === ']') { e.preventDefault(); $('fwd').click(); }
});
addEventListener('beforeunload', e => { if (S.dirty) { save(); e.preventDefault(); } });

// ---- the Editor ----
// the Editor floats in the page's top corner: ⌘J or its avatar to talk, bubbles that fade over the page
const persona = mountFloatingPersona($('pagePane'), {
  base: '/api/editor', name: 'Editor', role: 'Your notes',
  placeholder: c => c?.label ? `Ask the Editor about “${c.label.split(' · ')[0]}”…` : 'Ask the Editor…',
  onClose: how => { if (!how?.byClick) editor.focus(); },   // a click elsewhere puts focus where you clicked
  avatar: { color: 'linear-gradient(160deg, #ffb340, #ff9500 55%, #d26a00)', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>' },
  
  hello: {
    text: 'I keep your notes tidy and find what’s in them. Ask me to summarize, link related notes, file things away, or turn a meeting dump into clean notes. I edit the same Markdown files you do.',
    suggestions: () => S.path ? ['Summarize this note', 'Link this note to related ones', 'Turn this into clean, sectioned notes'] : ['What’s in my vault?', 'Start today’s note with my open tasks', 'Which notes link to nothing?'],
  },
  context: () => {
    if (!S.path) return null;
    const sel = editor.selection();
    const name = S.path.split('/').pop().replace(/\.md$/, '');
    const line = editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number;
    return { label: sel ? `${name} · “${sel.slice(0, 40)}${sel.length > 40 ? '…' : ''}”` : name, ref: { note: S.path, line }, note: S.path, selection: sel || null, line };
  },
  refFor: text => {
    const t = String(text).replace(/^\[\[|\]\]$/g, '').replace(/\.md$/, '').toLowerCase();
    const n = S.tree.notes.find(x => x.name.toLowerCase() === t || x.path.toLowerCase().replace(/\.md$/, '') === t);
    return n ? { note: n.path } : null;
  },
  open: ref => ref?.note && openNote(ref.note, { line: ref.line }),
});

// ---- load and stay live ----
// AGENTS.md and CLAUDE.md at the top of the vault are for agents; the vault column leaves them out
const forAgents = p => /^(AGENTS|CLAUDE)\.md$/.test(p);
async function loadTree() {
  const [tree, tags] = await Promise.all([api('/api/tree'), api('/api/tags')]);
  tree.notes = tree.notes.filter(n => !forAgents(n.path));
  S.tree = tree; S.tags = tags; knownSet = known();
  editor.refresh();
}
function live() {
  const es = new EventSource('/api/events');
  es.onmessage = async e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'tree') { await loadTree(); renderSide(); renderHeader(); if (S.path && !S.tree.notes.some(n => n.path === S.path)) { toast('This note was moved or deleted'); } }
    if (ev.type === 'note') {
      if (ev.path === S.path && ev.hash && ev.hash !== S.base) {
        // someone else wrote this note: take it when we have nothing unsaved, else ask
        const note = await api(`/api/note?path=${encodeURIComponent(S.path)}`).catch(() => null);
        if (!note || note.hash === S.base) return;
        if (S.dirty || S.saving) showConflict(note.text, note.hash);
        else { setText(note.text); S.base = note.hash; saveState(); renderSide(); }
      }
      if (ev.path !== S.path) loadLinked();
      clearTimeout(live.t); live.t = setTimeout(async () => { await loadTree(); renderSide(); }, 300);
    }
  };
}
S.vault = await api('/api/vault');
await loadTree();
const start = decodeURI(location.hash.slice(1)) || localStorage.getItem('notes-last');
if (start && S.tree.notes.some(n => n.path === start)) await openNote(start, { push: false });
else { showPage(false); renderSide(); }
live();
addEventListener('hashchange', () => { const p = decodeURI(location.hash.slice(1)); if (p && p !== S.path) openNote(p); });
setInterval(() => { if (S.path) renderSide(); }, 15000);   // the outline follows your headings
