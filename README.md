# Notes

A vault for you and your agents. Notes are plain Markdown files, and [Obsidian](https://obsidian.md) opens the folder as it is, so nothing is locked in a database. Any agent can read and write the files, and whatever it changes shows up in the page as it lands.

- **Left, the Librarian.** One long-running conversation with Claude Code or Codex. It summarizes, links related notes, files things, answers from what you wrote, and turns a messy meeting dump into clean notes. Each message carries the note you have open and what you've selected.
- **Middle, the page.** A calm editor with Obsidian's live preview:
  - Markdown renders as you write, and the line you're editing shows its syntax.
  - The big title is the file name, as in Obsidian; renaming it rewrites every link to the note.
  - Type `/` for blocks, `[[` to link a note, `#` for tags. Paste or drop an image to attach it.
  - Linked and unlinked mentions sit under the page.
- **Right, the vault.** Search, New note, Today's note, recent notes, the folder tree, the note's outline, and tags.

## Obsidian-compatible, on purpose

| | |
|---|---|
| Notes | one `.md` file each, anywhere in the vault; dot-folders (`.obsidian`, `.trash`, `.git`) are not notes |
| Properties | YAML front matter, shown as a Properties block |
| Links | `[[Note]]`, `[[Note#Heading]]`, `[[Note\|alias]]`, `[[folder/Note]]`, resolved like Obsidian's (path, then name in the same folder, then shortest path); following a link to a missing note creates it |
| Embeds | `![[image.png]]` and `![[Note]]`; attachments resolve by name anywhere; pasted images go where `.obsidian/app.json` says, else `attachments/` |
| Tags, tasks | `#tags` (and `tags:` in properties), `- [ ]` / `- [x]` |
| Daily notes | today's note uses `.obsidian/daily-notes.json`'s folder, format and template, else `YYYY-MM-DD.md` at the top |
| Delete | moves to `.trash/`, Obsidian's own trash |

`.obsidian/` is read, never written. The editor never reformats your text: rendering is decoration only, so a file is byte-for-byte what you (or an agent) typed, and git diffs stay clean. When a note changes on disk while you have unsaved typing, the page asks which version to keep instead of overwriting either.

## Install it on a Cube

Notes is a [Cube app](https://github.com/collabs-inc/cube-computer/blob/apps/docs/apps.md). Add `https://github.com/collabs-inc/cube-notes` in the Apps surface, or install it from the Market. It needs only Node 20: the install has no dependencies to fetch, and it creates `~/Notes` (a git repository with a welcome note).

To use an existing vault, set `NOTES_HOME` or `"home"` in `~/.local/state/cube-notes/settings.json`. Notes never changes an existing vault except for the edits you and your agents make.

| What | Where |
|---|---|
| Your notes | `~/Notes` |
| The Librarian's conversation | `~/.local/state/cube-notes` |

## For agents

The files are the API: edit them directly. The app adds what grep can't do well, all documented in `librarian/LIBRARIAN.md`:
- search;
- backlinks and unlinked mentions;
- link resolution;
- tags and tasks;
- today's note;
- a rename that fixes every link.

## How a Cube app is put together

Same template as [Cube Studio](https://github.com/collabs-inc/cube-studio) and [Radar](https://github.com/collabs-inc/cube-radar). `cube.json` names the app and says how to install and start it. `server/setup-home.mjs` creates the vault once. The server listens on `$PORT` on `127.0.0.1`. `kit/` is shared unchanged with the other apps: the persona column and the look.

The editor is CodeMirror 6 with a live-preview layer (`web/editor.js`). It is bundled to `web/editor.bundle.js`, which is committed so installs need no build. After changing it, run `npm install && npm run build`.

## Layout

```
cube.json              the Cube app contract
server/                server.mjs (API, events, Librarian), vault.mjs (index, links, search), paths.mjs, setup-home.mjs
web/                   the page; editor.js → editor.bundle.js
kit/                   the persona column and the look, shared with Cube Studio and Radar
librarian/             LIBRARIAN.md, the Librarian's brief
starter/               what ~/Notes starts with
```

## Run it outside Cube

```bash
node server/setup-home.mjs && node server/server.mjs    # http://127.0.0.1:4322 ; NOTES_HOME, NOTES_STATE, PORT override
npm test
```

The server binds to `127.0.0.1` only. Outside Cube nothing signs a visitor in, so don't expose it.
