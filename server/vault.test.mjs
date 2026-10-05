import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVault, parseNote, frontmatter } from './vault.mjs';

function vaultWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  return createVault(dir);
}

test('front matter, links, tags and tasks, ignoring code', () => {
  const n = parseNote('---\ntitle: X\ntags: [a, b]\naliases:\n  - Y\n---\n# Head\nSee [[Other]] and [[Deep/Note#Part|label]] ![[pic.png]] #idea #nested/tag\n`[[not a link]] #nottag`\n```\n[[nope]] #nope\n```\n- [ ] open\n- [x] done\n## Not #a-tag heading\n');
  assert.deepEqual(n.props, { title: 'X', tags: ['a', 'b'], aliases: ['Y'] });
  assert.deepEqual(n.links.map(l => [l.target, l.anchor, l.embed]), [['Other', null, false], ['Deep/Note', 'Part|label'.split('|')[0], false], ['pic.png', null, true]]);
  assert.deepEqual(n.tags.sort(), ['a', 'a-tag', 'b', 'idea', 'nested/tag']);
  assert.deepEqual(n.tasks.map(t => [t.done, t.text]), [[false, 'open'], [true, 'done']]);
  assert.deepEqual(n.headings.map(h => h.text), ['Head', 'Not #a-tag heading']);
});

test('links resolve like Obsidian: path, then name in the same folder, then the shortest path', () => {
  const v = vaultWith({ 'Ideas.md': '', 'work/Ideas.md': '', 'work/Plan.md': 'Link [[Ideas]] here', 'Home.md': '[[Ideas]] [[work/Ideas]] [[Missing]]', '.obsidian/x.md': '', 'img/pic.png': 'x' });
  assert.equal(v.resolve('Ideas', 'work/Plan.md'), 'work/Ideas.md');
  assert.equal(v.resolve('Ideas', 'Home.md'), 'Ideas.md');
  assert.equal(v.resolve('work/Ideas', 'Home.md'), 'work/Ideas.md');
  assert.equal(v.resolve('ideas'), 'Ideas.md');                      // case-insensitive
  assert.equal(v.resolve('Missing'), null);
  assert.equal(v.resolveFile('pic.png', 'Home.md'), 'img/pic.png');  // embeds resolve by name anywhere
  assert.ok(!v.note('.obsidian/x.md'));                              // dot-folders are not notes
  assert.deepEqual(v.backlinks('work/Ideas.md').map(b => b.path).sort(), ['Home.md', 'work/Plan.md']);
  assert.deepEqual(v.unresolved().map(u => u.target), ['Missing']);
});

test('search ranks names over text; front matter without a closing line is just text', () => {
  const v = vaultWith({ 'Garden.md': 'plants', 'Notes.md': 'the garden is green, garden again' });
  assert.deepEqual(v.search('garden').map(r => r.path), ['Garden.md', 'Notes.md']);
  assert.equal(frontmatter('---\nno end').end, 0);
});
