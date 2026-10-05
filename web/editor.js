// The Notes editor: CodeMirror 6 with an Obsidian-style live preview. The file is plain Markdown and stays exactly
// what was typed: rendering is decoration only. Off the line you are editing, syntax hides and the text renders
// (headings sized, emphasis, links, [[wiki links]], ![[embeds]], #tags, checkboxes, quotes, code, rules); on the
// line you are editing, everything is raw.
//
// Bundled to editor.bundle.js (npm run build), so the app installs with no build step.
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection, dropCursor, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxTree, indentOnInput } from '@codemirror/language';
import { autocompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

// ---- widgets ----
class Bullet extends WidgetType {
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = '•'; return s; }
  ignoreEvent() { return false; }
}
class Checkbox extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const b = document.createElement('span');
    b.className = `cm-check${this.checked ? ' on' : ''}`;
    b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', String(this.checked));
    b.onmousedown = e => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    };
    return b;
  }
  ignoreEvent() { return true; }
}
class Label extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-fm-label'; s.textContent = this.text; return s; }
}
class Rule extends WidgetType {
  toDOM() { const d = document.createElement('span'); d.className = 'cm-hr'; return d; }
}
class Img extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src; }
  toDOM() {
    const w = document.createElement('span'); w.className = 'cm-img';
    const i = document.createElement('img'); i.src = this.src; i.alt = this.alt || ''; i.loading = 'lazy';
    w.appendChild(i); return w;
  }
  ignoreEvent() { return false; }
}

const hide = Decoration.replace({});
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

