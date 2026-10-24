# Vault Validator

An Obsidian plugin that audits note properties (frontmatter) against your vault's conventions, previews safe cleanup fixes, and can undo the last batch of fixes. It works locally, makes no network requests, and never changes notes on save or in the background.

Out of the box it checks only Obsidian's built-in properties and the property types saved in your vault. Every convention check, such as allowed statuses, controlled tags or required sections, is off until you configure it.

## Commands

- **Audit vault** checks Markdown notes, standalone Bases, and Base code blocks in notes.
- **Audit current note** limits the audit to the open Markdown note or Base.
- **Show allowed unresolved property links** lists the allowed missing link targets, with the files and properties that use them.
- **Undo last fix** previews restoring the files changed by the last applied batch.

The audit report supports search, a filter for selectable fixes, individual selection, and selection of all filtered fixes. Nothing is selected by default. Choose **Preview selected fixes**, expand a file to inspect its exact property edits, then choose **Apply these fixes**. Links in the report open the affected notes. Run the audit again after manual edits.

## What it checks

Selectable fixes:

- Remove empty values of properties listed as optional.
- Remove blank entries from list properties.
- Remove exact duplicate tags, preserving case and order.
- Convert a single text value into a one-item list for a list property. Commas are never split, so `Surname, Name` stays one value.

Fixes preserve note bodies and all unrelated properties. YAML comments, anchors, quoted keys and complex values can prevent a safe patch; those findings stay as manual review items. Existing list formatting is not rewritten for appearance.

Always-on review checks:

- Type mismatches against the vault's saved property types (`types.json` in the settings folder), Obsidian's built-in `tags`, `aliases` and `cssclasses`, and any fallback types you configure. Unknown properties are not type-checked.
- Invalid ISO dates and date-times. Existing dates are never rewritten.
- Unresolved wikilinks in properties, reported as information because links to future notes are legitimate. Body links and attachments are not checked.

Convention checks, each skipped until configured:

- Protected properties that are present but empty.
- Allowed statuses for notes carrying particular tags.
- Allowed values for specific properties.
- Groups of properties that should not be used together.
- Properties not allowed in daily notes.
- Properties that must hold one unaliased wikilink, or only unaliased wikilinks.
- Controlled tag namespaces and an exclusive tag prefix (at most one such tag per note).
- Required level-two sections containing a specific embed, for notes with a given tag.
- Base views with no recognised exclusion of your template folders, including Base code blocks inside callouts. Common simple filters are recognised, not arbitrary Bases logic, so complex filters can give informational false positives.

## Settings

| Setting | Default | Purpose |
| :-- | :-- | :-- |
| Template folders | none | Audited but never fixed. Templater `<% ... %>` and `{{...}}` expressions are exempt from value checks. |
| Excluded folders | none | Not audited. Obsidian already skips hidden folders. |
| Daily notes folder | none | Enables the daily-note options below. |
| Include daily notes | on | Audit the daily notes folder. |
| Optional properties | `tags`, `aliases`, `cssclasses` | Empty values can be removed as a fix. |
| Protected properties | none | Never removed; flagged when empty. For example `created`. |
| Fallback property types | none | `property: type` lines, used when the vault has no saved type. |
| Allowed values | none | `property: value, value` lines. |
| Conflicting properties | none | Comma-separated groups; a note may use only one property from each. |
| Properties not allowed in daily notes | none | Requires a daily notes folder. |
| Report unresolved frontmatter links | on | Report missing link targets as information. |
| Allowed orphan property links | none | Exact, case-sensitive targets without brackets. `Books` also allows `[[Books#Heading\|Label]]` but not `[[Folder/Books]]`. |
| Single-link properties | none | Each must hold one unaliased wikilink, for example `project`. |
| Link-list properties | none | Each may hold only unaliased wikilinks, for example `categories`. |
| Controlled tags | none | Listing `type/project` puts the `type/` namespace under control; other `type/*` tags are reported. |
| Exclusive tag prefix | none | At most one tag with this prefix per note, for example `type/`. |
| Tags requiring a status | none | Notes with these tags need a valid status, which is never removed. |
| Status property | `status` | Property checked for those notes. |
| Allowed statuses | none | The status check is skipped while this is empty. |
| Required sections | none | `tag \| heading \| embed` lines, for example `type/project \| Tasks \| Tasks.base`. |
| Check Base template exclusions | on | Needs at least one template folder. |

Blank values of properties that are not listed as optional are kept. `false` and `0` are not treated as empty.

## Safe writes and undo

Every audit keeps an exact snapshot of each file. Applying fixes uses Obsidian's atomic `Vault.process` API and compares the current file with that snapshot. Changed, deleted or renamed files are skipped rather than overwritten; other selected files can still succeed, and the result lists skips and failures.

Before any write, the plugin saves the original and proposed contents to its `data.json`. If that save fails, no notes are written. Undo restores only files that still match the fixed result, and keeps conflicting entries for later recovery. Writes are atomic per file, not across the whole batch.

Only the last batch is kept: applying a new batch replaces the undo record. Batches over 10 million serialised characters are refused; select fewer files. Normal backups and version control remain useful.

The plugin's `data.json` holds your settings and the original contents of the last batch of fixed notes, so do not share it.

## Vault access

Auditing the whole vault needs a list of every file, so the plugin enumerates the vault with `Vault.getFiles()`. It reads only Markdown notes and Bases outside your excluded folders, plus Obsidian's property types file (`.obsidian/types.json`). It does this only when you run an audit command, and nothing leaves your device: the plugin makes no network requests and stores only its settings and undo record.

## Installation

From Obsidian: open **Settings → Community plugins → Browse**, search for **Vault Validator**, install it and enable it.

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): add the beta plugin `ChrisDavison/vault-validator`.

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/ChrisDavison/vault-validator/releases/latest) into `<vault>/.obsidian/plugins/vault-validator/`, then enable **Vault Validator** under Community plugins.

The plugin uses only cross-platform Obsidian APIs, but it has not been tested on mobile devices.

## Development

```sh
npm ci
npm run check
```

`npm run check` checks source syntax, runs the tests and builds `main.js`. Edit `src/`, not `main.js`. The runtime has no dependencies, as Obsidian supplies its YAML parser and UI; the `yaml` development dependency is used only by the tests. A small build script bundles the rule engine into the plugin entry point, so no bundler is needed.

- `src/core.cjs`: rules, settings parsers, guarded property patches, Base checks, and planning and transaction helpers.
- `src/plugin.cjs`: Obsidian integration, commands, settings, previews and the undo journal.
- `tests/`: regression tests for rules, preservation, drift and recovery.

## Licence

[MIT](LICENSE)
