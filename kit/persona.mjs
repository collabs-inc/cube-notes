// A persona: an app's own agent, in a column down the left of its page. One long-running conversation with the
// machine's Claude Code or Codex, run headless and resumed turn after turn, with every permission granted (as
// Cube's personas run). Messages you send, and events the app reports (a render ended, a loop ran), each become a
// turn; events that arrive while a turn runs are folded into one waiting turn.
//
// This file is the kit's server half, shared by every app built on it (Cube Studio, Radar). The page half is
// kit/persona.js. An app mounts the routes under a base path of its choosing:
//
//   GET  <base>/stream       server-sent events: a snapshot, then every change
//   POST <base>/send         { text, context }        a message (queued while a turn runs)
//   POST <base>/stop         ends the running turn and drops what was waiting
//   POST <base>/reset        starts a new conversation
//   POST <base>/agent        { agent: "claude" | "codex" }   switches agent (a new conversation)
//
// It keeps <dir>/transcript.jsonl (what the column shows) and <dir>/settings.json (the chosen agent and each
// agent's session id). work() runs a separate, one-off agent session for a background job (a loop) and keeps its
// transcript in <dir>/runs/<id>.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MAX_ITEMS = 400;           // what a snapshot carries; the file keeps everything
export const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const relPath = p => String(p || '').replace(/^.*\/(videos|loops|director|engine|tools|kit)\//, '$1/');

// One line for a tool call, the way a person would say it.
export function toolSummary(name, input = {}) {
  const f = input.file_path || input.path || input.notebook_path;
  switch (name) {
    case 'Bash': return short(input.description || input.command, 140);
    case 'Read': return `Read ${relPath(f)}`;
    case 'Write': return `Wrote ${relPath(f)}`;
    case 'Edit': case 'MultiEdit': return `Edited ${relPath(f)}`;
    case 'Glob': case 'Grep': return `Searched for ${short(input.pattern, 80)}`;
    case 'WebFetch': return `Read ${short(input.url, 100)}`;
    case 'WebSearch': return `Searched the web for ${short(input.query, 80)}`;
    case 'Task': case 'Agent': return `Started a helper: ${short(input.description || input.prompt, 100)}`;
    case 'TodoWrite': return 'Updated the plan';
    default: return String(name).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/[-_]/g, ' ');
  }
}

