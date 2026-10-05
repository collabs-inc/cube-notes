// Cube Write — an Obsidian-compatible vault for people and agents.
//   node server/server.mjs        → http://127.0.0.1:$PORT (as a Cube app: behind Cube's gate)
//
// The Editor (the kit's persona) on the left, the page in the middle, the vault on the right. The vault is plain
// Markdown on disk (vault.mjs), so an agent can edit the files directly: every change on disk, from anyone, reaches
// the page through /api/events, and a page that has unsaved typing gets a conflict instead of losing it.
//
//   GET  /api/tree                         notes, folders and attachments
//   GET  /api/note?path=                   { path, text, hash }
//   PUT  /api/note                         { path, text, base }  → { hash } · 409 { text, hash } when disk moved on
//   POST /api/note/new                     { dir?, name?, text? } → { path }
//   POST /api/note/rename                  { path, to }  (links to it are rewritten, as Obsidian does)
//   POST /api/note/delete                  { path }      (moved to .trash/, as Obsidian does)
//   POST /api/folder                       { path }
//   GET  /api/daily                        today's daily note, created if needed → { path }
//   GET  /api/backlinks?path=  /api/mentions?path=  /api/search?q=  /api/tags  /api/tagged?tag=  /api/tasks  /api/resolve?target=&from=
//   GET  /api/file?path=&from=             an attachment (resolved by name like an embed)
//   POST /api/upload?name=&from=           raw bytes → saved in the attachments folder → { name, path }
//   GET  /api/events                       server-sent events: { type: "note", path, hash } · { type: "tree" }
//   /api/editor/…                          the persona (kit/persona.mjs)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { APP, STATE, home, obsidian } from './paths.mjs';
import { createVault, hash } from './vault.mjs';
import { createPersona } from '../kit/persona.mjs';

const PORT = Number(process.env.PORT || 4322);
const URL_SELF = `http://127.0.0.1:${PORT}`;
const HOME = home();
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
const vault = createVault(HOME);

// ---- live updates ----
const clients = new Set();
const broadcast = ev => { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(data); };
let rescanTimer = null;
function rescan() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    const { changed, treeChanged } = vault.scan();
    if (treeChanged) syncWatchers();
    for (const p of changed) broadcast({ type: 'note', path: p, hash: vault.note(p)?.hash || null });
    if (treeChanged) broadcast({ type: 'tree' });
  }, 120);
}
// One watcher per folder. Node's recursive watch on Linux loses a file once it is replaced by rename (which is how
// this server, editors and git all write), so each folder is watched for its entries instead, and the set of
// folders is re-synced after every scan.
const watchers = new Map();
function syncWatchers() {
  const want = new Set(['', ...vault.folders()]);
  for (const [dir, w] of watchers) if (!want.has(dir)) { w.close(); watchers.delete(dir); }
  for (const dir of want) {
    if (watchers.has(dir)) continue;
    try { watchers.set(dir, fs.watch(path.join(HOME, dir), (ev, f) => { if (!f || !String(f).startsWith('.') || /\.tmp$/.test(f)) rescan(); })); } catch {}
  }
}
syncWatchers();
setInterval(rescan, 30000);                          // a slow safety net, for anything a watcher misses

// ---- paths inside the vault, never outside it, never into a dot-folder ----
function inVault(p, { md = false } = {}) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some(s => s === '..' || s.startsWith('.'))) throw new Error('not a path in the vault');
  if (md && !/\.md$/i.test(clean)) throw new Error('a note is a .md file');
  const abs = path.join(HOME, clean);
  if (!abs.startsWith(HOME + path.sep)) throw new Error('not a path in the vault');
  return { rel: clean, abs };
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
function unique(dir, base, ext) {
  let n = 0, name;
  do { name = `${base}${n ? ` ${n}` : ''}${ext}`; n++; } while (fs.existsSync(path.join(HOME, dir, name)));
  return path.posix.join(dir, name);
}
function writeAtomic(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, abs);
}

