'use strict';
const { Plugin, Modal, Notice, Setting, PluginSettingTab, TFile, parseYaml } = require('obsidian');
const core = require('./core.cjs');

module.exports = class VaultValidator extends Plugin {
  async onload() {
    this.data = (await this.loadData()) || {};
    this.settings = { ...core.DEFAULTS, ...this.data.settings };
    this.busy = false;
    this.modals = new Set();
    this.addCommand({ id: 'audit-vault', name: 'Audit vault', callback: () => this.openAudit() });
    this.addCommand({ id: 'audit-current-note', name: 'Audit current note', callback: () => {
      const file = this.app.workspace.getActiveFile();
      if (!file || !['md', 'base'].includes(file.extension)) return new Notice('Open a Markdown note or Base first.');
      this.openAudit(file);
    } });
    this.addCommand({ id: 'show-allowed-orphan-links', name: 'Show allowed unresolved property links', callback: () => new OrphanLinksModal(this).open() });
    this.addCommand({ id: 'undo-last-fix', name: 'Undo last fix', callback: () => this.openUndo() });
    this.addSettingTab(new ValidatorSettings(this.app, this));
  }
  onunload() { for (const modal of this.modals) modal.close(); }
  async persist() {
    this.data.settings = this.settings;
    const snapshot = JSON.parse(JSON.stringify(this.data));
    const write = (this.saveQueue || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    this.saveQueue = write;
    await write;
  }
  async propertyTypes() {
    // Public adapter API; this file contains explicit vault-wide property type assignments.
    // Do not depend on Obsidian's internal metadataTypeManager or guess types from one note.
    const path = `${this.app.vault.configDir}/types.json`;
    if (!(await this.app.vault.adapter.exists(path))) return {};
    return JSON.parse(await this.app.vault.adapter.read(path)).types || {};
  }
  async audit(file, progress = () => {}, orphanReport = false) {
    const types = orphanReport ? {} : await this.propertyTypes();
    const files = (file ? [file] : this.app.vault.getFiles()).filter(f => {
      if (!(orphanReport ? ['md'] : ['md', 'base']).includes(f.extension)) return false;
      if (!this.settings.includeDaily && this.settings.dailyFolder && core.within(f.path, this.settings.dailyFolder)) return false;
      return !this.settings.excludedFolders.some(folder => core.within(f.path, folder));
    }).sort((a, b) => a.path.localeCompare(b.path));
    const findings = [], snapshots = new Map(), orphanGroups = new Map();
    const allowed = new Set(this.settings.allowedOrphanLinks || []);
    const resolveLink = (target, source) => !!this.app.metadataCache.getFirstLinkpathDest(target, source);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const text = await this.app.vault.read(f);
        snapshots.set(f.path, text);
        if (orphanReport) {
          if (!core.isTemplate(f.path, this.settings)) {
            const { fm } = core.parseDocument(text, parseYaml);
            for (const { target, property } of core.unresolvedPropertyLinks({ fm, path: f.path, resolveLink })) {
              if (!allowed.has(target)) continue;
              if (!orphanGroups.has(target)) orphanGroups.set(target, new Map());
              const uses = orphanGroups.get(target);
              if (!uses.has(f.path)) uses.set(f.path, new Set());
              uses.get(f.path).add(property);
            }
          }
        } else if (f.extension === 'md') {
          findings.push(...core.auditMarkdown({ path: f.path, text, parseYaml, types, settings: this.settings, resolveLink }));
          if (this.settings.checkBases) for (const block of core.embeddedBases(text)) findings.push(...core.auditBase({ path: f.path, ...block, parseYaml, settings: this.settings }));
        } else if (this.settings.checkBases) findings.push(...core.auditBase({ path: f.path, text, parseYaml, settings: this.settings }));
      } catch (e) { findings.push({ path: f.path, severity: 'warning', code: 'read-error', message: e.message }); }
      if (i % 25 === 0) {
        progress(`Checking ${i + 1} of ${files.length} files…`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    return { findings, snapshots, scanned: files.length, orphanGroups };
  }
  openAudit(file) {
    if (this.busy) return new Notice('Wait for the current fix or undo to finish.');
    const modal = new AuditModal(this, file);
    modal.open();
  }
  process(path, callback) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('File was removed or renamed; audit again.');
    return this.app.vault.process(file, callback);
  }
  async apply(plans) {
    if (this.busy) throw new Error('Another fix or undo is running.');
    if (!plans.length) throw new Error('No changes selected.');
    if (plans.some(p => core.isTemplate(p.path, this.settings) || this.settings.excludedFolders.some(f => core.within(p.path, f)))) throw new Error('The selection contains a protected or excluded file. Audit again.');
    if (JSON.stringify(plans).length > 10_000_000) throw new Error('This batch is too large for the undo record. Select fewer files.');
    this.busy = true;
    try {
      const journal = { at: new Date().toISOString(), entries: plans, state: 'prepared' };
      const previous = this.data.undo;
      this.data.undo = journal;
      try { await this.persist(); }
      catch (e) { this.data.undo = previous; throw new Error(`Could not save undo record. No files changed. ${e.message}`); }
      const result = await core.execute(plans, (path, callback) => this.process(path, callback));
      // Keep all prepared entries for crash recovery; undo compares exact content before restoring.
      journal.state = 'applied'; journal.result = result;
      try { await this.persist(); }
      catch (e) { result.failed.push({ path: '(undo record)', message: `Could not update the record; the prepared backup remains available. ${e.message}` }); }
      return result;
    } finally { this.busy = false; }
  }
  async undo() {
    if (this.busy) throw new Error('Another fix or undo is running.');
    const journal = this.data.undo;
    if (!journal?.entries?.length) throw new Error('No saved fix to undo.');
    this.busy = true;
    try {
      const result = await core.execute(journal.entries, (path, callback) => this.process(path, callback), 'undo');
      const restored = new Set(result.changed);
      journal.entries = journal.entries.filter(entry => !restored.has(entry.path));
      journal.state = journal.entries.length ? 'partial-undo' : 'undone';
      // Retain conflicts for later recovery rather than losing their original content.
      await this.persist();
      return result;
    } finally { this.busy = false; }
  }
  openUndo() {
    if (!this.data.undo?.entries?.length) return new Notice('No saved fix to undo.');
    new PreviewModal(this, this.data.undo.entries, true).open();
  }
};

class ValidatorModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() { this.plugin.modals.add(this); this.modalEl.addClass('vault-validator'); }
  onClose() { this.plugin.modals.delete(this); this.contentEl.empty(); }
  button(parent, label, action, primary = false) {
    const b = parent.createEl('button', { text: label });
    if (primary) b.addClass('mod-cta');
    b.addEventListener('click', action);
    return b;
  }
}