function codexSummary(it) {
  switch (it.type) {
    case 'command_execution': return short(String(it.command || '').replace(/^\/bin\/(ba)?sh -lc /, '').replace(/^(['"])(.*)\1$/, '$2'), 140);
    case 'file_change': return `Changed ${(it.changes || []).map(c => relPath(c.path)).join(', ') || 'files'}`;
    case 'mcp_tool_call': return `${it.server || 'tool'}: ${it.tool || ''}`;
    case 'web_search': return `Searched the web for ${short(it.query, 80)}`;
    case 'todo_list': return 'Updated the plan';
    default: return null;                                  // reasoning and the like stay out of the column
  }
}

// ---- the agents ----------------------------------------------------------------------------------------
// An adapter turns one turn into a command line, and the agent's JSON lines into the same few operations:
//   { session } · { text: [key, delta] } · { textEnd: key } · { tool: [key, name, summary] }
//   { toolEnd: [key, ok, detail] } · { error } · { done }
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    args: ({ prompt, session, brief, model }) => [
      '-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--append-system-prompt', brief, '--permission-mode', 'bypassPermissions',
      ...(model ? ['--model', model] : []), ...(session ? ['--resume', session] : [])],
    missingSession: msg => /No conversation found/i.test(msg),
    parse(e, ops) {
      if (e.parent_tool_use_id) return;                     // a helper's inner turn: its result reaches us as a tool
      if (e.type === 'system' && e.subtype === 'init' && e.session_id) ops.push({ session: e.session_id });
      else if (e.type === 'stream_event') {
        const ev = e.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') ops.push({ text: [`${ev.index}`, ev.delta.text] });
        else if (ev.type === 'content_block_stop') ops.push({ textEnd: `${ev.index}` });
        else if (ev.type === 'message_start') ops.push({ textEnd: '*' });
      } else if (e.type === 'assistant') {
        for (const b of e.message?.content || []) if (b.type === 'tool_use') ops.push({ tool: [b.id, b.name, toolSummary(b.name, b.input)] });
      } else if (e.type === 'user') {
        for (const b of e.message?.content || []) if (b.type === 'tool_result') {
          ops.push({ toolEnd: [b.tool_use_id, !b.is_error, b.is_error ? short(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 600) : ''] });
        }
      } else if (e.type === 'result') {
        if (e.is_error || e.subtype !== 'success') ops.push({ error: String(e.result || e.errors?.join('; ') || e.subtype || 'The turn failed') });
        ops.push({ done: true });
      }
    },
  },
  codex: {
    label: 'Codex',
    // developer_instructions is a TOML string; a JSON string literal is a valid TOML basic string
    args: ({ prompt, session, brief, model }) => [
      'exec', ...(session ? ['resume'] : []), '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '-c', `developer_instructions=${JSON.stringify(brief)}`, ...(model ? ['--model', model] : []),
      ...(session ? [session] : []), prompt],
    missingSession: msg => /no rollout found|thread\/resume failed/i.test(msg),
    parse(e, ops) {
      const it = e.item;
      if (e.type === 'thread.started' && e.thread_id) ops.push({ session: e.thread_id });
      else if (e.type === 'item.started' && it) {
        const s = codexSummary(it);
        if (s) ops.push({ tool: [it.id, it.type, s] });
      } else if (e.type === 'item.completed' && it) {
        if (it.type === 'agent_message') { ops.push({ text: [it.id, it.text || ''] }); ops.push({ textEnd: it.id }); }
        else if (it.type === 'error') ops.push({ error: it.message || 'Codex reported an error' });
        else {
          const s = codexSummary(it);
          if (s) {
            ops.push({ tool: [it.id, it.type, s] });          // completed without a start (a file change)
            const ok = !(it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0));
            ops.push({ toolEnd: [it.id, ok, ok ? '' : short(it.aggregated_output || it.error || '', 600)] });
          }
        }
      } else if (e.type === 'turn.failed') { ops.push({ error: e.error?.message || 'The turn failed' }); ops.push({ done: true }); }
      else if (e.type === 'error') ops.push({ error: e.message || 'Codex reported an error' });
      else if (e.type === 'turn.completed') ops.push({ done: true });
    },
  },
};
export const agentLabels = Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, a.label]));

