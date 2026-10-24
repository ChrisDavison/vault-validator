'use strict';

const DEFAULTS = {
  includeDaily: true,
  templateFolders: ['Templates'],
  excludedFolders: ['Attachments'],
  optionalProperties: ['tags', 'aliases', 'cssclasses', 'categories', 'authors', 'funder', 'people', 'cuisine', 'project', 'parent_project', 'recipe_type', 'series', 'series_index', 'shelf', 'language', 'source'],
  allowedOrphanLinks: [],
  checkLinks: true,
  checkBases: true,
};
const COMMON_TYPES = {
  tags: 'tags', aliases: 'aliases', cssclasses: 'multitext', created: 'date', birthday: 'date',
  categories: 'multitext', authors: 'multitext', funder: 'multitext', people: 'multitext', cuisine: 'multitext',
  project: 'text', parent_project: 'text', series_index: 'number',
};
const ROLE_TAGS = ['type/MoC', 'type/project', 'type/effort', 'type/meeting', 'type/extracted', 'type/collection'];
const STATE_TAGS = ['status/priority', 'status/temporary', 'status/wip', 'status/watched', 'status/unprocessed', 'status/archived'];
const STATUSES = ['active', 'waiting', 'someday', 'completed'];
const RECIPES = ['main meal', 'dessert', 'bread', 'sauce', 'drink', 'workday lunch'];
const isEmpty = v => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const within = (path, folder) => path === folder || path.startsWith(folder.replace(/\/$/, '') + '/');
const isTemplate = (path, settings) => settings.templateFolders.some(folder => within(path, folder));
const placeholder = value => /<%[\s\S]*?%>|\{\{[\s\S]*?\}\}/.test(JSON.stringify(value));
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseDocument(text, parseYaml) {
  const first = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (!first) return { fm: {}, body: text, start: 0, end: 0, raw: '', exists: false };
  const rest = text.slice(first[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) throw new Error('Frontmatter has no closing delimiter.');
  const raw = rest.slice(0, close.index);
  const fm = parseYaml(raw) ?? {};
  if (typeof fm !== 'object' || Array.isArray(fm)) throw new Error('Frontmatter must be a mapping of property names to values.');
  // Some parsers accept duplicate keys. Refuse fixes even when that parser keeps the last value.
  const keys = [...raw.matchAll(/^([A-Za-z_][\w -]*):/gm)].map(m => m[1]);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate frontmatter keys; resolve them before applying fixes.');
  const start = first[0].length;
  return { fm, raw, start, end: start + raw.length, exists: true, body: rest.slice(close.index + close[0].length) };
}

function validDate(value, datetime = false) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!m || (datetime && m[4] == null)) return false;
  const [year, month, day] = m.slice(1, 4).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return false;
  if (m[4] != null && (+m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59)) return false;
  const offset = /[+-](\d{2}):?(\d{2})$/.exec(value);
  return !offset || (+offset[1] <= 23 && +offset[2] <= 59);
}

