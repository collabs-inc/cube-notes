// A persona that floats instead of taking a column: an avatar in a corner of the page, the conversation under it as
// bubbles over the page that fade, like a cursor chat, and the input below the bubbles, where the next line goes. The whole conversation stays a click away in
// a drawer (the column from persona.js, mounted on demand). Same server half (kit/persona.mjs), same routes.
//
//   import { mountFloatingPersona } from '/kit/persona-float.js';
//   mountFloatingPersona(document.querySelector('.page-pane'), {
//     base: '/api/librarian', name: 'Librarian', avatar: { svg, color },
//     context: () => ({ label, ref, …fields }), placeholder: c => `Ask about ${c.label}…`,
//     refFor, open, hello: { suggestions },            // as for mountPersona
//   });
import { md, mountPersona } from '/kit/persona.js';

const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

// how long a bubble stays before it fades: your words briefly, replies long enough to read
const LIFE = { user: 5000, error: 12000, assistant: t => Math.min(45000, 9000 + t.length * 45) };

export function mountFloatingPersona(host, opts) {
  const { base, name, avatar, context = () => null, refFor = () => null, open = () => {} } = opts;
  const root = document.createElement('div');
  root.className = 'pf';
  root.innerHTML = `
    <div class="pf-corner">
      <button class="pf-avatar" title="${esc(name)} (⌘J)" style="background:${avatar.color}">${avatar.svg}<span class="pf-ring"></span></button>
    </div>
    <div class="pf-stack"></div>
    <div class="pf-status" hidden></div>
    <div class="pf-compose" hidden>
      <button class="pf-icon pf-history" title="The whole conversation">${ICON_LIST}</button>
      <textarea rows="1" spellcheck="true"></textarea>
      <button class="pf-send" title="Send">${ICON_SEND}</button>
    </div>
    <aside class="pf-drawer" hidden><div class="pf-drawer-head"><b>${esc(name)}</b><button class="pf-icon pf-close" title="Close">${ICON_X}</button></div><div class="pf-drawer-body"></div></aside>`;
  host.appendChild(root);
  const $ = s => root.querySelector(s);
  const compose = $('.pf-compose'), text = $('textarea'), sendBtn = $('.pf-send'), stack = $('.pf-stack'), status = $('.pf-status');
  const S = { busy: false, online: true, seen: new Set(), streams: new Map(), step: '' };

  // ---- bubbles ----
  const bubbles = new Map();          // item id → element
  let paused = false;
  function bubble(it) {
    let el = bubbles.get(it.id);
    if (!el) {
      el = document.createElement('div');
      el.className = `pf-b pf-${it.role}`;
      el.addEventListener('click', e => { const r = e.target.closest('[data-ref]'); if (r) { try { open(JSON.parse(r.dataset.ref)); } catch {} } });
      stack.appendChild(el);
      bubbles.set(it.id, el);
      requestAnimationFrame(() => el.classList.add('in'));
      // at most four at a time: the oldest goes first
      const all = [...stack.children].filter(x => !x.classList.contains('out'));
      if (all.length > 4) fade(all[0], 0);
    }
    el.innerHTML = it.role === 'assistant' ? md(it.text, refFor) : esc(it.text);
    el.classList.toggle('pending', Boolean(it.pending));
    clearTimeout(el._t);
    if (!it.pending) {
      const life = typeof LIFE[it.role] === 'function' ? LIFE[it.role](it.text) : LIFE[it.role] || 6000;
      el._life = life;
      // your question waits for its answer, so the two read together
      if (it.role === 'user') el._hold = true; else schedule(el);
    }
    return el;
  }
  function schedule(el) { clearTimeout(el._t); if (!paused && !el._hold) el._t = setTimeout(() => fade(el), el._life); }
  function release() { for (const el of stack.children) if (el._hold) { el._hold = false; el._life = 6000; schedule(el); } }
  function fade(el, delay = 0) {
    clearTimeout(el._t);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.remove(); for (const [k, v] of bubbles) if (v === el) bubbles.delete(k); }, 900); }, delay);
  }
  // hovering the stack holds every bubble where it is
  stack.addEventListener('mouseenter', () => { paused = true; for (const el of stack.children) clearTimeout(el._t); });
  stack.addEventListener('mouseleave', () => { paused = false; for (const el of stack.children) if (el._life) schedule(el); });

  function setStatus() {
    root.classList.toggle('busy', S.busy);
    status.hidden = !S.busy;
    status.innerHTML = `<span class="spinner"></span><span>${esc(S.step || 'Thinking…')}</span>`;
    const stop = S.busy && !text.value.trim();
    sendBtn.innerHTML = stop ? ICON_STOP : ICON_SEND;
    sendBtn.classList.toggle('stop', stop);
    sendBtn.disabled = !stop && !text.value.trim();
  }

  // ---- the stream: only what happens from now on becomes a bubble; history lives in the drawer ----
  function connect() {
    const es = new EventSource(`${base}/stream`);
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'snapshot') { for (const it of ev.items) S.seen.add(it.id); S.busy = ev.busy; }
      else if (ev.type === 'item') {
        const it = ev.item;
        if (it.role === 'tool') { if (it.status === 'running') S.step = it.text; }
        else if (it.role === 'user' || it.role === 'error' || (it.role === 'assistant' && it.text.trim())) {
          if (!S.seen.has(it.id) || bubbles.has(it.id)) bubble(it);
          S.seen.add(it.id);
          if (it.role === 'assistant') { S.streams.set(it.id, it); S.step = ''; }
        }
      } else if (ev.type === 'delta') {
        const it = S.streams.get(ev.id) || { id: ev.id, role: 'assistant', text: '', pending: true };
        it.text += ev.text; it.pending = true; S.streams.set(ev.id, it);
        if (it.text.trim()) bubble(it);
      } else if (ev.type === 'remove') { const el = bubbles.get(ev.id); if (el) fade(el); }
      else if (ev.type === 'status') { S.busy = ev.busy; if (!S.busy) { S.step = ''; release(); } }
      setStatus();
    };
    es.onerror = () => { S.online = false; };
  }

  // ---- composing ----
  const post = (p, b = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  function openCompose() {
    const c = context();
    text.placeholder = typeof opts.placeholder === 'function' ? opts.placeholder(c) : (c?.label ? `Ask ${name} about “${c.label}”…` : `Ask ${name}…`);
    compose.hidden = false; root.classList.add('composing');
    text.focus(); setStatus();
  }
  function closeCompose() { compose.hidden = true; root.classList.remove('composing'); text.blur(); }
  async function say(t) {
    t = String(t || '').trim(); if (!t) return;
    text.value = ''; grow(); setStatus();
    const r = await post('/send', { text: t, context: context() });
    if (!r.ok) { text.value = t; grow(); }
  }
  const grow = () => { text.style.height = 'auto'; text.style.height = Math.min(140, text.scrollHeight) + 'px'; };
  text.addEventListener('input', () => { grow(); setStatus(); });
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); say(text.value); }
    if (e.key === 'Escape') { e.preventDefault(); closeCompose(); opts.onClose?.(); }
  });
  sendBtn.onclick = () => (sendBtn.classList.contains('stop') ? post('/stop') : say(text.value));
  $('.pf-avatar').onclick = () => (compose.hidden ? openCompose() : (closeCompose(), opts.onClose?.()));
  // a click anywhere else closes it; what you had typed stays for next time
  document.addEventListener('mousedown', e => {
    if (compose.hidden || root.contains(e.target)) return;
    closeCompose(); opts.onClose?.({ byClick: true });
  });
  addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); compose.hidden ? openCompose() : (closeCompose(), opts.onClose?.()); } });

  // ---- the whole conversation, in a drawer ----
  let column = null;
  $('.pf-history').onclick = () => {
    const d = $('.pf-drawer');
    d.hidden = !d.hidden;
    if (!d.hidden && !column) column = mountPersona($('.pf-drawer-body'), { ...opts, role: opts.role || '' });
    if (!d.hidden) column.refreshContext();
  };
  $('.pf-close').onclick = () => { $('.pf-drawer').hidden = true; };

  connect(); setStatus();
  return { open: openCompose, close: closeCompose, say, refreshContext: () => column?.refreshContext(), prefill: t => { openCompose(); text.value = t; grow(); setStatus(); text.setSelectionRange(t.length, t.length); } };
}