// Which agents this machine has, found once on the login shell's PATH (where Cube puts them).
const found = {};
export function which(name) {
  if (name in found) return found[name];
  const bin = process.env[`PERSONA_${name.toUpperCase()}`] || name;
  const r = spawnSync('sh', ['-lc', 'command -v "$0"', bin], { encoding: 'utf8' });
  return (found[name] = r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n').pop() : null);
}
export const installedAgents = () => Object.keys(AGENTS).filter(which);

// One turn of one agent: spawns it, turns its output into ops, and calls onExit({ code, stderr, done, failed }).
export function runAgent({ agent, prompt, session, brief, cwd, env, model, onOp, onExit }) {
  const A = AGENTS[agent], bin = which(agent);
  if (!bin) { setImmediate(() => onExit({ code: 127, stderr: `${A.label} is not installed on this machine.`, missing: true })); return { stop() {} }; }
  const child = spawn(bin, A.args({ prompt, session, brief, model }), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', stderr = '', done = false, failed = false;
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const ops = []; A.parse(e, ops);
      for (const op of ops) { if (op.done) done = true; if (op.error) failed = true; onOp(op); }
    }
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.on('error', err => { stderr += String(err); });
  child.on('close', code => onExit({ code, stderr, done, failed }));
  return { child, stop() { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } };
}

/**
 * name         shown in errors and dividers ("Director", "Scout")
 * dir          where the conversation is kept
 * cwd          where the agent works (the app's project)
 * brief()      the system prompt to append, read fresh each turn
 * env()        extra environment for the agent
 * describe(c)  one bracketed line describing what the user is looking at, from a message's context, or ''
 * eventPrompt(details[])  the prompt for one or more events that ended while the persona was busy
 */
export function createPersona({ name, dir, cwd, brief, env = () => ({}), describe = () => '', eventPrompt, models = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const TRANSCRIPT = path.join(dir, 'transcript.jsonl'), SETTINGS = path.join(dir, 'settings.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const settings = () => readJson(SETTINGS, {});
  const saveSettings = patch => { const next = { ...settings(), ...patch }; fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2)); return next; };
  const sessionOf = a => settings().sessions?.[a] || null;
  const setSession = (a, id) => saveSettings({ sessions: { ...settings().sessions, [a]: id } });

  // the transcript, collapsed by id (a streamed reply is written once, when it is complete)
  const items = new Map();
  try {
    for (const line of fs.readFileSync(TRANSCRIPT, 'utf8').split('\n')) {
      if (!line) continue;
      try { const it = JSON.parse(line); items.set(it.id, it); } catch {}
    }
  } catch {}
  // a turn the app was stopped in the middle of is over
  for (const it of items.values()) { if (it.pending) { it.pending = false; if (it.role === 'tool') it.status = 'interrupted'; } if (it.queued) it.queued = false; }
  let seq = Math.max(0, ...[...items.keys()].map(k => Number(String(k).split('-')[0]) || 0));
  const newId = () => `${++seq}-${Date.now().toString(36)}`;

  const clients = new Set();
  let turn = null, busy = false, stopping = false;
  const waiting = [];            // turns asked for while one runs: [{ id, prompt, event?, details? }]

  const broadcast = ev => { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(data); };
  function put(it, { persist = true } = {}) {
    items.set(it.id, it);
    if (persist) fs.appendFileSync(TRANSCRIPT, JSON.stringify(it) + '\n');
    broadcast({ type: 'item', item: it });
    return it;
  }

  // the chosen agent; else PERSONA_AGENT; else whichever is installed, Claude Code first
  function current() {
    const want = settings().agent || process.env.PERSONA_AGENT;
    if (want && AGENTS[want]) return want;
    return installedAgents()[0] || 'claude';
  }
  const status = () => ({ name, busy, queued: waiting.length, agent: current(), installed: installedAgents(), labels: agentLabels });
  const pushStatus = () => broadcast({ type: 'status', ...status() });
  const agentEnv = () => ({ ...process.env, ...env() });

  // quiet: a background turn (tagging, upkeep) whose replies stay in the history but don't pop up (persona-float)
  function run(prompt, { fresh = false, quiet = false } = {}) {
    const agent = current(), A = AGENTS[agent];
    busy = true; stopping = false; pushStatus();
    const session = fresh ? null : sessionOf(agent);
    fs.mkdirSync(cwd, { recursive: true });
    const texts = new Map(), tools = new Map();
    let resumeFailed = false;
    const endText = key => {
      for (const [k, it] of texts) if (key === '*' || k === key) {
        texts.delete(k); it.pending = false;
        if (it.text.trim()) put(it); else { items.delete(it.id); broadcast({ type: 'remove', id: it.id }); }
      }
    };
    turn = runAgent({
      agent, prompt, session, brief: brief(), cwd, env: agentEnv(), model: models[agent],
      onOp(op) {
        if (op.session) setSession(agent, op.session);
        else if (op.text) {
          const [key, delta] = op.text;
          let it = texts.get(key);
          if (!it) { it = { id: newId(), at: Date.now(), role: 'assistant', text: '', pending: true, ...(quiet ? { quiet: true } : {}) }; texts.set(key, it); put(it, { persist: false }); }
          it.text += delta; broadcast({ type: 'delta', id: it.id, text: delta });
        } else if (op.textEnd) endText(op.textEnd);
        else if (op.tool) {
          const [key, tool, summary] = op.tool;
          if (tools.has(key)) return;
          const it = { id: newId(), at: Date.now(), role: 'tool', name: tool, text: summary, status: 'running', pending: true };
          tools.set(key, it); put(it, { persist: false });
        } else if (op.toolEnd) {
          const [key, ok, detail] = op.toolEnd, it = tools.get(key);
          if (!it) return;
          tools.delete(key); it.status = ok ? 'done' : 'failed'; it.pending = false;
          if (detail) it.detail = detail;
          put(it);
        } else if (op.error) {
          if (session && A.missingSession(op.error)) resumeFailed = true;
          else put({ id: newId(), at: Date.now(), role: 'error', text: short(op.error, 1200) });
        }
      },
      onExit({ code, stderr, done, failed, missing }) {
        turn = null;
        endText('*');
        for (const it of tools.values()) { it.pending = false; it.status = stopping ? 'stopped' : 'interrupted'; put(it); }
        if (missing) {
          put({ id: newId(), at: Date.now(), role: 'error', text: `${name} needs ${A.label} on this machine. Install it from Cube's Agents surface and sign in, then send your message again.` });
        } else if (resumeFailed || (session && !done && A.missingSession(stderr))) {
          // the saved session is gone (another machine, a wiped cache): start over, once
          setSession(agent, null);
          put({ id: newId(), at: Date.now(), role: 'system', text: 'The previous conversation could not be resumed; starting a new one.' });
          return run(prompt, { fresh: true, quiet });
        } else if (stopping) put({ id: newId(), at: Date.now(), role: 'system', text: 'Stopped.' });
        else if (code !== 0 && !failed) put({ id: newId(), at: Date.now(), role: 'error', text: short(stderr || `${A.label} exited with code ${code}.`, 1200) });
        busy = false;
        next();
      },
    });
  }

  function next() {
    const m = waiting.shift();
    if (!m) { pushStatus(); return; }
    const it = items.get(m.id);
    if (it?.queued) { it.queued = false; put(it); }
    run(m.prompt, { quiet: Boolean(m.quiet) });
  }

  // a message in the column (yours, or one the app writes for you, such as a pinned note)
  function inject(text, prompt, extra = {}) {
    const it = put({ id: newId(), at: Date.now(), role: 'user', text, ...extra, queued: busy });
    if (busy) { waiting.push({ id: it.id, prompt }); pushStatus(); }
    else run(prompt);
    return it;
  }

  // ---- background work: one-off sessions the persona supervises (a loop run) ----
  const RUNS = path.join(dir, 'runs');
  function work({ id, prompt, brief: workBrief, cwd: workCwd = cwd, env: workEnv = {}, onUpdate = () => {} }) {
    fs.mkdirSync(RUNS, { recursive: true });
    const log = path.join(RUNS, `${id}.jsonl`);
    const write = it => fs.appendFileSync(log, JSON.stringify(it) + '\n');
    const agent = current();
    let last = '', text = '', handle = null;
    const tools = new Map();
    const promise = new Promise(resolve => {
      handle = runAgent({
        agent, prompt, brief: workBrief ?? brief(), cwd: workCwd, env: { ...agentEnv(), ...workEnv }, model: models[agent],
        onOp(op) {
          if (op.text) text += op.text[1];
          else if (op.textEnd) { if (text.trim()) { last = text.trim(); write({ at: Date.now(), role: 'assistant', text: last }); onUpdate({ text: last }); } text = ''; }
          else if (op.tool) { tools.set(op.tool[0], op.tool[2]); write({ at: Date.now(), role: 'tool', text: op.tool[2] }); onUpdate({ step: op.tool[2] }); }
          else if (op.toolEnd && !op.toolEnd[1]) write({ at: Date.now(), role: 'tool', status: 'failed', text: tools.get(op.toolEnd[0]) || '', detail: op.toolEnd[2] });
          else if (op.error) write({ at: Date.now(), role: 'error', text: op.error });
        },
        onExit({ code, stderr, done, failed, missing }) {
          if (text.trim()) { last = text.trim(); write({ at: Date.now(), role: 'assistant', text: last }); }
          const ok = !missing && code === 0 && !failed;
          if (!ok && stderr) write({ at: Date.now(), role: 'error', text: short(stderr, 2000) });
          resolve({ ok, agent, summary: last, error: ok ? null : short(missing ? stderr : (stderr || `exited with code ${code}`), 600), stopped: handle?.stopped });
        },
      });
    });
    return { promise, stop() { if (handle) { handle.stopped = true; handle.stop(); } }, log };
  }
  const readRun = id => {
    try { return fs.readFileSync(path.join(RUNS, `${path.basename(id)}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  };

  const persona = {
    status, inject, work, readRun,
    send(text, context) {
      text = String(text || '').trim().slice(0, 8000);
      if (!text) throw new Error('empty message');
      const ctx = describe(context || {});
      return inject(text, ctx ? `${ctx}\n\n${text}` : text, context?.label ? { context: { label: context.label, ref: context.ref ?? null } } : {});
    },
    // Something happened in the app that the persona supervises. Events that arrive while a turn runs are folded
    // into one waiting turn, so ten jobs ending overnight cost one turn, not ten.
    event(text, detail, extra = {}) {
      const pending = waiting.find(m => m.event);
      if (pending) {
        const it = items.get(pending.id);
        it.lines = [...(it.lines || [it.text]), text]; it.text = `${it.lines.length} updates`;
        pending.details.push(detail); pending.prompt = eventPrompt(pending.details);
        put(it); return it;
      }
      const it = put({ id: newId(), at: Date.now(), role: 'event', text, ...extra, queued: busy });
      const m = { id: it.id, event: true, quiet: Boolean(extra.quiet), details: [detail], prompt: eventPrompt([detail]) };
      if (busy) { waiting.push(m); pushStatus(); } else run(m.prompt, { quiet: m.quiet });
      return it;
    },
    setAgent(agent) {
      if (!AGENTS[agent]) throw new Error('unknown agent');
      if (agent === current()) return status();
      if (turn) persona.stop();
      saveSettings({ agent });
      put({ id: newId(), at: Date.now(), role: 'system', text: `Now with ${AGENTS[agent].label}. New conversation.`, divider: true });
      setSession(agent, null);
      pushStatus();
      return status();
    },
    stop() {
      if (!turn) return false;
      stopping = true;
      turn.stop();
      // drop what was waiting too: Stop means stop
      for (const m of waiting.splice(0)) { const it = items.get(m.id); if (it) { it.queued = false; it.dropped = true; put(it); } }
      return true;
    },
    reset() {
      if (turn) persona.stop();
      setSession(current(), null);
      put({ id: newId(), at: Date.now(), role: 'system', text: 'New conversation.', divider: true });
      pushStatus();
    },
    stream(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', items: [...items.values()].slice(-MAX_ITEMS), ...status() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    },
    // the routes, for an app's router: returns true when it answered
    route(req, res, p, base, { body, send }) {
      if (!p.startsWith(base + '/')) return false;
      const r = p.slice(base.length);
      if (r === '/stream') { persona.stream(req, res); return true; }
      if (req.method !== 'POST') return false;
      if (r === '/send') { body(req, res, b => send(res, 200, persona.send(b.text, b.context))); return true; }
      if (r === '/stop') { send(res, 200, { stopped: persona.stop() }); return true; }
      if (r === '/reset') { persona.reset(); send(res, 200, { ok: true }); return true; }
      if (r === '/agent') { body(req, res, b => send(res, 200, persona.setAgent(String(b.agent || '')))); return true; }
      return false;
    },
    shutdown() { if (turn) turn.stop(); },
  };
  return persona;
}
