# Vault Validator

A small Obsidian plugin for checking frontmatter and this vault's conventions. It works locally, makes no network requests, and never changes notes on save or in the background.

## Use

Open the command palette:

- **Vault Validator: Audit vault** checks Markdown notes, standalone Bases, and inline Base blocks. Daily notes are included by default.
- **Vault Validator: Audit current note** limits the audit to the open Markdown or Base file.
- **Vault Validator: Show allowed unresolved property links** lists allowed missing targets in collapsed sections, each with a nested collapsed list of linked source files and property names.
- **Vault Validator: Undo last fix** previews restoration of the previous batch.

The report supports search, a selectable-fixes filter, individual selection, and selection of all filtered fixes. Selecting filtered fixes includes all matching pages. Nothing is selected by default. Open **Preview selected fixes**, expand a file to inspect its exact property edits, then choose **Apply these fixes**.

The report distinguishes selectable cleanup, warnings requiring review, and informational findings. Links open the affected notes. Re-run the audit after manual edits.

## Rules

Selectable fixes:

- Remove empty optional properties from an explicit allowlist.
- Remove blank entries from known text-list properties.
- Remove exact duplicate tags, preserving case and order.
- Convert a scalar string into a one-item list for a known list property. Commas in author names are not split.

These fixes preserve note bodies and all unrelated parsed properties. YAML comments, anchors, quoted keys, and complex values can prevent a safe patch; those findings remain manual review items. Existing list formatting is not rewritten just for appearance.

Review-only checks:

- Type mismatches against `.obsidian/types.json` (or the vault's configured settings folder), supplemented with common property defaults in `src/core.cjs`. Unregistered, unknown properties are not inferred from sample notes. Obsidian's internally inferred but unsaved types are not available through this approach.
- Invalid ISO dates/date-times. Valid existing timestamps are accepted. `created` is never automatically changed, removed, inferred from file dates, or added when absent.
- Invalid or missing project/effort status, invalid food recipe types, and food recipe metadata on camera recipes.
- More than one `type/*` role tag, undocumented role/state tags, noncanonical project links, malformed category links, and categories on daily records.
- Missing standard Children / Project material sections and embeds on maps and project notes. These are textual checks; no automatic insertion.
- Unresolved wikilinks in frontmatter, reported as informational because links to future notes are legitimate. This is not a body-link or broken-attachment checker.
- Base views without a recognised template-folder exclusion, including inline Bases in callouts. The checker recognises common simple filters, not arbitrary Bases logic. Complex filters can produce informational false positives. Exact-folder exclusions are reported because they do not exclude nested template folders.

## Scope and settings

Templates are audited but **never automatically fixed**. Templater `<% ... %>` and `{{...}}` expressions in template properties are exempt from value checks. The same unevaluated expression in an ordinary note can still be flagged.

Settings let you include/exclude Daily, enable link and Base checks, name template folders, exclude folders, and configure optional properties. Defaults exclude `Attachments`; Obsidian itself excludes hidden directories such as this plugin's source folder. Blank values for unknown properties are preserved. `false` and `0` are not empty values.

**Allowed orphan property links** accepts comma-separated or newline-separated targets, for example `Books,SOMETHING_ELSE`. Enter exact, case-sensitive link targets without `[[brackets]]`. Aliases and headings do not affect matching; `Books` also allows `[[Books#Heading|Label]]`, but does not allow `[[Folder/Books]]`. Allowed targets are omitted from unresolved-link audit findings; other property checks still apply. The separate command shows only currently unresolved uses, respects Daily and excluded-folder settings, excludes templates, and works even when link reporting is disabled. It does not inspect body links or change notes.

This plugin does not assign categories, infer ownership, rename files, rewrite Bases, add provenance tags, or install other plugins. Schema constants currently reflect this vault; edit `src/core.cjs` if adapting it elsewhere. No automatic-on-save mode is included in version 0.1.

## Safe writes and undo

Every audit keeps an exact content snapshot. Applying fixes uses Obsidian's atomic `Vault.process` API and compares the current file with that snapshot. Changed, deleted, or renamed files are skipped rather than overwritten. Other selected files can still succeed; the result lists skips and failures.

Before any write, the plugin saves the original and proposed contents to its local `data.json`. If that initial save fails, no note writes begin. Prepared backups support recovery after interruption. Undo restores only files still matching the proposed result and retains conflicting entries for later recovery. The operation is atomic per file, not across the whole batch.

Only the last batch is retained. A new applied batch replaces that undo record, as stated in its preview. Batches over 10 million serialized characters are refused; select fewer files. Normal backup/version-control practices remain useful.

**Do not publish `data.json`: it contains settings and original note contents.** It is excluded by `.gitignore`. Changing note names after a batch prevents automatic undo for those paths; the original data remains in the journal.

## Source and development

This directory is both the installed plugin and its source project. Copy the directory into a separate repository later, excluding `node_modules/` and `data.json`. No repository has been initialized here.

```sh
npm ci
npm run check
```

`npm run check` checks source syntax, runs the test suite, and builds `main.js`. Runtime has no external dependencies: Obsidian supplies its YAML parser and UI. The `yaml` development dependency is only for tests. The tiny build script bundles the pure rule engine into the plugin entry point; no bundler is needed.

- `src/core.cjs`: rules, guarded frontmatter patches, Base checks, planning and transaction helpers.
- `src/plugin.cjs`: Obsidian integration, commands, settings, previews and undo journal.
- `tests/`: regression tests for rules, preservation, drift and recovery behavior.
- `main.js`, `manifest.json`, `styles.css`: installable plugin files.

For another vault, copy those three runtime files into `.obsidian/plugins/vault-validator/`, then enable **Vault Validator** in Community plugins. Development source can stay here but is not required at runtime. The implementation uses cross-platform Obsidian APIs; mobile interaction still needs device testing.
