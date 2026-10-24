const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { parse: parseYaml } = require('yaml');
const core = require('../src/core.cjs');

function setup() {
  const context = {
    module: { exports: {} },
    require: name => name === './core.cjs' ? core : { Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, TFile: class {}, parseYaml },
    setTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/plugin.cjs'), 'utf8'), context);
  const plugin = new context.module.exports();
  plugin.settings = { ...core.DEFAULTS };
  plugin.data = {};
  plugin.busy = false;
  const disk = new Map([['test.md', 'before']]);
  const saves = [];
  plugin.saveData = async data => { saves.push(JSON.parse(JSON.stringify(data))); };
  plugin.process = async (file, callback) => { disk.set(file, callback(disk.get(file))); };
  return { plugin, disk, saves, plans: [{ path: 'test.md', before: 'before', after: 'after', changes: [] }] };
}

test('undo journal is durably prepared before the first write', async () => {
  const { plugin, disk, saves, plans } = setup();
  plugin.process = async (file, cb) => {
    assert.equal(saves.length, 1);
    assert.equal(saves[0].undo.state, 'prepared');
    assert.equal(saves[0].undo.entries[0].before, 'before');
    disk.set(file, cb(disk.get(file)));
  };
  const result = await plugin.apply(plans);
  assert.equal(result.changed.length, 1);
  assert.equal(saves[1].undo.state, 'applied');
});
test('failure to persist the initial journal aborts all writes', async () => {
  const { plugin, disk, plans } = setup();
  const previous = { entries: [{ path: 'older.md' }] };
  plugin.data.undo = previous;
  plugin.saveData = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(plugin.apply(plans), /No files changed/);
  assert.equal(disk.get('test.md'), 'before');
  assert.equal(plugin.data.undo, previous);
  assert.equal(plugin.busy, false);
});
test('final journal write failure retains the prepared recovery record', async () => {
  const { plugin, disk, plans } = setup();
  let prepared;
  plugin.saveData = async data => {
    if (prepared) throw new Error('storage unavailable');
    prepared = JSON.parse(JSON.stringify(data));
  };
  const result = await plugin.apply(plans);
  assert.equal(disk.get('test.md'), 'after');
  assert.equal(result.failed.length, 1);
  assert.equal(prepared.undo.entries[0].before, 'before');
  assert.equal(prepared.undo.state, 'prepared');
});
test('undo still works from a prepared journal after interrupted apply', async () => {
  const { plugin, disk, plans } = setup();
  plugin.data.undo = { state: 'prepared', entries: plans };
  disk.set('test.md', 'after');
  const result = await plugin.undo();
  assert.equal(result.changed.length, 1);
  assert.equal(disk.get('test.md'), 'before');
  assert.equal(plugin.data.undo.entries.length, 0);
});
test('undo conflicts remain in the journal for manual recovery', async () => {
  const { plugin, disk, plans } = setup();
  await plugin.apply(plans);
  disk.set('test.md', 'newer edits');
  const result = await plugin.undo();
  assert.equal(result.skipped.length, 1);
  assert.equal(plugin.data.undo.entries.length, 1);
  assert.equal(disk.get('test.md'), 'newer edits');
});
test('protected folder changes invalidate an earlier preview', async () => {
  const { plugin, disk, plans } = setup();
  plugin.settings.excludedFolders = ['test.md'];
  await assert.rejects(plugin.apply(plans), /protected or excluded/);
  assert.equal(disk.get('test.md'), 'before');
});
test('overlapping operations are blocked', async () => {
  const { plugin, plans } = setup();
  plugin.busy = true;
  await assert.rejects(plugin.apply(plans), /Another fix/);
  await assert.rejects(plugin.undo(), /Another fix/);
});
test('settings and journal saves are serialized and snapshot their values', async () => {
  const { plugin } = setup();
  const writes = [];
  let release;
  plugin.saveData = async data => {
    writes.push(data.settings.includeDaily);
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
  };
  const first = plugin.persist();
  await new Promise(resolve => setTimeout(resolve, 0));
  plugin.settings.includeDaily = false;
  const second = plugin.persist();
  assert.deepEqual(writes, [true]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [true, false]);
});

test('orphan report groups unique files and properties, respects scope and ignores resolved targets', async () => {
  const { plugin } = setup();
  plugin.settings = { ...core.DEFAULTS, allowedOrphanLinks: ['Books', 'Existing'], checkLinks: false, includeDaily: false, dailyFolder: 'Daily', templateFolders: ['Templates'], excludedFolders: ['Attachments'] };
  const content = '---\nrelated: ["[[Books]]", "[[Books#Section|Alias]]", "[[Existing]]", "[[Other]]"]\nsubject: "[[Books]]"\n---\n[[Body only]]';
  const paths = ['b.md', 'a.md', 'Templates/Test.md', 'Daily/Test.md', 'Attachments/Test.md', 'Test.base', 'bad.md'];
  plugin.app = {
    vault: {
      getFiles: () => paths.map(path => ({ path, extension: path.split('.').pop() })),
      read: async file => file.path === 'bad.md' ? '---\ninvalid' : content,
    },
    metadataCache: { getFirstLinkpathDest: target => target === 'Existing' },
  };
  const result = await plugin.audit(undefined, () => {}, true);
  assert.deepEqual([...result.orphanGroups.keys()], ['Books']);
  assert.deepEqual([...result.orphanGroups.get('Books').keys()], ['a.md', 'b.md']);
  assert.deepEqual([...result.orphanGroups.get('Books').get('a.md')], ['related', 'subject']);
  assert.equal(result.scanned, 4);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].path, 'bad.md');
});
