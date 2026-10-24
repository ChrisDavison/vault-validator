'use strict';

// Defaults are deliberately neutral: only Obsidian's built-in properties are known.
// Vault-specific conventions are opt-in through settings; checks with empty settings are skipped.
const DEFAULTS = {
  includeDaily: true,
  dailyFolder: '',
  templateFolders: [],
  excludedFolders: [],
  optionalProperties: ['tags', 'aliases', 'cssclasses'],
  protectedProperties: [],
  propertyTypes: {},
  allowedOrphanLinks: [],
  checkLinks: true,
  checkBases: true,
  statusProperty: 'status',
  statusTags: [],
  statuses: [],
  allowedValues: {},
  conflictingProperties: [],
  dailyForbiddenProperties: [],
  singleLinkProperties: [],
  linkListProperties: [],
  exclusiveTagPrefix: '',
  controlledTags: [],
  requiredSections: [],
};
// Obsidian's built-in property types. Saved vault types and the propertyTypes setting extend these.
const COMMON_TYPES = { tags: 'tags', aliases: 'aliases', cssclasses: 'multitext' };
const PROPERTY_TYPES = ['text', 'multitext', 'list', 'number', 'checkbox', 'date', 'datetime', 'tags', 'aliases'];
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

// Settings text parsers. Each accepts one entry per line and ignores blank or malformed lines.
const lines = value => String(value ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const splitOnce = (line, sep) => {
  const i = line.indexOf(sep);
  return i < 0 ? null : [line.slice(0, i).trim(), line.slice(i + sep.length).trim()];
};
const parseList = value => [...new Set(lines(value).map(s => s.replace(/^\/+|\/+$/g, '')).filter(Boolean))];
function parsePropertyTypes(value) {
  const out = {};
  for (const line of lines(value)) {
    const pair = splitOnce(line, ':');
    if (pair && pair[0] && PROPERTY_TYPES.includes(pair[1].toLowerCase())) out[pair[0]] = pair[1].toLowerCase();
  }
  return out;
}
function parseAllowedValues(value) {
  const out = {};
  for (const line of lines(value)) {
    const pair = splitOnce(line, ':');
    const values = pair ? [...new Set(pair[1].split(',').map(s => s.trim()).filter(Boolean))] : [];
    if (pair && pair[0] && values.length) out[pair[0]] = values;
  }
  return out;
}
const parseConflicts = value => lines(value).map(line => [...new Set(line.split(',').map(s => s.trim()).filter(Boolean))]).filter(group => group.length > 1);
function parseSections(value) {
  return lines(value).map(line => line.split('|').map(s => s.trim())).filter(parts => parts.length === 3 && parts.every(Boolean))
    .map(([tag, heading, embed]) => ({ tag, heading, embed: embed.replace(/^!?\[\[|\]\]$/g, '') }));
}
const formatSetting = {
  list: list => (list || []).join('\n'),
  propertyTypes: map => Object.entries(map || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  allowedValues: map => Object.entries(map || {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n'),
  conflicts: groups => (groups || []).map(g => g.join(', ')).join('\n'),
  sections: sections => (sections || []).map(s => `${s.tag} | ${s.heading} | ${s.embed}`).join('\n'),
};
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

function auditMarkdown({ path, text, parseYaml, types = {}, settings: given = DEFAULTS, resolveLink }) {
  const settings = { ...DEFAULTS, ...given };
  const findings = [];
  const add = (code, message, property, extra = {}) => findings.push({ path, code, message, property, severity: 'warning', ...extra });
  let doc;
  try { doc = parseDocument(text, parseYaml); }
  catch (e) { add('invalid-yaml', e.message); return findings; }
  const template = isTemplate(path, settings);
  const fm = doc.fm;
  const tags = Array.isArray(fm.tags) ? fm.tags.filter(v => typeof v === 'string') : typeof fm.tags === 'string' ? [fm.tags] : [];
  const statusKey = settings.statusProperty || 'status';
  const operational = tags.some(t => settings.statusTags.includes(t));
  const schema = { ...COMMON_TYPES, ...settings.propertyTypes, ...types };
  const normalizedTypes = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [key, value] of Object.entries(fm)) {
    if (template && placeholder(value)) continue;
    const type = normalizedTypes[key.toLowerCase()];
    const listType = ['multitext', 'list', 'tags', 'aliases'].includes(type);
    const required = settings.protectedProperties.includes(key) || (key === statusKey && operational);
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
    for (const key of settings.protectedProperties) {
      if (Object.hasOwn(fm, key) && isEmpty(fm[key])) add('empty-protected', `${key} is empty; recover the value from evidence instead of guessing it.`, key);
    }
    if (operational && settings.statuses.length && !settings.statuses.includes(fm[statusKey])) add('status', `${statusKey} must be one of: ${settings.statuses.join(', ')}.`, statusKey);
    for (const [key, allowed] of Object.entries(settings.allowedValues)) {
      if (isEmpty(fm[key])) continue;
      const values = Array.isArray(fm[key]) ? fm[key] : [fm[key]];
      if (values.some(v => !isEmpty(v) && !allowed.includes(v))) add('allowed-value', `Unknown ${key} value. Expected: ${allowed.join(', ')}.`, key);
    }
    for (const group of settings.conflictingProperties) {
      const present = group.filter(key => !isEmpty(fm[key]));
      if (present.length > 1) add('conflicting-properties', `These properties should not be used together: ${present.join(', ')}.`, present[present.length - 1]);
    }
    if (settings.dailyFolder && within(path, settings.dailyFolder)) {
      for (const key of settings.dailyForbiddenProperties) if (!isEmpty(fm[key])) add('daily-property', `Daily notes should not have ${key}.`, key);
    }
    const wikilink = v => typeof v === 'string' && /^\[\[[^\]|#]+\]\]$/.test(v);
    for (const key of settings.singleLinkProperties) {
      if (!isEmpty(fm[key]) && !wikilink(fm[key])) add('single-link', `${key} should be one unaliased wikilink.`, key);
    }
    for (const key of settings.linkListProperties) {
      const values = Array.isArray(fm[key]) ? fm[key] : isEmpty(fm[key]) ? [] : [fm[key]];
      if (values.some(v => !wikilink(v))) add('link-list', `${key} should contain only unaliased wikilinks.`, key);
    }
    const prefix = settings.exclusiveTagPrefix;
    if (prefix && new Set(tags.filter(t => t.startsWith(prefix))).size > 1) add('multiple-roles', `Use at most one ${prefix}* tag.`, 'tags');
    // A controlled tag puts its namespace (the part before the first /) under control.
    const namespaces = new Set(settings.controlledTags.filter(t => t.includes('/')).map(t => t.slice(0, t.indexOf('/') + 1)));
    for (const tag of new Set(tags)) {
      const ns = tag.includes('/') ? tag.slice(0, tag.indexOf('/') + 1) : null;
      if (ns && namespaces.has(ns) && !settings.controlledTags.includes(tag)) add('unknown-tag', `Review ${tag}; it is not in the configured list of ${ns}* tags.`, 'tags');
    }
    const withoutCode = doc.body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
    for (const { tag, heading, embed } of settings.requiredSections) {
      if (!tags.includes(tag)) continue;
      const section = new RegExp('^## ' + escapeRegex(heading) + '[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,2} |$(?![\\s\\S]))', 'm').exec(withoutCode);
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
    // A positive restriction to another, unrelated folder also excludes this one.
    const scope = /^file\.(?:inFolder|path\.startsWith)\(["']([^"']+?)\/?["']\)$/.exec(s);
    return new RegExp('^!file\\.inFolder\\(["\\\']' + f + '["\\\']\\)$').test(s)
      || new RegExp('^!file\\.path\\.startsWith\\(["\\\']' + f + '/?["\\\']\\)$').test(s)
      || /^file\.folder\s*==\s*["']\/["']$/.test(s)
      || (!!scope && !within(folder, scope[1]) && !within(scope[1], folder));
  }
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.and)) return filter.and.some(f => excludesFolder(f, folder));
  if (Array.isArray(filter.or) && filter.or.length) return filter.or.every(f => excludesFolder(f, folder));
  return false;
}
function auditBase({ path, text, parseYaml, settings: given = DEFAULTS, line = 1 }) {
  const settings = { ...DEFAULTS, ...given };
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

module.exports = { parseAllowedOrphanLinks, parseList, parsePropertyTypes, parseAllowedValues, parseConflicts, parseSections, formatSetting, unresolvedPropertyLinks, DEFAULTS, COMMON_TYPES, PROPERTY_TYPES, within, isTemplate, isEmpty, validDate, parseDocument, patchProperty, auditMarkdown, excludesFolder, auditBase, embeddedBases, planFixes, execute };