// ---- daily notes, in Obsidian's folder and format ----
function dailyName(d, fmt) {
  const pad = n => String(n).padStart(2, '0');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return fmt.replace(/YYYY|MMMM|MMM|MM|DD|dddd|ddd|D|M/g, t => ({ YYYY: d.getFullYear(), MMMM: months[d.getMonth()], MMM: months[d.getMonth()].slice(0, 3), MM: pad(d.getMonth() + 1), M: d.getMonth() + 1, DD: pad(d.getDate()), D: d.getDate(), dddd: days[d.getDay()], ddd: days[d.getDay()].slice(0, 3) })[t]);
}
function daily() {
  const o = obsidian(HOME), name = dailyName(new Date(), o.dailyFormat);
  const rel = path.posix.join(o.dailyFolder, `${name}.md`);
  const abs = path.join(HOME, rel);
  if (!fs.existsSync(abs)) {
    let text = '';
    if (o.dailyTemplate) { try { text = fs.readFileSync(path.join(HOME, o.dailyTemplate.replace(/\.md$/, '') + '.md'), 'utf8'); } catch {} }
    writeAtomic(abs, text.replaceAll('{{date}}', name).replaceAll('{{title}}', name));
    vault.scan(); broadcast({ type: 'tree' });
  }
  return rel;
}

