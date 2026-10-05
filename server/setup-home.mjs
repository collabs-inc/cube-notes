// Creates the vault the first time the app is installed: ~/Notes (or NOTES_HOME), a git repository with a welcome
// note. An existing folder, an Obsidian vault included, is never changed, except for the managed block in its
// AGENTS.md (created only if the vault has none) that names where this app lives.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP, STATE, home } from './paths.mjs';

const HOME = home();
const BEGIN = '<!-- cube-notes:begin -->', END = '<!-- cube-notes:end -->';
const block = `${BEGIN}
## Notes (the Cube app)

This folder is an Obsidian-compatible vault. Agents read and write the Markdown files directly. Keep to Obsidian's
syntax: YAML front matter, \`[[wiki links]]\`, \`![[embeds]]\`, \`#tags\`, \`- [ ]\` tasks, daily notes named YYYY-MM-DD. Never
touch .obsidian/. The app's brief for agents is \`${APP}/librarian/LIBRARIAN.md\`.
${END}`;
const git = (...a) => execFileSync('git', ['-C', HOME, ...a], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
fs.mkdirSync(STATE, { recursive: true });

const created = !fs.existsSync(HOME);
if (created) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.cpSync(path.join(APP, 'starter'), HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, '.gitignore'), '.DS_Store\n.trash/\n.obsidian/workspace*.json\n');
  fs.writeFileSync(path.join(HOME, 'AGENTS.md'), `# Agents\n\n${block}\n`);
  fs.writeFileSync(path.join(HOME, 'CLAUDE.md'), '@AGENTS.md\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  let who = [];
  try { git('config', 'user.email'); } catch { who = ['-c', 'user.name=Notes', '-c', 'user.email=notes@cube.invalid']; }
  execFileSync('git', ['-C', HOME, ...who, 'commit', '-q', '-m', 'Start the vault'], { stdio: 'ignore' });
  console.log(`notes: created ${HOME}`);
} else console.log(`notes: ${HOME} already exists; left as it is`);
// a vault we created keeps its AGENTS.md block current; anyone else's vault is left exactly as it is
const f = path.join(HOME, 'AGENTS.md');
let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch {}
const i = text.indexOf(BEGIN), j = text.indexOf(END);
if (!created && i >= 0 && j > i) { const next = text.slice(0, i) + block + text.slice(j + END.length); if (next !== text) fs.writeFileSync(f, next); }