class OrphanLinksModal extends ValidatorModal {
  onOpen() { super.onOpen(); this.run(); }
  async run() {
    const el = this.contentEl;
    el.empty();
    el.createEl('h2', { text: 'Allowed unresolved property links' });
    const status = el.createEl('p', { text: 'Reading frontmatter…', attr: { 'aria-live': 'polite' } });
    try {
      const result = await this.plugin.audit(undefined, message => status.setText(message), true);
      if (!this.plugin.modals.has(this)) return;
      status.setText(`${result.orphanGroups.size} allowed unresolved targets · ${result.scanned} files checked.`);
      el.createEl('p', { text: 'Uses the audit folder and daily-note settings. Templates are excluded. Only targets that are still unresolved are shown.' });
      this.button(el, 'Refresh', () => this.run());
      if (!result.orphanGroups.size) el.createEl('p', { text: 'No allowed unresolved property links found. Add targets in Settings → Vault Validator → Allowed orphan property links.' });
      for (const [target, uses] of [...result.orphanGroups].sort(([a], [b]) => a.localeCompare(b))) {
        const group = el.createEl('details');
        group.open = false;
        group.createEl('summary', { text: `${target} · ${uses.size} ${uses.size === 1 ? 'file' : 'files'}` });
        const files = group.createEl('details');
        files.open = false;
        files.createEl('summary', { text: 'Files using this target' });
        const list = files.createEl('ul');
        for (const [path, properties] of uses) {
          const row = list.createEl('li');
          const link = row.createEl('a', { text: path, href: '#', cls: 'internal-link' });
          link.addEventListener('click', event => { event.preventDefault(); this.app.workspace.openLinkText(path, '', true); });
          row.createSpan({ text: ` · ${[...properties].sort().join(', ')}`, cls: 'vv-muted' });
        }
      }
      for (const finding of result.findings) el.createEl('p', { text: `Could not check ${finding.path}: ${finding.message}` });
    } catch (e) { status.setText(`Could not list property links: ${e.message}`); }
  }
}