// rewrite [[links]] that resolved to `from` so they point at `to`, the way Obsidian does on rename
function relink(fromRel, toRel) {
  const newName = path.posix.basename(toRel, '.md');
  // the bare name is enough unless another note already has it
  const ambiguous = vault.notes().some(n => n.path !== fromRel && n.name.toLowerCase() === newName.toLowerCase());
  const touched = [];
  for (const n of vault.notes()) {
    if (!n.parsed.links.some(l => vault.resolve(l.target, n.path) === fromRel)) continue;
    const abs = path.join(HOME, n.path);
    const text = fs.readFileSync(abs, 'utf8');
    const next = text.replace(/(!?)\[\[([^\[\]\n|#^]+)([#^][^\[\]\n|]*)?(\|[^\[\]\n]*)?\]\]/g, (m, bang, target, anchor = '', alias = '') => {
      if (vault.resolve(target.trim(), n.path) !== fromRel) return m;
      const t = target.includes('/') || ambiguous ? toRel.replace(/\.md$/, '') : newName;
      return `${bang}[[${t}${anchor}${alias}]]`;
    });
    if (next !== text) { writeAtomic(abs, next); touched.push(n.path); }
  }
  return touched;
}

// ---- the Editor ----
const fill = text => text.replaceAll('{{APP}}', APP).replaceAll('{{HOME}}', HOME).replaceAll('{{STATE}}', STATE).replaceAll('{{URL}}', URL_SELF);
const editor = createPersona({
  name: 'Editor',
  dir: path.join(STATE, 'editor'),
  cwd: HOME,
  brief: () => { try { return fill(fs.readFileSync(path.join(APP, 'editor', 'EDITOR.md'), 'utf8')); } catch { return ''; } },
  env: () => ({ NOTES_APP: APP, NOTES_HOME: HOME, NOTES_STATE: STATE, NOTES_URL: URL_SELF }),
  models: { claude: process.env.NOTES_CLAUDE_MODEL, codex: process.env.NOTES_CODEX_MODEL },
  describe(c) {
    if (!c.note) return '';
    const n = vault.note(c.note);
    const sel = c.selection ? ` They have selected: «${String(c.selection).slice(0, 2000)}».` : '';
    return `[Cube Write: the user is looking at the note ${c.note}${n ? ` (${HOME}/${c.note})` : ''}${c.line ? `, around line ${c.line}` : ''}.${sel}]`;
  },
  eventPrompt: details => `[Cube Write: ${details.join('\n')}]`,
});

// ---- http ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
function body(req, res, fn, limit = 8e6) {
  const chunks = []; let size = 0;
  req.on('data', d => { size += d.length; if (size > limit) { send(res, 413, { error: 'too large' }); req.destroy(); } else chunks.push(d); });
  req.on('end', () => {
    let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return send(res, 400, { error: `not JSON: ${e.message}` }); }
    try { fn(b); } catch (e) { send(res, 400, { error: e.message }); }
  });
}
function serveFile(res, abs) {
  let st; try { st = fs.statSync(abs); } catch { return send(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
  fs.createReadStream(abs).pipe(res);
}
const noteView = n => ({ path: n.path, name: n.name, dir: n.dir, mtime: n.mtime, ctime: n.ctime, words: n.parsed.words, tags: n.parsed.tags, tasks: n.parsed.tasks.length, open: n.parsed.tasks.filter(t => !t.done).length });

function route(req, res) {
  const url = new URL(req.url, 'http://x');
  let p; try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'bad url', 'text/plain'); }
  const q = k => url.searchParams.get(k) || '';
  if (editor.route(req, res, p, '/api/editor', { body, send })) return;
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': hi\n\n'); clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (p === '/api/vault') return send(res, 200, { home: HOME, app: APP, notes: vault.notes().length, obsidian: fs.existsSync(path.join(HOME, '.obsidian')), editor: editor.status() });
  if (p === '/api/tree') return send(res, 200, { notes: vault.notes().map(noteView), folders: vault.folders(), files: vault.files().map(f => ({ path: f.path, name: f.name, size: f.size })) });
  if (p === '/api/note' && req.method === 'GET') {
    const { rel, abs } = inVault(q('path'), { md: true });
    try { const text = fs.readFileSync(abs, 'utf8'); return send(res, 200, { path: rel, text, hash: hash(text), resolved: vault.note(rel) ? noteView(vault.note(rel)) : null }); }
    catch { return send(res, 404, { error: 'no such note' }); }
  }
  if (p === '/api/note' && req.method === 'PUT') return body(req, res, b => {
    const { rel, abs } = inVault(b.path, { md: true });
    let cur = null; try { cur = fs.readFileSync(abs, 'utf8'); } catch {}
    if (cur !== null && b.base && hash(cur) !== b.base && cur !== b.text) return send(res, 409, { error: 'changed on disk', text: cur, hash: hash(cur) });
    if (cur !== b.text) writeAtomic(abs, String(b.text ?? ''));
    rescan();
    send(res, 200, { path: rel, hash: hash(String(b.text ?? '')) });
  });
  if (p === '/api/note/new' && req.method === 'POST') return body(req, res, b => {
    const dir = b.dir ? inVault(b.dir).rel : obsidian(HOME).newNoteFolder;
    const rel = unique(dir, safeName(b.name) || 'Untitled', '.md');
    writeAtomic(path.join(HOME, rel), String(b.text ?? ''));
    vault.scan(); broadcast({ type: 'tree' });
    send(res, 200, { path: rel });
  });
  if (p === '/api/note/rename' && req.method === 'POST') return body(req, res, b => {
    const from = inVault(b.path, { md: true });
    let to = String(b.to || '').trim();
    if (!/\.md$/i.test(to)) to = path.posix.join(path.posix.dirname(from.rel) === '.' ? '' : path.posix.dirname(from.rel), safeName(to) + '.md');
    const dest = inVault(to, { md: true });
    if (dest.rel === from.rel) return send(res, 200, { path: from.rel, relinked: [] });
    if (fs.existsSync(dest.abs)) throw new Error(`${dest.rel} already exists`);
    // rewrite the links first, while the vault still resolves them to the old path; then move the file
    const relinked = relink(from.rel, dest.rel);
    fs.mkdirSync(path.dirname(dest.abs), { recursive: true });
    fs.renameSync(from.abs, dest.abs);
    vault.scan(); broadcast({ type: 'tree' });
    for (const r of relinked) broadcast({ type: 'note', path: r, hash: vault.note(r)?.hash });
    send(res, 200, { path: dest.rel, relinked });
  });
  if (p === '/api/note/delete' && req.method === 'POST') return body(req, res, b => {
    const { rel, abs } = inVault(b.path);
    const trash = path.join(HOME, '.trash', rel);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(abs, fs.existsSync(trash) ? `${trash}.${Date.now()}` : trash);
    vault.scan(); broadcast({ type: 'tree' });
    send(res, 200, { trashed: rel });
  });
  if (p === '/api/folder' && req.method === 'POST') return body(req, res, b => { const { rel, abs } = inVault(b.path); fs.mkdirSync(abs, { recursive: true }); vault.scan(); broadcast({ type: 'tree' }); send(res, 200, { path: rel }); });
  if (p === '/api/daily') return send(res, 200, { path: daily() });
  if (p === '/api/backlinks') return send(res, 200, vault.backlinks(inVault(q('path'), { md: true }).rel));
  if (p === '/api/mentions') return send(res, 200, vault.mentions(inVault(q('path'), { md: true }).rel));
  if (p === '/api/search') return send(res, 200, vault.search(q('q')));
  if (p === '/api/tags') return send(res, 200, vault.tags());
  if (p === '/api/tagged') return send(res, 200, vault.tagged(q('tag')));
  if (p === '/api/tasks') return send(res, 200, vault.tasks({ open: q('all') !== '1' }));
  if (p === '/api/unresolved') return send(res, 200, vault.unresolved());
  if (p === '/api/resolve') return send(res, 200, { path: vault.resolve(q('target'), q('from')), file: vault.resolveFile(q('target'), q('from')) });
  if (p === '/api/file') {
    const target = q('path'), from = q('from');
    const found = vault.resolveFile(target, from);
    if (!found) return send(res, 404, { error: 'no such file' });
    return serveFile(res, inVault(found).abs);
  }
  if (p === '/api/upload' && req.method === 'POST') {
    const name = safeName(path.basename(q('name') || 'Pasted image.png')) || 'Pasted image.png';
    const ext = path.extname(name) || '.png', base = name.slice(0, name.length - ext.length) || 'Pasted image';
    const dir = obsidian(HOME).attachments;
    const chunks = []; let size = 0;
    req.on('data', d => { size += d.length; if (size > 50e6) req.destroy(); else chunks.push(d); });
    req.on('end', () => {
      const rel = unique(dir, base === 'image' ? `Pasted image ${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}` : base, ext);
      fs.mkdirSync(path.join(HOME, dir), { recursive: true });
      fs.writeFileSync(path.join(HOME, rel), Buffer.concat(chunks));
      vault.scan(); broadcast({ type: 'tree' });
      send(res, 200, { name: path.posix.basename(rel), path: rel });
    });
    return;
  }
  if (p.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
  // the app's own page and assets
  const rel = p === '/' ? '/web/index.html' : p;
  if (!/^\/(web|kit)\//.test(rel)) return send(res, 404, 'not found', 'text/plain');
  const abs = path.join(APP, rel);
  if (!abs.startsWith(APP + path.sep)) return send(res, 404, 'not found', 'text/plain');
  let st; try { st = fs.statSync(abs); } catch { return send(res, 404, 'not found', 'text/plain'); }
  if (!st.isFile()) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
}

http.createServer((req, res) => {
  try { route(req, res); } catch (e) { if (!res.headersSent) send(res, 400, { error: String(e.message || e) }); else res.destroy(); }
}).listen(PORT, '127.0.0.1', () => console.log(`Cube Write → ${URL_SELF}  (vault ${HOME})`));
process.on('uncaughtException', e => console.error('notes: uncaught', e));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { editor.shutdown(); process.exit(0); });
