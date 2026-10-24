const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse: parseYaml } = require('yaml');
const c = require('../src/core.cjs');
const note = (yaml, body = '# Body\n\nKeep this exact.\n') => `---\n${yaml}\n---\n${body}`;
// An example vault with configured conventions. Defaults alone check only Obsidian built-ins.
const conventions = {
  ...c.DEFAULTS,
  dailyFolder: 'Daily',
  templateFolders: ['Templates'],
  optionalProperties: ['tags', 'aliases', 'cssclasses', 'authors', 'cuisine', 'shelf'],
  protectedProperties: ['created'],
  propertyTypes: { created: 'date', authors: 'multitext', cuisine: 'multitext', project: 'text', series_index: 'number' },
  statusTags: ['type/project', 'type/effort'],
  statuses: ['active', 'waiting', 'someday', 'completed'],
  allowedValues: { recipe_type: ['main meal', 'dessert'] },
  conflictingProperties: [['simulation', 'recipe_type']],
  dailyForbiddenProperties: ['categories'],
  singleLinkProperties: ['project'],
  linkListProperties: ['categories'],
  exclusiveTagPrefix: 'type/',
  controlledTags: ['type/MoC', 'type/project', 'type/effort', 'type/extracted', 'type/collection', 'status/wip', 'status/archived'],
  requiredSections: [{ tag: 'type/MoC', heading: 'Children', embed: 'Children.base' }, { tag: 'type/project', heading: 'Project material', embed: 'Project Children.base' }],
};
const audit = (text, options = {}) => c.auditMarkdown({ path: 'Example.md', text, parseYaml, settings: conventions, ...options });
const plan = (text, findings = audit(text)) => c.planFixes(new Map([['Example.md', text]]), findings.filter(f => f.fix), parseYaml);