class AuditModal extends ValidatorModal {
  constructor(plugin, file) { super(plugin); this.file = file; this.selected = new Set(); this.filter = ''; this.onlyFixes = false; this.page = 0; }
  onOpen() { super.onOpen(); this.run(); }
  async run() {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'Vault Validator' });
    const status = this.contentEl.createEl('p', { text: 'Reading frontmatter…', attr: { 'aria-live': 'polite' } });
    try {
      this.result = await this.plugin.audit(this.file, message => status.setText(message));
      this.selected.clear(); this.page = 0;
      if (this.plugin.modals.has(this)) this.render();
    } catch (e) { status.setText(`Audit failed: ${e.message}`); }
  }
  render() {
    const el = this.contentEl; el.empty();
    const { findings, scanned } = this.result;
    const fixable = findings.filter(f => f.fix).length;
    el.createEl('h2', { text: this.file ? `Audit: ${this.file.name}` : 'Vault audit' });
    el.createEl('p', { text: `${scanned} ${scanned === 1 ? 'file' : 'files'} checked · ${findings.length} findings · ${fixable} selectable fixes. No files changed by this audit.` });
    const controls = el.createDiv({ cls: 'vv-controls' });
    const search = controls.createEl('input', { type: 'search', placeholder: 'Filter by file, property or finding', attr: { 'aria-label': 'Filter findings' } });
    search.value = this.filter;
    new Setting(el).setName('Show only selectable fixes').addToggle(t => t.setValue(this.onlyFixes).onChange(v => { this.onlyFixes = v; this.page = 0; renderRows(); }));
    const toolbar = el.createDiv({ cls: 'vv-controls' });
    this.button(toolbar, 'Select filtered fixes', () => { for (const f of filtered()) if (f.fix) this.selected.add(f); renderRows(); });
    this.button(toolbar, 'Clear selection', () => { this.selected.clear(); renderRows(); });
    const preview = this.button(toolbar, 'Preview selected fixes', () => {
      try {
        const plans = core.planFixes(this.result.snapshots, [...this.selected], parseYaml);
        if (!plans.length) return new Notice('Select at least one fix.');
        new PreviewModal(this.plugin, plans, false, () => this.run()).open();
      } catch (e) { new Notice(e.message); }
    }, true);
    this.button(toolbar, 'Audit again', () => this.run());
    const count = el.createEl('p', { cls: 'vv-muted', attr: { 'aria-live': 'polite' } });
    const list = el.createDiv({ cls: 'vv-findings' });
    const pager = el.createDiv({ cls: 'vv-controls' });
    const filtered = () => findings.filter(f => (!this.onlyFixes || f.fix) && `${f.path} ${f.property || ''} ${f.code} ${f.message}`.toLowerCase().includes(this.filter.toLowerCase()));
    const renderRows = () => {
      list.empty(); pager.empty();
      const values = filtered();
      const pages = Math.max(1, Math.ceil(values.length / 75));
      this.page = Math.min(this.page, pages - 1);
      count.setText(`${values.length} matching findings · ${this.selected.size} selected · page ${this.page + 1} of ${pages}`);
      preview.disabled = this.selected.size === 0;
      for (const f of values.slice(this.page * 75, (this.page + 1) * 75)) {
        const row = list.createDiv({ cls: 'vv-finding' });
        if (f.fix) {
          const cb = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `Select ${f.property} fix in ${f.path}` } });
          cb.checked = this.selected.has(f);
          cb.addEventListener('change', () => { cb.checked ? this.selected.add(f) : this.selected.delete(f); count.setText(`${values.length} matching findings · ${this.selected.size} selected · page ${this.page + 1} of ${pages}`); preview.disabled = !this.selected.size; });
        } else row.createSpan({ text: f.severity === 'info' ? 'Info' : 'Review', cls: 'vv-badge' });
        const detail = row.createDiv();
        const link = detail.createEl('a', { text: f.path, href: '#', cls: 'internal-link' });
        link.addEventListener('click', event => { event.preventDefault(); this.app.workspace.openLinkText(f.path, '', true); });
        if (f.property) detail.createSpan({ text: ` · ${f.property}`, cls: 'vv-muted' });
        if (f.line) detail.createSpan({ text: ` · line ${f.line}`, cls: 'vv-muted' });
        detail.createEl('p', { text: f.message });
      }
      if (!values.length) list.createEl('p', { text: 'No findings match this filter.' });
      this.button(pager, 'Previous', () => { this.page--; renderRows(); }).disabled = this.page === 0;
      this.button(pager, 'Next', () => { this.page++; renderRows(); }).disabled = this.page >= pages - 1;
    };
    search.addEventListener('input', () => { this.filter = search.value; this.page = 0; renderRows(); });
    renderRows();
  }
}

