// The vault: a folder of Markdown files that Obsidian opens as it is. This module reads it the way Obsidian does
// and never writes anything Obsidian wouldn't:
//
//   notes          *.md anywhere, except dot-folders (.obsidian, .trash, .git) and node_modules
//   properties     YAML front matter between --- lines at the top
//   links          [[Note]], [[Note#Heading]], [[Note|alias]], [[folder/Note]]; ![[embeds]] of notes and files
//   tags           #tag in the text (not in code) and `tags:` in the front matter
//   tasks          - [ ] and - [x]
//   attachments    every other file; embeds resolve by name anywhere in the vault, as Obsidian's do
//
// A link resolves like Obsidian's: a path if it has a slash, else the note with that name, preferring the linking
// note's own folder, then the shortest path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const hash = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
const SKIP = name => name.startsWith('.') || name === 'node_modules';

// ---- parsing one note ----
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text);
  if (!m) return { props: {}, body: text, end: 0 };
  const props = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) { props[key] = [].concat(Array.isArray(props[key]) ? props[key] : props[key] ? [props[key]] : [], unq(item[1])); continue; }
    const kv = /^([^\s:#][^:]*?):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1].trim();
    const v = kv[2].trim();
    props[key] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map(s => unq(s.trim())).filter(Boolean) : v === '' ? '' : unq(v);
  }
  return { props, body: text.slice(m[0].length), end: m[0].length };
}
const unq = s => s.replace(/^(['"])(.*)\1$/, '$2');

// text with code (fenced, indented-fence and inline) blanked, so links and tags inside code don't count
function withoutCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]+`/g, m => ' '.repeat(m.length));
}

export function parseNote(text) {
  const { props, body, end } = frontmatter(text);
  const clean = ' '.repeat(end) + withoutCode(text.slice(end));
  const links = [], tags = new Set(), tasks = [], headings = [];
  for (const m of clean.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/g)) {
    const raw = m[2], pipe = raw.indexOf('|');
    const target = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim();
    links.push({ target: target.split('#')[0].split('^')[0].trim(), anchor: target.includes('#') ? target.slice(target.indexOf('#') + 1) : null, embed: m[1] === '!', at: m.index });
  }
  for (const m of clean.matchAll(/\[[^\]\n]*\]\(([^)\s]+\.md)(#[^)]*)?\)/g)) links.push({ target: decodeURIComponent(m[1]).replace(/\.md$/, ''), anchor: null, embed: false, at: m.index, md: true });
  for (const m of clean.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
    const lineStart = clean.lastIndexOf('\n', m.index) + 1;
    if (/^#{1,6}\s/.test(clean.slice(lineStart, lineStart + 7)) && lineStart === m.index + m[1].length) continue;
    tags.add(m[2]);
  }
  const fmTags = props.tags ?? props.tag;
  for (const t of [].concat(fmTags || [])) for (const x of String(t).split(/[,\s]+/)) if (x) tags.add(x.replace(/^#/, ''));
  const lines = text.split('\n'), fmLines = text.slice(0, end).split('\n').length - 1;
  let inCode = false;
  lines.forEach((line, i) => {
    if (i < fmLines) return;
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    if (inCode) return;
    const t = /^\s*[-*+] \[([ xX])\] (.*)$/.exec(line);
    if (t) tasks.push({ line: i + 1, done: t[1] !== ' ', text: t[2] });
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) headings.push({ line: i + 1, level: h[1].length, text: h[2].trim() });
  });
  return { props, links, tags: [...tags], tasks, headings, words: (body.match(/\S+/g) || []).length };
}

// ---- the whole vault ----
export function createVault(root) {
  let notes = new Map();          // path → { path, name, dir, mtime, size, hash, parsed }
  let files = new Map();          // attachment path → { path, name, mtime, size }
  let folders = new Set();
  const texts = new Map();        // path → text (for search), bounded by size

  const rel = abs => path.relative(root, abs).split(path.sep).join('/');
  const nameOf = p => path.posix.basename(p).replace(/\.md$/i, '');

  function scan() {
    const seen = new Map(), seenFiles = new Map(), seenFolders = new Set();
    const walk = dir => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (SKIP(e.name)) continue;
        const abs = path.join(dir, e.name), p = rel(abs);
        if (e.isDirectory()) { seenFolders.add(p); walk(abs); continue; }
        if (!e.isFile()) continue;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (/\.md$/i.test(e.name)) {
          const old = notes.get(p);
          if (old && old.mtime === st.mtimeMs && old.size === st.size) { seen.set(p, old); continue; }
          let text = '';
          try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
          seen.set(p, { path: p, name: nameOf(p), dir: path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p), mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs, size: st.size, hash: hash(text), parsed: parseNote(text) });
          if (text.length < 2e6) texts.set(p, text);
        } else seenFiles.set(p, { path: p, name: path.posix.basename(p), mtime: st.mtimeMs, size: st.size });
      }
    };
    walk(root);
    const changed = [];
    for (const [p, n] of seen) if (notes.get(p)?.hash !== n.hash) changed.push(p);
    for (const p of notes.keys()) if (!seen.has(p)) { changed.push(p); texts.delete(p); }
    const treeChanged = changed.length || seenFiles.size !== files.size || seenFolders.size !== folders.size || [...seenFolders].some(f => !folders.has(f));
    notes = seen; files = seenFiles; folders = seenFolders;
    return { changed, treeChanged: Boolean(treeChanged) };
  }

  // Obsidian's resolution: a path when there is a slash, else by name, nearest folder first, then shortest path
  function resolve(target, from = '') {
    if (!target) return null;
    const t = target.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.md$/i, '');
    const lower = t.toLowerCase();
    if (t.includes('/')) {
      for (const p of notes.keys()) if (p.toLowerCase() === lower + '.md' || p.toLowerCase().endsWith('/' + lower + '.md')) return p;
      return null;
    }
    const hits = [...notes.values()].filter(n => n.name.toLowerCase() === lower);
    if (!hits.length) return null;
    const dir = path.posix.dirname(from);
    hits.sort((a, b) => (b.dir === dir) - (a.dir === dir) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
    return hits[0].path;
  }
  function resolveFile(target, from = '') {
    const t = target.split('|')[0].split('#')[0].trim().replace(/^\.\//, '');
    if (files.has(t)) return t;
    const near = path.posix.join(path.posix.dirname(from), t);
    if (files.has(near)) return near;
    const name = path.posix.basename(t).toLowerCase();
    const hits = [...files.values()].filter(f => f.name.toLowerCase() === name).sort((a, b) => a.path.length - b.path.length);
    return hits[0]?.path || null;
  }

  function backlinks(p) {
    const out = [];
    for (const n of notes.values()) {
      if (n.path === p) continue;
      const hits = n.parsed.links.filter(l => resolve(l.target, n.path) === p);
      if (!hits.length) continue;
      const text = texts.get(n.path) || '';
      out.push({ path: n.path, name: n.name, dir: n.dir, count: hits.length, snippets: hits.slice(0, 3).map(h => snippet(text, h.at)) });
    }
    return out.sort((a, b) => (notes.get(b.path).mtime) - (notes.get(a.path).mtime));
  }
  // notes that mention this one's name in plain text without linking it (Obsidian's "unlinked mentions")
  function mentions(p) {
    const n = notes.get(p); if (!n || n.name.length < 3) return [];
    const re = new RegExp(`(?<![\\[\\p{L}\\p{N}])${n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}\\]])`, 'iu');
    const out = [];
    for (const [q, text] of texts) {
      if (q === p) continue;
      const m = re.exec(text);
      if (m && !notes.get(q)?.parsed.links.some(l => resolve(l.target, q) === p)) out.push({ path: q, name: notes.get(q)?.name, snippets: [snippet(text, m.index)] });
      if (out.length >= 20) break;
    }
    return out;
  }
  const snippet = (text, at) => {
    const s = text.lastIndexOf('\n', at) + 1, e = text.indexOf('\n', at);
    return text.slice(s, e < 0 ? undefined : e).trim().slice(0, 240);
  };

  function search(q, limit = 40) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    const out = [];
    for (const n of notes.values()) {
      const text = (texts.get(n.path) || '').toLowerCase();
      const inName = n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q);
      if (!inName && !words.every(w => text.includes(w))) continue;
      const at = text.indexOf(words[0]);
      out.push({ path: n.path, name: n.name, dir: n.dir, score: (inName ? 100 : 0) + words.reduce((s, w) => s + (text.split(w).length - 1), 0), snippet: at >= 0 ? snippet(texts.get(n.path), at) : '' });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  function tags() {
    const count = new Map();
    for (const n of notes.values()) for (const t of n.parsed.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count].map(([tag, n]) => ({ tag, count: n })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
  function tagged(tag) {
    const t = tag.toLowerCase();
    return [...notes.values()].filter(n => n.parsed.tags.some(x => x.toLowerCase() === t || x.toLowerCase().startsWith(t + '/'))).map(n => ({ path: n.path, name: n.name, dir: n.dir, mtime: n.mtime }));
  }
  function tasks({ open = true } = {}) {
    const out = [];
    for (const n of notes.values()) for (const t of n.parsed.tasks) if (!open || !t.done) out.push({ ...t, path: n.path, name: n.name });
    return out;
  }
  function unresolved() {
    const out = new Map();
    for (const n of notes.values()) for (const l of n.parsed.links) if (!l.embed && !l.md && l.target && !resolve(l.target, n.path)) out.set(l.target, [...(out.get(l.target) || []), n.path]);
    return [...out].map(([target, from]) => ({ target, from }));
  }

  scan();
  return {
    root, scan, resolve, resolveFile, backlinks, mentions, search, tags, tagged, tasks, unresolved,
    note: p => notes.get(p) || null,
    notes: () => [...notes.values()],
    files: () => [...files.values()],
    folders: () => [...folders].sort(),
    text: p => texts.get(p),
  };
}