test('empty optional fields removed, false and zero retained', () => {
  const text = note('tags:\nauthors: []\nseries_index: 0\nfavorite: false\ncreated: 2026-09-29');
  const [p] = plan(text);
  assert.deepEqual(c.parseDocument(p.after, parseYaml).fm, { series_index: 0, favorite: false, created: '2026-09-29' });
  assert.equal(c.parseDocument(p.after, parseYaml).body, c.parseDocument(text, parseYaml).body);
});
test('dedupe tags and remove blank entries together', () => {
  const text = note('tags: [daily, null, daily, "", work]');
  assert.deepEqual(c.parseDocument(plan(text)[0].after, parseYaml).fm.tags, ['daily', 'work']);
});
test('scalar list conversion does not split comma-separated names', () => {
  const text = note('authors: "Surname, Name"');
  assert.deepEqual(c.parseDocument(plan(text)[0].after, parseYaml).fm.authors, ['Surname, Name']);
});
test('ambiguous scalar tag strings require manual review', () => {
  assert.ok(audit(note('tags: work daily')).some(f => f.code === 'ambiguous-tags'));
  assert.equal(plan(note('tags: work daily')).length, 0);
});
test('unknown empty fields are not removed', () => {
  assert.equal(plan(note('important_unknown:')).length, 0);
});
test('created and project status are never removed even if configured optional', () => {
  const text = note('tags: [type/project]\ncreated:\nstatus:');
  const findings = audit(text, { settings: { ...conventions, optionalProperties: ['created', 'status'] } });
  assert.equal(findings.filter(f => f.fix).length, 0);
  assert.ok(findings.some(f => f.code === 'empty-protected'));
  assert.ok(findings.some(f => f.code === 'status'));
});
test('valid date-only and ISO timestamp values stay untouched', () => {
  for (const value of ['2026-09-29', '2026-09-29T00:00:00Z', '2024-02-29T12:30:59+01:00']) {
    const findings = audit(note(`created: ${value}`));
    assert.equal(findings.length, 0);
  }
});
test('invalid calendar dates and time values reported', () => {
  for (const value of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-09-29T25:00', 'yesterday']) assert.ok(audit(note(`created: ${value}`)).some(f => f.code === 'invalid-date'));
});
test('quoted numbers and booleans produce warnings, never guesses', () => {
  const findings = audit(note('series_index: "3"\nfavorite: "false"'), { types: { favorite: 'checkbox' } });
  assert.equal(findings.filter(f => f.code === 'property-type').length, 2);
  assert.equal(findings.filter(f => f.fix).length, 0);
});
test('template placeholders are ignored; other template findings are read-only', () => {
  const findings = audit(note('created: <% tp.date.now() %>\nauthors: Someone\ntags: []'), { path: 'Templates/Nested/Book.md' });
  assert.equal(findings.filter(f => f.code === 'invalid-date').length, 0);
  assert.equal(findings.filter(f => f.fix).length, 0);
  assert.ok(findings.length > 0);
});
test('placeholders outside templates are invalid dates', () => {
  assert.ok(audit(note('created: <% tp.date.now() %>')).some(f => f.code === 'invalid-date'));
});
test('frontmatter delimiters and duplicate keys are checked', () => {
  for (const text of ['---\ntags: []', note('tags: []\ntags: [work]'), note('- wrong\n- root')]) assert.equal(audit(text)[0].code, 'invalid-yaml');
});
test('complex YAML and comments require manual editing', () => {
  for (const yaml of ['authors: Someone # keep this comment', 'authors: &name Someone\nother: *name', 'authors: |\n  A long name']) {
    const findings = audit(note(yaml));
    assert.equal(findings.filter(f => f.fix).length, 0);
    assert.ok(findings.some(f => f.code === 'cleanup'));
  }
});
test('CRLF, BOM and exact body contents are preserved', () => {
  const text = '\uFEFF' + note('tags: []\ncreated: 2026-09-29', '\nText\n---\ntrailing  \n').replaceAll('\n', '\r\n');
  const after = plan(text)[0].after;
  assert.equal(after, text.replace('tags: []\r\n', ''));
});
test('quoted YAML keys are not rewritten by simple patcher', () => {
  const findings = audit(note('"authors": Someone'));
  assert.equal(findings.filter(f => f.fix).length, 0);
});
test('proposed changes affect only selected properties', () => {
  const text = note('authors: Someone\ncuisine: Spanish');
  const finding = audit(text).find(f => f.property === 'authors');
  const after = plan(text, [finding])[0].after;
  assert.deepEqual(c.parseDocument(after, parseYaml).fm, { authors: ['Someone'], cuisine: 'Spanish' });
});
test('cleanup is idempotent', () => {
  const after = plan(note('authors: Someone\ntags: [work, work, null]\nshelf:'))[0].after;
  assert.equal(plan(after).length, 0);
});
test('configured role, status, value and conflict conventions are reported', () => {
  const f = audit(note('tags: [type/project, type/roadmap, status/archived]\nstatus: started\nsimulation: Classic Chrome\nrecipe_type: food'));
  for (const code of ['multiple-roles', 'unknown-tag', 'status', 'allowed-value', 'conflicting-properties', 'missing-embed']) assert.ok(f.some(x => x.code === code), code);
  assert.ok(!f.some(x => x.code === 'unknown-tag' && x.message.includes('status/archived')));
});
test('default settings check only Obsidian built-ins, not anyone else\'s conventions', () => {
  const text = note('tags: [type/project, type/roadmap, type/MoC, status/whatever]\nstatus: started\nsimulation: X\nrecipe_type: food\nproject: "Plain text"\ncategories: [plain]\ncreated:\nauthors:\nseries_index: "3"');
  const f = audit(text, { settings: undefined, path: 'Daily/2026-01-01.md' });
  assert.deepEqual(f, []);
});
test('daily-note property rules apply only inside the configured daily folder', () => {
  const text = note('categories: ["[[Topic]]"]');
  assert.ok(audit(text, { path: 'Daily/2026-01-01.md' }).some(f => f.code === 'daily-property'));
  assert.ok(!audit(text).some(f => f.code === 'daily-property'));
  assert.ok(!audit(text, { path: 'Daily/2026-01-01.md', settings: { ...conventions, dailyFolder: '' } }).some(f => f.code === 'daily-property'));
});
test('link properties must hold unaliased wikilinks', () => {
  const f = audit(note('project: "[[A|Alias]]"\ncategories: ["[[Topic]]", "plain"]'));
  assert.ok(f.some(x => x.code === 'single-link'));
  assert.ok(f.some(x => x.code === 'link-list'));
  assert.deepEqual(audit(note('project: "[[A]]"\ncategories: ["[[Topic]]"]')), []);
});
test('allowed values accept list properties and statuses honour a custom property', () => {
  assert.ok(audit(note('recipe_type: [dessert, food]')).some(f => f.code === 'allowed-value'));
  assert.ok(!audit(note('recipe_type: [dessert]')).some(f => f.code === 'allowed-value'));
  const settings = { ...conventions, statusProperty: 'state' };
  assert.ok(!audit(note('tags: [type/effort]\nstate: active'), { settings }).some(f => f.code === 'status'));
  assert.ok(audit(note('tags: [type/effort]\nstate: done'), { settings }).some(f => f.code === 'status'));
});
test('settings text parsers drop blank and malformed lines', () => {
  assert.deepEqual(c.parseList(' /Templates/ \n\nDaily\nDaily'), ['Templates', 'Daily']);
  assert.deepEqual(c.parsePropertyTypes('created: date\nrating: Number\nbad: colour\nnocolon'), { created: 'date', rating: 'number' });
  assert.deepEqual(c.parseAllowedValues('recipe_type: main meal, dessert\nempty:\nnone'), { recipe_type: ['main meal', 'dessert'] });
  assert.deepEqual(c.parseConflicts('simulation, recipe_type\nalone'), [['simulation', 'recipe_type']]);
  assert.deepEqual(c.parseSections('type/MoC | Children | ![[Children.base]]\nbad | line'), [{ tag: 'type/MoC', heading: 'Children', embed: 'Children.base' }]);
  const values = { recipe_type: ['main meal', 'dessert'] };
  assert.deepEqual(c.parseAllowedValues(c.formatSetting.allowedValues(values)), values);
  const sections = conventions.requiredSections;
  assert.deepEqual(c.parseSections(c.formatSetting.sections(sections)), sections);
});
test('collection and archived tags are allowed while collection still counts as a role', () => {
  assert.deepEqual(audit(note('tags: [type/collection, state/archived]')), []);
  const findings = audit(note('tags: [type/collection, type/extracted, state/archived]'));
  assert.ok(findings.some(f => f.code === 'multiple-roles'));
  assert.ok(!findings.some(f => f.code === 'unknown-tag'));
});
test('required section embeds are recognized', () => {
  const f = audit(note('tags: [type/project]\nstatus: active', '## Tasks\n\n- [ ] Work\n\n## Project material\n\n![[Project Children.base]]\n'));
  assert.ok(!f.some(x => x.code === 'missing-embed'));
});
test('an embed in an unrelated section does not satisfy a requirement', () => {
  assert.ok(audit(note('tags: [type/MoC]', '## Children\nNothing\n## Other\n![[Children.base]]\n')).some(f => f.code === 'missing-embed'));
});
test('unresolved frontmatter links are informational and never fixed', () => {
  const f = audit(note('project: "[[Future project]]"'), { resolveLink: () => false });
  const unresolved = f.find(x => x.code === 'unresolved-link');
  assert.equal(unresolved.severity, 'info'); assert.ok(!unresolved.fix);
});
test('a positive restriction to another folder counts as a template exclusion', () => {
  assert.ok(c.excludesFolder('file.inFolder("Projects")', 'Templates'));
  assert.ok(c.excludesFolder('file.path.startsWith("Daily/")', 'Templates'));
  assert.ok(!c.excludesFolder('file.inFolder("Templates")', 'Templates'));
  assert.ok(!c.excludesFolder('file.inFolder("Templates/Nested")', 'Templates'));
});
test('Base checks are skipped without template folders', () => {
  assert.deepEqual(c.auditBase({ path: 'Test.base', text: 'views:\n  - name: All\n    type: table\n', parseYaml }), []);
});
test('template exclusion proof respects AND and OR', () => {
  const excludes = '!file.inFolder("Templates")';
  assert.ok(c.excludesFolder({ and: ['recipe_type', excludes] }, 'Templates'));
  assert.ok(!c.excludesFolder({ or: ['recipe_type', excludes] }, 'Templates'));
  assert.ok(!c.excludesFolder('!file.path.startsWith("templates")', 'Templates'));
  assert.ok(!c.excludesFolder('file.folder != "Templates"', 'Templates'));
  assert.ok(c.excludesFolder('file.folder == "/"', 'Templates'));
});
test('Base checks consider view filters independently', () => {
  const text = 'views:\n  - name: All\n    type: table\n  - name: Daily\n    type: table\n    filters: file.path.startsWith("Daily")\n';
  const f = c.auditBase({ path: 'Test.base', text, parseYaml, settings: conventions });
  assert.equal(f.length, 1); assert.match(f[0].message, /All/);
});
test('inline Base extraction handles callouts and ignores nested examples', () => {
  const text = '> ```base\n> views: []\n> ```\n\n````markdown\n```base\nviews: []\n```\n````\n';
  assert.deepEqual(c.embeddedBases(text), [{ text: 'views: []', line: 1 }]);
});
test('atomic apply skips drift and continues other files', async () => {
  const files = { 'a.md': 'new edit', 'b.md': 'before' };
  const result = await c.execute([{ path: 'a.md', before: 'before', after: 'after' }, { path: 'b.md', before: 'before', after: 'after' }], async (p, cb) => { files[p] = cb(files[p]); });
  assert.equal(files['a.md'], 'new edit'); assert.equal(files['b.md'], 'after');
  assert.deepEqual(result.changed, ['b.md']); assert.equal(result.skipped.length, 1);
});
test('undo skips edited notes, restores unchanged results exactly', async () => {
  const files = { a: 'later', b: 'after' };
  const entries = ['a', 'b'].map(path => ({ path, before: 'before', after: 'after' }));
  const result = await c.execute(entries, async (p, cb) => { files[p] = cb(files[p]); }, 'undo');
  assert.deepEqual(files, { a: 'later', b: 'before' }); assert.equal(result.skipped.length, 1);
});
test('write failures are distinguished from drift', async () => {
  const result = await c.execute([{ path: 'a', before: 'b', after: 'c' }], async () => { throw new Error('Disk full'); });
  assert.equal(result.failed.length, 1); assert.equal(result.skipped.length, 0);
});

test('orphan allowlist accepts commas and lines and removes blanks and duplicates', () => {
  assert.deepEqual(c.parseAllowedOrphanLinks(' Books,SOMETHING_ELSE\nBooks, , Other '), ['Books', 'SOMETHING_ELSE', 'Other']);
});
test('allowed targets suppress only unresolved-link findings with exact target matching', () => {
  const findings = audit(note('categories: ["[[Books]]", "[[Other/Books]]", "[[books]]"]\nrelated: ["[[Books#Heading|Alias]]", "[[Existing]]"]\nseries_index: wrong'), {
    settings: { ...conventions, allowedOrphanLinks: ['Books'] }, resolveLink: target => target === 'Existing',
  });
  assert.deepEqual(findings.filter(f => f.code === 'unresolved-link').map(f => f.message), [
    'Unresolved property link: Other/Books. This may be intentional.',
    'Unresolved property link: books. This may be intentional.',
  ]);
  assert.ok(findings.some(f => f.code === 'property-type'));
});