// ---- the live preview ----
function livePreview(opts) {
  function activeLines(state) {
    const set = new Set();
    for (const r of state.selection.ranges) {
      const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) set.add(n);
    }
    return set;
  }
  function frontmatterEnd(doc) {
    if (doc.lines < 2 || doc.line(1).text !== '---') return 0;
    for (let n = 2; n <= Math.min(doc.lines, 400); n++) if (/^(---|\.\.\.)$/.test(doc.line(n).text)) return n;
    return 0;
  }

  function build(view) {
    const { state } = view, doc = state.doc;
    const active = view.hasFocus ? activeLines(state) : new Set();
    const isActive = pos => active.has(doc.lineAt(pos).number);
    const deco = [];     // [from, to, decoration, replaces] — sorted at the end
    const add = (from, to, d) => deco.push([from, to, d, d === hide || Boolean(d.spec.widget)]);
    const lineClass = (pos, cls) => add(doc.lineAt(pos).from, doc.lineAt(pos).from, Decoration.line({ class: cls }));
    const code = [];     // ranges where wiki links and tags don't apply

    // front matter: a quiet properties block
    // front matter: Obsidian's Properties block, raw YAML while the cursor is in it
    const fmEnd = frontmatterEnd(doc);
    if (fmEnd) {
      let editing = false;
      for (let n = 1; n <= fmEnd; n++) if (active.has(n)) editing = true;
      for (let n = 1; n <= fmEnd; n++) {
        const line = doc.line(n);
        lineClass(line.from, `cm-fm${n === 1 ? ' cm-fm-first' : ''}${n === fmEnd ? ' cm-fm-last' : ''}${editing ? ' cm-fm-raw' : ''}`);
        if (editing) continue;
        if (n === 1) add(line.from, line.to, Decoration.replace({ widget: new Label('Properties') }));
        else if (n === fmEnd) add(line.from, line.to, hide);
        else { const kv = /^([^\s:#][^:]*):/.exec(line.text); if (kv) add(line.from, line.from + kv[0].length, Decoration.mark({ class: 'cm-fm-key' })); }
      }
      code.push([0, doc.line(fmEnd).to]);
    }

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from, to,
        enter: node => {
          const n = node.name;
          if (node.from < (fmEnd ? doc.line(fmEnd).to : 0)) return;
          const m = /^ATXHeading(\d)$/.exec(n) || /^SetextHeading(\d)$/.exec(n);
          if (m) { lineClass(node.from, `cm-h cm-h${m[1]}`); return; }
          switch (n) {
            case 'HeaderMark':
              if (!isActive(node.from) && doc.sliceString(node.to, node.to + 1) === ' ') add(node.from, node.to + 1, hide);
              else if (!isActive(node.from)) add(node.from, node.to, hide);
              break;
            case 'Emphasis': add(node.from, node.to, Decoration.mark({ class: 'cm-em' })); break;
            case 'StrongEmphasis': add(node.from, node.to, Decoration.mark({ class: 'cm-strong' })); break;
            case 'Strikethrough': add(node.from, node.to, Decoration.mark({ class: 'cm-strike' })); break;
            case 'EmphasisMark': case 'StrikethroughMark':
              if (!isActive(node.from)) add(node.from, node.to, hide); break;
            case 'InlineCode':
              add(node.from, node.to, Decoration.mark({ class: 'cm-inline-code' })); code.push([node.from, node.to]); break;
            case 'CodeMark':
              if (node.node.parent?.name === 'InlineCode' && !isActive(node.from)) add(node.from, node.to, hide); break;
            case 'FencedCode': case 'CodeBlock': {
              code.push([node.from, node.to]);
              const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
              for (let i = a; i <= b; i++) lineClass(doc.line(i).from, `cm-codeblock${i === a ? ' cm-code-first' : ''}${i === b ? ' cm-code-last' : ''}${n === 'FencedCode' && (i === a || i === b) ? ' cm-code-fence' : ''}`);
              return false;
            }
            case 'Blockquote': {
              const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
              for (let i = a; i <= b; i++) lineClass(doc.line(i).from, 'cm-quote');
              break;
            }
            case 'QuoteMark':
              if (!isActive(node.from)) add(node.from, Math.min(node.to + (doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0), doc.lineAt(node.from).to), hide); break;
            case 'ListMark': {
              const list = node.node.parent?.parent?.name;
              const task = node.node.parent?.getChild('Task');
              if (task) { if (!isActive(node.from)) add(node.from, node.to + 1, hide); }
              else if (list === 'BulletList' && !isActive(node.from)) add(node.from, node.to, Decoration.replace({ widget: new Bullet() }));
              else add(node.from, node.to, Decoration.mark({ class: 'cm-listmark' }));
              break;
            }
            case 'TaskMarker': {
              const checked = /x/i.test(doc.sliceString(node.from, node.to));
              if (checked) add(doc.lineAt(node.from).from, doc.lineAt(node.from).from, Decoration.line({ class: 'cm-task-done' }));
              if (!isActive(node.from)) add(node.from, node.to, Decoration.replace({ widget: new Checkbox(checked, node.from) }));
              break;
            }
            case 'HorizontalRule':
              if (!isActive(node.from)) add(node.from, node.to, Decoration.replace({ widget: new Rule() })); break;
            case 'Link': {
              const marks = node.node.getChildren('LinkMark'), url = node.node.getChild('URL');
              if (!url || isActive(node.from)) { add(node.from, node.to, Decoration.mark({ class: 'cm-link' })); break; }
              const href = doc.sliceString(url.from, url.to);
              const textEnd = marks[1] ? marks[1].from : node.to;
              add(node.from, node.from + 1, hide);
              add(node.from + 1, textEnd, Decoration.mark({ class: 'cm-link', attributes: { 'data-href': href } }));
              add(textEnd, node.to, hide);
              break;
            }
            case 'Image': {
              const url = node.node.getChild('URL');
              if (!url || isActive(node.from)) break;
              const src = doc.sliceString(url.from, url.to);
              const alt = doc.sliceString(node.from + 2, (node.node.getChildren('LinkMark')[1] || node).from);
              add(node.from, node.to, Decoration.replace({ widget: new Img(opts.fileUrl(src), alt) }));
              return false;
            }
            case 'URL':
              if (node.node.parent?.name === 'Autolink' || node.node.parent?.name === 'Document' || node.node.parent?.name === 'Paragraph') add(node.from, node.to, Decoration.mark({ class: 'cm-link', attributes: { 'data-href': doc.sliceString(node.from, node.to) } }));
              break;
          }
        },
      });

      // Obsidian syntax the Markdown grammar doesn't know: [[links]], ![[embeds]], #tags, ==highlights==
      const text = doc.sliceString(from, to);
      const inCode = p => code.some(([a, b]) => p >= a && p < b);
      for (const m of text.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/g)) {
        const s = from + m.index, e = s + m[0].length;
        if (inCode(s)) continue;
        const raw = m[2], pipe = raw.indexOf('|');
        const target = (pipe >= 0 ? raw.slice(0, pipe) : raw).trim(), label = pipe >= 0 ? raw.slice(pipe + 1) : null;
        const embed = m[1] === '!';
        if (embed && IMG_EXT.test(target.split('#')[0]) && !isActive(s)) {
          add(s, e, Decoration.replace({ widget: new Img(opts.fileUrl(target.split('|')[0]), target) }));
          continue;
        }
        const ok = opts.resolve(target.split('#')[0]);
        const cls = `cm-wikilink${ok ? '' : ' cm-unresolved'}${embed ? ' cm-embed' : ''}`;
        if (isActive(s)) { add(s, e, Decoration.mark({ class: cls, attributes: { 'data-target': target } })); continue; }
        const open = s + (embed ? 3 : 2), close = e - 2;
        add(s, open, hide);
        if (label != null) { add(open, open + pipe + 1, hide); add(open + pipe + 1, close, Decoration.mark({ class: cls, attributes: { 'data-target': target } })); }
        else add(open, close, Decoration.mark({ class: cls, attributes: { 'data-target': target } }));
        add(close, e, hide);
      }
      for (const m of text.matchAll(/(^|[\s(])(#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
        const s = from + m.index + m[1].length, e = s + m[2].length;
        if (inCode(s) || doc.lineAt(s).text.match(/^#{1,6}\s/) && doc.lineAt(s).from === s) continue;
        add(s, e, Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': m[2].slice(1) } }));
      }
      for (const m of text.matchAll(/==([^=\n]+)==/g)) {
        const s = from + m.index, e = s + m[0].length;
        if (inCode(s)) continue;
        if (!isActive(s)) { add(s, s + 2, hide); add(e - 2, e, hide); }
        add(s, e, Decoration.mark({ class: 'cm-highlight' }));
      }
    }

    // no two replaced ranges may overlap: keep the first of any that do, then let CodeMirror sort the rest
    deco.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const out = [];
    let replacedTo = -1;
    for (const [f, t, d, replaces] of deco) {
      if (replaces) { if (f < replacedTo) continue; replacedTo = t; }
      out.push(d.range(f, t));
    }
    return Decoration.set(out, true);
  }

  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some(t => t.effects.some(e => e.is(refresh)))) this.decorations = build(u.view); }
  }, {
    decorations: v => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        const t = e.target.closest?.('.cm-wikilink, .cm-link, .cm-tag');
        if (!t) return false;
        const pos = view.posAtDOM(t);
        const onActive = view.hasFocus && activeLines(view.state).has(view.state.doc.lineAt(pos).number);
        if (onActive && !(e.metaKey || e.ctrlKey)) return false;      // editing the line: place the cursor
        e.preventDefault();
        if (t.dataset.target) opts.openLink(t.dataset.target, { newPane: e.metaKey || e.ctrlKey });
        else if (t.dataset.href) opts.openUrl(t.dataset.href);
        else if (t.dataset.tag) opts.openTag?.(t.dataset.tag);
        return true;
      },
    },
  });
}
const refresh = StateEffect.define();

