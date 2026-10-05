// The persona column, the page half of kit/persona.mjs. One conversation, streamed from <base>/stream.
//
//   import { mountPersona } from '/kit/persona.js';
//   const persona = mountPersona(document.getElementById('persona'), {
//     base: '/api/director', name: 'Director', role: 'Your motion studio',
//     avatar: { svg: '<svg …>', color: 'linear-gradient(…)' },
//     hello: { text: 'What I do…', suggestions: () => ['…'] },
//     context: () => ({ label: 'Cube 24/7 · 9:16 · 2.40 s', ref: {…}, …fields the server's describe() reads }),
//     refFor: text => ref | null,      // `code` in a reply that names something the app can open
//     open: ref => {},                 // a message's chip or a ref was clicked
//   });
//   persona.say('…');  persona.refreshContext();
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
const ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/><path d="M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3"/></svg>';

// A small, safe Markdown: escape first, then paragraphs, lists, headings, code, bold, italics and links.
export function md(src, refFor = () => null) {
  const blocks = [];
  src = String(src).replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => { const r = refFor(c.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); return r ? `<button class="ref" data-ref="${esc(JSON.stringify(r))}"><code>${c}</code></button>` : `<code>${c}</code>`; })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  for (const para of src.split(/\n{2,}/)) {
    const m = /^\u0000(\d+)\u0000$/.exec(para.trim());
    if (m) { out.push(blocks[+m[1]]); continue; }
    const lines = para.split('\n');
    if (lines.every(l => /^\s*([-*•]|\d+[.)])\s+/.test(l) || !l.trim())) {
      const ordered = /^\s*\d/.test(lines[0]);
      out.push(`<${ordered ? 'ol' : 'ul'}>${lines.filter(l => l.trim()).map(l => `<li>${inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^#{1,4}\s/.test(para)) out.push(`<h4>${inline(para.replace(/^#+\s*/, ''))}</h4>`);
    else out.push(`<p>${lines.map(inline).join('<br>').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i])}</p>`);
  }
  return out.join('');
}

export function mountPersona(root, opts) {
  const { base, name, role = '', avatar, hello = {}, placeholder = `Message ${name}…`, context = () => null, refFor = () => null, open = () => {} } = opts;
  const S = { items: [], byId: new Map(), busy: false, queued: 0, agent: 'claude', installed: ['claude'], labels: { claude: 'Claude Code', codex: 'Codex' }, attach: true, shown: false, online: true };
  const av = (cls = '') => `<div class="persona-avatar ${cls}" style="background:${avatar.color}">${avatar.svg}</div>`;
  root.classList.add('persona');
  root.innerHTML = `
    <div class="persona-head">${av()}
      <div class="persona-who"><b>${esc(name)}</b><span><i></i><em class="state" style="font-style:normal">Ready</em></span></div>
      <select class="select persona-agent" title="The agent ${esc(name)} runs on"></select>
      <button class="icon-btn reset" title="New conversation">${ICON_NEW}</button>
    </div>
    <div class="persona-msgs"></div>
    <div class="persona-compose">
      <div class="persona-ctx"></div>
      <div class="persona-box"><textarea rows="1" placeholder="${esc(placeholder)}"></textarea><button class="persona-send" title="Send">${ICON_SEND}</button></div>
    </div>
    <div class="persona-grip" title="Drag to resize"></div>`;
  const $ = s => root.querySelector(s);
  const msgs = $('.persona-msgs'), text = $('textarea'), sendBtn = $('.persona-send'), agentSel = $('.persona-agent');
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;

  function userHtml(it) {
    const c = it.context;
    const chip = c?.label ? `<div class="msg-ctx"><button class="${c.pin ? 'pin' : ''}" data-ref="${esc(JSON.stringify(c.ref ?? null))}">${esc(c.label)}</button></div>` : '';
    return `${chip}<div class="msg user${it.queued ? ' queued' : ''}${it.dropped ? ' dropped' : ''}">${esc(it.text)}</div>`;
  }
  function itemHtml(it) {
    if (it.role === 'user') return userHtml(it);
    if (it.role === 'assistant') return `<div class="msg assistant${it.pending ? ' pending' : ''}" data-id="${esc(it.id)}">${md(it.text, refFor)}</div>`;
    if (it.role === 'event') {
      const lines = it.lines || [it.text];
      return `<div class="msg event${it.queued ? ' queued' : ''}">${ICON_BELL}<div>${esc(lines[0])}${lines.slice(1).map(l => `<div class="more">${esc(l)}</div>`).join('')}</div></div>`;
    }
    if (it.role === 'error') return `<div class="msg error">${esc(it.text)}</div>`;
    return `<div class="msg system${it.divider ? ' divider' : ''}">${esc(it.text)}</div>`;
  }
  function stepsHtml(run, isOpen) {
    const cur = run[run.length - 1], live = run.some(x => x.status === 'running');
    const failed = run.filter(x => x.status === 'failed').length;
    const label = live ? esc(cur.text) : `${run.length} step${run.length > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`;
    return `<details class="steps"${isOpen ? ' open' : ''} data-first="${esc(run[0].id)}"><summary>${live ? '<span class="spinner"></span>' : ICON_CHEV}<span class="cur">${label}</span></summary><div class="list">` +
      run.map(x => `<div class="step ${esc(x.status)}" title="${esc(x.detail || x.text)}"><span>${esc(x.text)}</span></div>`).join('') + '</div></details>';
  }
  function helloHtml() {
    const sug = (hello.suggestions ? hello.suggestions() : []).map(x => `<button data-say="${esc(x)}">${esc(x)}</button>`).join('');
    return `<div class="persona-hello">${av()}<b>${esc(name)}</b><p>${esc(hello.text || role)}</p>${sug}</div>`;
  }
  function render() {
    const stick = nearBottom() || !S.shown;
    const openSteps = new Set([...msgs.querySelectorAll('details.steps[open]')].map(d => d.dataset.first));
    let html = '', run = [];
    const flush = () => { if (run.length) { html += stepsHtml(run, openSteps.has(run[0].id)); run = []; } };
    for (const it of S.items) { if (it.role === 'tool') { run.push(it); continue; } flush(); html += itemHtml(it); }
    flush();
    msgs.innerHTML = html || helloHtml();
    if (stick) msgs.scrollTop = msgs.scrollHeight;
    S.shown = true;
  }
  function upsert(it) {
    if (S.byId.has(it.id)) S.items[S.items.findIndex(x => x.id === it.id)] = it; else S.items.push(it);
    S.byId.set(it.id, it);
  }
  function ui() {
    const off = !S.installed.includes(S.agent);
    const opts = Object.keys(S.labels).map(k => `<option value="${k}"${k === S.agent ? ' selected' : ''}${S.installed.includes(k) ? '' : ' disabled'}>${esc(S.labels[k])}${S.installed.includes(k) ? '' : ' · not installed'}</option>`).join('');
    if (agentSel.dataset.sig !== opts) { agentSel.innerHTML = opts; agentSel.dataset.sig = opts; }
    root.classList.toggle('busy', S.busy);
    root.classList.toggle('off', off);
    $('.state').textContent = !S.online ? 'Reconnecting…' : off ? `Needs ${S.labels[S.agent] || S.agent}` : S.busy ? (S.queued ? `Working · ${S.queued} waiting` : 'Working…') : (role || 'Ready');
    const stop = S.busy && !text.value.trim();
    sendBtn.classList.toggle('stop', stop);
    sendBtn.innerHTML = stop ? ICON_STOP : ICON_SEND;
    sendBtn.title = stop ? 'Stop' : S.busy ? 'Send after this turn' : 'Send';
    sendBtn.disabled = !stop && !text.value.trim();
  }
  function refreshContext() {
    const c = context();
    $('.persona-ctx').innerHTML = c?.label
      ? `<span class="chip${S.attach ? '' : ' off'}" title="${S.attach ? `Sent with your message, so ${esc(name)} knows what you mean` : 'Not sent'}"><span>${esc(c.label)}</span><button class="ctx-x" aria-label="${S.attach ? 'Don’t send' : 'Send'}">${S.attach ? '×' : '+'}</button></span>`
      : '';
  }
  function connect() {
    const es = new EventSource(`${base}/stream`);
    es.onopen = () => { S.online = true; ui(); };
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      const st = x => Object.assign(S, { busy: x.busy, queued: x.queued, agent: x.agent, installed: x.installed, labels: x.labels });
      if (ev.type === 'snapshot') { S.items = []; S.byId.clear(); ev.items.forEach(upsert); st(ev); render(); }
      else if (ev.type === 'item') { upsert(ev.item); render(); }
      else if (ev.type === 'remove') { S.items = S.items.filter(x => x.id !== ev.id); S.byId.delete(ev.id); render(); }
      else if (ev.type === 'delta') {
        const it = S.byId.get(ev.id); if (!it) return;
        it.text += ev.text;
        const el = msgs.querySelector(`.msg[data-id="${CSS.escape(ev.id)}"]`);
        if (el) { const stick = nearBottom(); el.innerHTML = md(it.text, refFor); if (stick) msgs.scrollTop = msgs.scrollHeight; } else render();
      } else if (ev.type === 'status') st(ev);
      ui();
    };
    es.onerror = () => { S.online = false; ui(); };
  }
  const post = (p, b = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  async function say(t) {
    t = String(t || '').trim();
    if (!t) return;
    const c = S.attach ? context() : null;
    text.value = ''; grow(); ui();
    const r = await post('/send', { text: t, context: c });
    if (!r.ok) { text.value = t; grow(); ui(); }
  }
  const grow = () => { text.style.height = 'auto'; text.style.height = Math.min(180, text.scrollHeight) + 'px'; };
  text.addEventListener('input', () => { grow(); ui(); });
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); say(text.value); }
    if (e.key === 'Escape') text.blur();
  });
  sendBtn.onclick = () => { if (sendBtn.classList.contains('stop')) post('/stop'); else say(text.value); };
  $('.reset').onclick = () => { if (confirm(`Start a new conversation with ${name}? This one stays above.`)) post('/reset'); };
  agentSel.onchange = () => {
    const a = agentSel.value;
    if (a === S.agent) return;
    if (!confirm(`Switch ${name} to ${S.labels[a] || a}? It starts a new conversation; this one stays above.`)) { agentSel.value = S.agent; return; }
    post('/agent', { agent: a });
  };
  $('.persona-ctx').addEventListener('click', e => { if (e.target.closest('.ctx-x')) { S.attach = !S.attach; refreshContext(); } });
  msgs.addEventListener('click', e => {
    const s = e.target.closest('[data-say]'); if (s) { say(s.dataset.say); return; }
    const r = e.target.closest('[data-ref]'); if (!r) return;
    let ref = null; try { ref = JSON.parse(r.dataset.ref); } catch {}
    if (ref) open(ref);
  });
  // the column's width is yours to set, and remembered
  const shell = root.closest('.shell') || document.documentElement, key = `persona-w:${base}`;
  try { const w = Number(localStorage.getItem(key)); if (w) shell.style.setProperty('--persona-w', w + 'px'); } catch {}
  const grip = $('.persona-grip');
  grip.addEventListener('pointerdown', e => {
    grip.setPointerCapture(e.pointerId); grip.classList.add('on');
    const x0 = root.getBoundingClientRect().left;
    const move = ev => { const w = Math.round(Math.max(300, Math.min(innerWidth * 0.5, ev.clientX - x0))); shell.style.setProperty('--persona-w', w + 'px'); opts.onResize?.(); };
    const up = () => { grip.classList.remove('on'); grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
      try { localStorage.setItem(key, parseInt(getComputedStyle(shell).getPropertyValue('--persona-w'))); } catch {} };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  connect(); ui(); refreshContext();
  // put words in the composer for the user to finish, and focus it
  const prefill = t => { text.value = t; grow(); ui(); text.focus(); text.setSelectionRange(t.length, t.length); };
  return { say, prefill, refreshContext, rerender: render, focus: () => text.focus(), get busy() { return S.busy; } };
}

// The theme Cube asks for (?theme=light|dark), else the system's.
export function applyTheme() {
  const t = new URLSearchParams(location.search).get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}