class PreviewModal extends ValidatorModal {
  constructor(plugin, plans, undo, done) { super(plugin); this.plans = plans; this.isUndo = undo; this.done = done; }
  onOpen() {
    super.onOpen();
    const el = this.contentEl;
    el.createEl('h2', { text: this.isUndo ? 'Preview undo' : 'Preview selected fixes' });
    el.createEl('p', { text: `${this.plans.length} ${this.plans.length === 1 ? 'file' : 'files'}. Files changed since this snapshot will be skipped.` });
    el.createEl('p', { text: this.isUndo ? 'Only files still matching the saved result will be restored. Newer edits are protected.' : 'A local undo record is saved before writing. This batch replaces the previous undo record. Note bodies are preserved.' });
    const container = el.createDiv({ cls: 'vv-preview' });
    for (const plan of this.plans) {
      const section = container.createEl('details');
      section.open = this.plans.length <= 5;
      section.createEl('summary', { text: plan.path });
      for (const change of plan.changes) {
        section.createEl('h4', { text: change.property });
        const grid = section.createDiv({ cls: 'vv-diff' });
        for (const [label, content] of [['Before', this.isUndo ? change.after : change.before], ['After', this.isUndo ? change.before : change.after]]) {
          const col = grid.createDiv(); col.createEl('strong', { text: label }); col.createEl('pre', { text: content });
        }
      }
    }
    const controls = el.createDiv({ cls: 'vv-controls' });
    const status = el.createEl('p', { attr: { 'aria-live': 'polite' } });
    const apply = this.button(controls, this.isUndo ? 'Undo saved fixes' : 'Apply these fixes', async () => {
      apply.disabled = true;
      status.setText('Working…');
      try {
        // Undo previews must still reference the current journal, not a newer batch.
        if (this.isUndo && this.plans !== this.plugin.data.undo?.entries) throw new Error('The undo record changed. Open a new undo preview.');
        const result = this.isUndo ? await this.plugin.undo() : await this.plugin.apply(this.plans);
        status.setText(`${result.changed.length} files ${this.isUndo ? 'restored' : 'updated'} · ${result.skipped.length} skipped · ${result.failed.length} failed.`);
        for (const issue of [...result.skipped, ...result.failed]) el.createEl('p', { text: `${issue.path}: ${issue.message}` });
        if (this.done) this.done();
      } catch (e) { status.setText(e.message); }
    }, true);
    this.button(controls, 'Close', () => this.close());
  }
}

class ValidatorSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl; el.empty();
    const settings = this.plugin.settings;
    const save = async () => { try { await this.plugin.persist(); } catch (e) { new Notice(`Settings could not be saved: ${e.message}`); } };
    const toggle = (key, name, desc) => new Setting(el).setName(name).setDesc(desc)
      .addToggle(t => t.setValue(settings[key]).onChange(async v => { settings[key] = v; await save(); }));
    const text = (key, name, desc, placeholder, normalize = v => v.trim()) => new Setting(el).setName(name).setDesc(desc)
      .addText(t => t.setPlaceholder(placeholder).setValue(settings[key]).onChange(async v => { settings[key] = normalize(v); await save(); }));
    // Text areas store parsed values; malformed lines are dropped when saved.
    const area = (key, name, desc, placeholder, parse, format) => new Setting(el).setName(name).setDesc(desc)
      .addTextArea(t => t.setPlaceholder(placeholder).setValue(format(settings[key])).onChange(async v => { settings[key] = parse(v); await save(); }));
    const list = (key, name, desc, placeholder) => area(key, name, desc, placeholder, core.parseList, core.formatSetting.list);

    el.createEl('p', { text: 'Audits run only when requested, and fixes always need a preview. Convention checks below are off until you configure them.' });

    new Setting(el).setName('Scope').setHeading();
    list('templateFolders', 'Template folders', 'One folder per line. Templates are audited but never fixed, and Templater expressions are exempt from value checks.', 'Templates');
    list('excludedFolders', 'Excluded folders', 'One folder per line. These folders and their contents are not audited.', 'Attachments');
    text('dailyFolder', 'Daily notes folder', 'Folder holding daily notes. Leave blank if you do not use one.', 'Daily', v => v.trim().replace(/^\/+|\/+$/g, ''));
    toggle('includeDaily', 'Include daily notes', 'Audit notes in the daily notes folder.');

    new Setting(el).setName('Properties').setHeading();
    list('optionalProperties', 'Optional properties', 'One property per line. Empty values of these properties can be removed as a fix.', 'tags');
    list('protectedProperties', 'Protected properties', 'One property per line. These are never removed, and are flagged when empty. Example: created.', 'created');
    area('propertyTypes', 'Fallback property types', `One "property: type" per line. Used when the vault has no saved type for a property. Types: ${core.PROPERTY_TYPES.join(', ')}.`, 'created: date', core.parsePropertyTypes, core.formatSetting.propertyTypes);
    area('allowedValues', 'Allowed values', 'One "property: value, value" per line. Other values are reported.', 'priority: low, medium, high', core.parseAllowedValues, core.formatSetting.allowedValues);
    area('conflictingProperties', 'Conflicting properties', 'One comma-separated group per line. A note using more than one property in a group is reported.', 'isbn, doi', core.parseConflicts, core.formatSetting.conflicts);
    list('dailyForbiddenProperties', 'Properties not allowed in daily notes', 'One property per line. Requires a daily notes folder.', 'categories');

    new Setting(el).setName('Links').setHeading();
    toggle('checkLinks', 'Report unresolved frontmatter links', 'Report wikilinks in properties whose target does not exist, as information.');
    new Setting(el).setName('Allowed orphan property links')
      .setDesc('Link targets allowed to be missing, separated by commas or new lines. Use exact, case-sensitive targets without [[brackets]]. These links are omitted from audits; use “Show allowed unresolved property links” to review their files.')
      .addTextArea(t => t.setPlaceholder('Books, Someday').setValue(settings.allowedOrphanLinks.join(', ')).onChange(async value => {
        settings.allowedOrphanLinks = core.parseAllowedOrphanLinks(value);
        await save();
      }));
    list('singleLinkProperties', 'Single-link properties', 'One property per line. Each must hold exactly one unaliased wikilink.', 'project');
    list('linkListProperties', 'Link-list properties', 'One property per line. Each may hold only unaliased wikilinks.', 'categories');

    new Setting(el).setName('Tags and status').setHeading();
    list('controlledTags', 'Controlled tags', 'One nested tag per line. Each listed tag puts its namespace under control: other tags in that namespace are reported. Example: type/project controls type/*.', 'type/project');
    text('exclusiveTagPrefix', 'Exclusive tag prefix', 'Notes may carry at most one tag starting with this prefix. Leave blank to skip.', 'type/');
    list('statusTags', 'Tags requiring a status', 'One tag per line. Notes with these tags must have a valid status property, which is never removed.', 'type/project');
    text('statusProperty', 'Status property', 'Property checked on notes with a status tag.', 'status');
    list('statuses', 'Allowed statuses', 'One value per line. Leave empty to skip the status check.', 'active');

    new Setting(el).setName('Sections').setHeading();
    area('requiredSections', 'Required sections', 'One "tag | heading | embed" per line. Notes with the tag need the embed under that level-two heading.', 'type/project | Tasks | Tasks.base', core.parseSections, core.formatSetting.sections);
    toggle('checkBases', 'Check Base template exclusions', 'Report Base views that do not exclude the template folders.');

    el.createEl('p', { cls: 'setting-item-description', text: 'The last undo record is stored locally in this plugin’s data.json. It contains original note contents; do not share that file.' });
  }
}