// ---- completion: [[ note names, # tags, and the slash menu at the start of a line ----
// [label, what it inserts, the shortcut shown at the right]; the order here is the order in the menu
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const SLASH = [
  ['Text', '', ''], ['Heading 1', '# ', '#'], ['Heading 2', '## ', '##'], ['Heading 3', '### ', '###'],
  ['To-do', '- [ ] ', '[ ]'], ['Bulleted list', '- ', '-'], ['Numbered list', '1. ', '1.'],
  ['Quote', '> ', '>'], ['Callout', '> [!note]\n> ', ''], ['Warning callout', '> [!warning]\n> ', ''], ['Tip callout', '> [!tip]\n> ', ''],
  ['Code block', '```\n\n```', '```'], ['Table', '| Column | Column |\n| --- | --- |\n|  |  |\n', ''], ['Divider', '---\n', '---'],
  ['Link to note', '[[', '[['], ['Embed a note', '![[', '![['], ['Image', '![[', ''], ['Highlight', '====', '=='],
  ['Today’s date', () => today(), ''], ['Tag', '#', '#'], ['Footnote', '[^1]\n\n[^1]: ', ''],
];
function completions(opts) {
  return autocompletion({
    icons: false, maxRenderedOptions: 60,
    override: [
      ctx => {
        const m = ctx.matchBefore(/!?\[\[[^\[\]\n|#]*/);
        if (!m) return null;
        const start = m.from + m.text.indexOf('[[') + 2;
        return {
          from: start, validFor: /^[^\[\]\n|#]*$/,
          options: opts.noteNames().map(n => ({ label: n.name, detail: n.dir || '', apply: (view, c, from, to) => {
            const after = view.state.sliceDoc(to, to + 2) === ']]' ? '' : ']]';
            view.dispatch({ changes: { from, to, insert: n.name + after }, selection: { anchor: from + n.name.length + 2 } });
          } })),
        };
      },
      ctx => {
        const m = ctx.matchBefore(/(^|\s)#[\p{L}\p{N}_\-/]*/u);
        if (!m || (m.text.trim() === '#' && !ctx.explicit && /^\s*#$/.test(ctx.state.doc.lineAt(ctx.pos).text.slice(0, ctx.pos - ctx.state.doc.lineAt(ctx.pos).from)))) return null;
        const start = m.from + m.text.indexOf('#') + 1;
        return { from: start, validFor: /^[\p{L}\p{N}_\-/]*$/u, options: opts.tags().map(t => ({ label: t, type: 'keyword' })) };
      },
      ctx => {
        const line = ctx.state.doc.lineAt(ctx.pos);
        const m = ctx.matchBefore(/^\s*\/[\w ]*$/);
        if (!m || m.from !== line.from && !/^\s*$/.test(ctx.state.sliceDoc(line.from, m.from))) return null;
        const slash = line.from + ctx.state.sliceDoc(line.from, ctx.pos).indexOf('/');
        return {
          from: slash, validFor: /^\/[\w ]*$/,
          options: SLASH.map(([label, ins, key], i) => ({
            label: '/' + label, displayLabel: label, detail: key, type: 'slash', boost: 99 - i,   // keep this order
            apply: (view, c, from, to) => {
              const insert = typeof ins === 'function' ? ins() : ins;
              const caret = insert.startsWith('```') ? from + 4 : insert === '====' ? from + 2 : insert.startsWith('[^1]') ? from + insert.length : from + insert.length;
              view.dispatch({ changes: { from, to, insert }, selection: { anchor: caret } });
              if (insert.endsWith('[[') || insert === '#') startCompletion(view);
            },
          })),
        };
      },
    ],
  });
}

export function createEditor(parent, opts) {
  const listeners = EditorView.updateListener.of(u => { if (u.docChanged) opts.onChange?.(u.state.doc.toString(), u); if (u.selectionSet || u.docChanged) opts.onSelection?.(u.state); });
  const paste = EditorView.domEventHandlers({
    paste(e, view) {
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (!files.length || !opts.uploadImage) return false;
      e.preventDefault();
      for (const f of files) opts.uploadImage(f).then(name => {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: `![[${name}]]` }, selection: { anchor: pos + name.length + 5 } });
      });
      return true;
    },
    drop(e, view) {
      const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
      if (!files.length || !opts.uploadImage) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      for (const f of files) opts.uploadImage(f).then(name => view.dispatch({ changes: { from: pos, insert: `![[${name}]]\n` } }));
      return true;
    },
  });
  const state = EditorState.create({
    doc: opts.doc || '',
    extensions: [
      history(), drawSelection(), dropCursor(), indentOnInput(), highlightSelectionMatches(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, addKeymap: true }),
      livePreview(opts), completions(opts),
      keymap.of([...markdownKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap,
        { key: 'Mod-b', run: v => wrap(v, '**') }, { key: 'Mod-i', run: v => wrap(v, '*') },
        { key: 'Mod-k', run: v => wrap(v, '[[', ']]') }, { key: 'Mod-Enter', run: toggleTask },
        { key: 'Mod-s', run: () => { opts.onSave?.(); return true; } }]),
      cmPlaceholder(opts.placeholder || 'Start writing…'),
      EditorView.theme({
        '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font)', fontSize: '13px', maxHeight: 'min(440px, 52vh)', minWidth: '260px' },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '6px 10px', lineHeight: '1.35' },
        '.cm-completionDetail': { fontFamily: 'var(--font)', fontStyle: 'normal', fontSize: '12px' },
      }),
      listeners, paste,
      EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    // Replace the text with what is on disk, changing only the part that differs, so the cursor and scroll stay put.
    setDoc(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      let a = 0; while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
      let b = 0; while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
      view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: [] });
    },
    refresh() { view.dispatch({ effects: refresh.of(null) }); },
    focus() { view.focus(); },
    insert(text) { const p = view.state.selection.main.head; view.dispatch({ changes: { from: p, insert: text }, selection: { anchor: p + text.length } }); view.focus(); },
    selection() { const r = view.state.selection.main; return view.state.sliceDoc(r.from, r.to); },
    scrollToLine(n) { const l = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines))); view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 80 }) }); },
    destroy() { view.destroy(); },
  };
}

function wrap(view, a, b = a) {
  const r = view.state.selection.main;
  const text = view.state.sliceDoc(r.from, r.to);
  view.dispatch({ changes: { from: r.from, to: r.to, insert: a + text + b }, selection: { anchor: r.from + a.length, head: r.from + a.length + text.length } });
  return true;
}
function toggleTask(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(\s*)([-*+] )?(\[[ xX]\] )?/.exec(line.text);
  let insert;
  if (m[3]) insert = m[1] + (m[2] || '- ') + (m[3][1] === ' ' ? '[x] ' : '[ ] ');
  else insert = m[1] + (m[2] || '- ') + '[ ] ';
  view.dispatch({ changes: { from: line.from, to: line.from + m[0].length, insert } });
  return true;
}
