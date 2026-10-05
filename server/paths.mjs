// Where things live. Notes is an app: its own folder (APP) is replaced by every update, so nothing the user writes
// is kept there.
//
//   APP      this repository: server/, web/, kit/, librarian/, starter/
//   HOME     the vault: ~/Notes by default (NOTES_HOME, or "home" in STATE/settings.json), a folder of Markdown
//            that Obsidian opens as it is, and a git repository
//   STATE    the app's bookkeeping (the Librarian's conversation, recent notes): ~/.local/state/cube-notes
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const STATE = path.resolve(process.env.NOTES_STATE
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cube-notes'));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
export const settings = () => readJson(path.join(STATE, 'settings.json'), {});
export function saveSettings(patch) {
  fs.mkdirSync(STATE, { recursive: true });
  const next = { ...settings(), ...patch };
  fs.writeFileSync(path.join(STATE, 'settings.json'), JSON.stringify(next, null, 2));
  return next;
}
const expand = p => path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
export const home = () => expand(process.env.NOTES_HOME || settings().home || path.join(os.homedir(), 'Notes'));

// Obsidian's own settings for where attachments and daily notes go, read but never written
export function obsidian(homeDir) {
  const app = readJson(path.join(homeDir, '.obsidian', 'app.json'), {});
  const daily = readJson(path.join(homeDir, '.obsidian', 'daily-notes.json'), {});
  return {
    attachments: (app.attachmentFolderPath && app.attachmentFolderPath !== '/' && app.attachmentFolderPath !== './') ? app.attachmentFolderPath.replace(/^\.?\//, '') : (fs.existsSync(path.join(homeDir, '.obsidian')) && !app.attachmentFolderPath ? '' : 'attachments'),
    dailyFolder: (daily.folder || '').replace(/^\/|\/$/g, ''),
    dailyFormat: daily.format || 'YYYY-MM-DD',
    dailyTemplate: daily.template || '',
    newNoteFolder: app.newFileLocation === 'folder' ? (app.newFileFolderPath || '') : '',
  };
}