// Patch a simple top-level field only. Parse the candidate and prove all other values unchanged.
// Refuse comments, anchors, multiline scalars and other complex YAML rather than reserializing it.
function patchProperty(text, property, next, parseYaml) {
  const doc = parseDocument(text, parseYaml);
  if (!doc.exists || !/^[A-Za-z_][\w -]*$/.test(property)) throw new Error('This property needs manual editing.');
  const re = new RegExp('^' + escapeRegex(property) + ':[^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*(?:\\r?\\n|$)', 'm');
  const hit = re.exec(doc.raw);
  if (!hit) throw new Error('Cannot safely locate this property.');
  if (/[#&*!>|]/.test(hit[0])) throw new Error('Comments, aliases or complex YAML require manual editing.');
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const replacement = next === undefined ? '' : Array.isArray(next)
    ? `${property}:${nl}${next.map(v => '  - ' + JSON.stringify(v)).join(nl)}${nl}`
    : `${property}: ${JSON.stringify(next)}${nl}`;
  const raw = doc.raw.slice(0, hit.index) + replacement + doc.raw.slice(hit.index + hit[0].length);
  const after = text.slice(0, doc.start) + raw + text.slice(doc.end);
  const actual = parseDocument(after, parseYaml);
  const expected = { ...doc.fm };
  if (next === undefined) delete expected[property]; else expected[property] = next;
  if (!same(actual.fm, expected) || actual.body !== doc.body) throw new Error('The edit would change other properties or note content.');
  return { after, beforeSnippet: hit[0], afterSnippet: replacement || '(remove property)' };
}

// Targets are case-sensitive; aliases and headings do not change the target.
function parseAllowedOrphanLinks(value) {
  return [...new Set(value.split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
}
function unresolvedPropertyLinks({ fm, path, resolveLink }) {
  const links = [];
  for (const [property, value] of Object.entries(fm)) {
    for (const s of Array.isArray(value) ? value : [value]) {
      if (typeof s !== 'string') continue;
      for (const match of s.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
        const target = match[1].trim();
        if (target && !resolveLink(target, path)) links.push({ path, property, target });
      }
    }
  }
  return links;
}

function auditMarkdown({ path, text, parseYaml, types = {}, settings = DEFAULTS, resolveLink }) {
  const findings = [];
  const add = (code, message, property, extra = {}) => findings.push({ path, code, message, property, severity: 'warning', ...extra });
  let doc;
  try { doc = parseDocument(text, parseYaml); }
  catch (e) { add('invalid-yaml', e.message); return findings; }
  const template = isTemplate(path, settings);
  const fm = doc.fm;
  const tags = Array.isArray(fm.tags) ? fm.tags.filter(v => typeof v === 'string') : typeof fm.tags === 'string' ? [fm.tags] : [];
  const operational = tags.some(t => t === 'type/project' || t === 'type/effort');
  const schema = { ...COMMON_TYPES, ...types };
  const normalizedTypes = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [key, value] of Object.entries(fm)) {
    if (template && placeholder(value)) continue;
    const type = normalizedTypes[key.toLowerCase()];
    const listType = ['multitext', 'list', 'tags', 'aliases'].includes(type);
    const required = key === 'created' || (key === 'status' && operational);
    let next = value;
    const reasons = [];
    if (listType && typeof value === 'string' && !isEmpty(value)) {
      if (key === 'tags' && /[\s,#]/.test(value)) {
        add('ambiguous-tags', 'Tags stored as text need review; splitting them could change their meaning.', key);
      } else { next = [value]; reasons.push('Store the text as a one-item list.'); }
    }
    if (Array.isArray(next) && listType) {
      const clean = next.filter(v => !isEmpty(v));
      if (!same(clean, next)) reasons.push('Remove empty list entries.');
      next = clean;
      if (key === 'tags') {
        const unique = next.filter((v, i) => typeof v !== 'string' || next.indexOf(v) === i);
        if (!same(unique, next)) reasons.push('Remove duplicate tags.');
        next = unique;
      }
    }
    if (isEmpty(next) && !required && settings.optionalProperties.includes(key)) {
      next = undefined; reasons.push('Remove the empty optional property.');
    }
    if (!same(value, next)) {
      const finding = { next, remove: next === undefined };
      if (!template) {
        try {
          const patch = patchProperty(text, key, next, parseYaml);
          finding.fix = { property: key, next, remove: next === undefined, beforeSnippet: patch.beforeSnippet, afterSnippet: patch.afterSnippet };
        } catch (e) { reasons.push(e.message); }
      } else reasons.push('Templates are read-only in this plugin.');
      add('cleanup', reasons.join(' '), key, finding);
    }
    const checked = next === undefined ? undefined : next;
    if (isEmpty(checked)) continue;
    if (listType && (!Array.isArray(checked) || checked.some(v => typeof v !== 'string'))) add('property-type', 'Expected a list of text values.', key);
    if (type === 'number' && (typeof checked !== 'number' || !Number.isFinite(checked))) add('property-type', 'Expected a number. Review the value before converting it.', key);
    if (type === 'checkbox' && typeof checked !== 'boolean') add('property-type', 'Expected true or false, without quotes.', key);
    if (type === 'text' && typeof checked !== 'string') add('property-type', 'Expected text, not a list, number or object.', key);
    if (['date', 'datetime'].includes(type) && !validDate(checked, type === 'datetime')) add('invalid-date', 'Expected a valid ISO date or date/time. Existing dates are never rewritten automatically.', key);
  }
  if (!template) {
    if (Object.hasOwn(fm, 'created') && isEmpty(fm.created)) add('empty-created', 'Created is empty; recover the date from evidence instead of using the modification time.', 'created');
    if (operational && !STATUSES.includes(fm.status)) add('status', `Project and effort status must be one of: ${STATUSES.join(', ')}.`, 'status');
    if (!isEmpty(fm.recipe_type) && !RECIPES.includes(fm.recipe_type)) add('recipe-type', `Unknown food recipe type. Expected: ${RECIPES.join(', ')}.`, 'recipe_type');
    if (!isEmpty(fm.simulation) && !isEmpty(fm.recipe_type)) add('camera-recipe', 'A camera recipe should not have a food recipe_type.', 'recipe_type');
    if (within(path, 'Daily') && !isEmpty(fm.categories)) add('daily-categories', 'Daily records should not have categories.', 'categories');
    for (const key of ['project', 'parent_project']) {
      if (!isEmpty(fm[key]) && !(typeof fm[key] === 'string' && /^\[\[[^\]|#]+\]\]$/.test(fm[key]))) add('ownership-link', 'Use one canonical, unaliased wikilink for project ownership.', key);
    }
    const cats = Array.isArray(fm.categories) ? fm.categories : isEmpty(fm.categories) ? [] : [fm.categories];
    if (cats.some(v => typeof v !== 'string' || !/^\[\[[^\]|#]+\]\]$/.test(v))) add('category-link', 'Categories should contain unaliased wikilinks to concepts or maps of content.', 'categories');
    const roles = tags.filter(t => t.startsWith('type/'));
    if (new Set(roles).size > 1) add('multiple-roles', 'Use at most one type/* role tag.', 'tags');
    for (const tag of new Set(tags)) {
      if ((tag.startsWith('type/') && !ROLE_TAGS.includes(tag)) || (tag.startsWith('status/') && !STATE_TAGS.includes(tag))) add('unknown-tag', `Review ${tag}; it is outside this vault's documented role/state tags.`, 'tags');
    }
    const withoutCode = doc.body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
    for (const [tag, heading, embed] of [['type/MoC', 'Children', 'Children.base'], ['type/project', 'Project material', 'Project Children.base']]) {
      if (!tags.includes(tag)) continue;
      const section = new RegExp('^## ' + heading + '[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,2} |$(?![\\s\\S]))', 'm').exec(withoutCode);
      if (!section || !section[1].includes(`![[${embed}]]`)) add('missing-embed', `Expected ![[${embed}]] under ## ${heading}.`);
    }
    if (settings.checkLinks && resolveLink) {
      const allowed = new Set(settings.allowedOrphanLinks || []);
      for (const { property, target } of unresolvedPropertyLinks({ fm, path, resolveLink })) {
        if (!allowed.has(target)) add('unresolved-link', `Unresolved property link: ${target}. This may be intentional.`, property, { severity: 'info' });
      }
    }
  }
  return findings;
}

// Conservative proof for common simple filters, not a complete Bases expression interpreter.
function excludesFolder(filter, folder) {
  if (typeof filter === 'string') {
    const s = filter.trim();
    const f = escapeRegex(folder);
    return new RegExp('^!file\\.inFolder\\(["\\\']' + f + '["\\\']\\)$').test(s)
      || new RegExp('^!file\\.path\\.startsWith\\(["\\\']' + f + '/?["\\\']\\)$').test(s)
      || /^file\.folder\s*==\s*["']\/["']$/.test(s)
      || (folder !== 'Daily' && /^file\.path\.startsWith\(["']Daily\/?["']\)$/.test(s));
  }
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.and)) return filter.and.some(f => excludesFolder(f, folder));
  if (Array.isArray(filter.or) && filter.or.length) return filter.or.every(f => excludesFolder(f, folder));
  return false;
}
function auditBase({ path, text, parseYaml, settings = DEFAULTS, line = 1 }) {
  let config;
  try { config = parseYaml(text); }
  catch (e) { return [{ path, line, severity: 'warning', code: 'base-yaml', message: `Invalid Base YAML: ${e.message}` }]; }
  if (!config || typeof config !== 'object' || !Array.isArray(config.views)) return [{ path, line, severity: 'warning', code: 'base-yaml', message: 'Base must contain a views list.' }];
  const out = [];
  for (const view of config.views) for (const folder of settings.templateFolders) {
    if (!excludesFolder({ and: [config.filters, view?.filters] }, folder)) out.push({ path, line, severity: 'info', code: 'base-templates', message: `View “${view?.name || '(unnamed)'}”: no recognised exclusion for ${folder}/ and its subfolders. Review complex filters manually.` });
  }
  return out;
}
function embeddedBases(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const plain = lines[i].replace(/^(?:> ?)+/, '');
    if (!fence) {
      const start = /^\s*(`{3,}|~{3,})([^`]*)$/.exec(plain);
      if (start) fence = { token: start[1][0], length: start[1].length, base: start[2].trim() === 'base', line: i + 1, lines: [] };
    } else if (new RegExp('^\\s*' + fence.token + '{' + fence.length + ',}\\s*$').test(plain)) {
      if (fence.base) blocks.push({ text: fence.lines.join('\n'), line: fence.line });
      fence = null;
    } else fence.lines.push(plain);
  }
  return blocks;
}
function planFixes(snapshots, selected, parseYaml) {
  const plans = new Map();
  for (const finding of selected) {
    if (!finding.fix) continue;
    const before = snapshots.get(finding.path);
    if (typeof before !== 'string') throw new Error('Missing audit snapshot. Run the audit again.');
    const plan = plans.get(finding.path) || { path: finding.path, before, after: before, changes: [] };
    const fix = finding.fix;
    plan.after = patchProperty(plan.after, fix.property, fix.remove ? undefined : fix.next, parseYaml).after;
    plan.changes.push({ property: fix.property, before: fix.beforeSnippet, after: fix.afterSnippet });
    plans.set(finding.path, plan);
  }
  return [...plans.values()].filter(p => p.before !== p.after);
}

// The caller persists this whole journal BEFORE calling execute. Recovery also works after a crash.
async function execute(entries, process, direction = 'apply') {
  const result = { changed: [], skipped: [], failed: [] };
  for (const entry of entries) {
    const from = direction === 'undo' ? entry.after : entry.before;
    const to = direction === 'undo' ? entry.before : entry.after;
    try {
      await process(entry.path, current => {
        if (current !== from) throw new Error('File changed since the preview; skipped to preserve newer edits.');
        return to;
      });
      result.changed.push(entry.path);
    } catch (e) {
      const target = String(e.message).includes('File changed since') ? result.skipped : result.failed;
      target.push({ path: entry.path, message: String(e.message) });
    }
  }
  return result;
}

module.exports = { parseAllowedOrphanLinks, unresolvedPropertyLinks, DEFAULTS, COMMON_TYPES, within, isTemplate, isEmpty, validDate, parseDocument, patchProperty, auditMarkdown, excludesFolder, auditBase, embeddedBases, planFixes, execute };
