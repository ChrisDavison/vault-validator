# Validation record

Version: 0.1.0

## Automated checks

`npm run check` passes 35 tests, checks source syntax, builds the standalone runtime, and checks the generated runtime syntax.

The tests cover:

- Empty-value cleanup, preserving `false` and `0`, exact tag deduplication and scalar-to-list conversion.
- No splitting of comma-containing author names; ambiguous tag strings remain manual review.
- Date validity, leap years, existing timestamps, template expression handling, and protected `created` values.
- Invalid/duplicate YAML keys, commented/complex YAML refusal, CRLF/BOM preservation, exact body preservation, selected-property isolation, and idempotence.
- Vault conventions, unresolved link reporting, inline Base extraction, and conservative template exclusion checks.
- Stale input and undo conflicts; per-file write failures; durable backup before writes; failure to save the initial backup; recovery from prepared journals; protected-folder changes; serialized settings/journal saves; and overlapping operation prevention.

## Live Obsidian verification

- Loaded and enabled the plugin without restarting the app; enabled state saved.
- Ran a read-only audit of 1,690 Markdown/Base files, including daily notes. Findings reflected current vault state; no fixes were applied to user notes.
- Used a temporary fixture with a duplicate tag, a null tag entry, a scalar author, a zero number, a valid creation date, and body text.
- Opened the audit modal, selected the two cleanup findings, and inspected the actual before/after preview in the rendered UI.
- Applied the two previewed changes through the UI. The result contained a clean tag list and a one-item author list; other properties and the body were preserved.
- Opened the undo preview and restored the fixture through the UI. Compared the result against the entire exact original string.
- Removed the fixture and its test undo record after verification.

## Limits

- Mobile APIs are compatible by design but have not been tested on a device.
- Base exclusion checking is deliberately conservative, not a full Bases expression interpreter.
- Role and lifecycle conventions are specific to this vault. Unknown/legacy tags are warnings, not automatic deletions.
- The plugin reads explicit saved property types, not Obsidian's undocumented inferred-type registry. Known common properties have fallback types; unknown unregistered properties are not type-checked.

## Allowed orphan property links — 2026-09-29

- Added a comma/newline allowlist and a separate grouped review command. Matching is exact and case-sensitive on the target, ignoring headings and aliases.
- `npm run check`: passed all 38 tests, source/bundle syntax checks, and build. Regression coverage includes allowlist parsing, audit suppression, retained unrelated findings, grouped unique files/properties, scope exclusions, resolved targets, disabled link reporting, and malformed YAML.
- Copied the rebuilt `main.js` to the installed plugin and reloaded it successfully.
- Live Obsidian DOM check with an injected sample report confirmed both target and nested file sections have `open: false`, and file/property labels render. Restored the real audit method immediately after the check; no sample notes or settings were saved.
- Live settings check confirmed the new setting renders and the command is registered. No captured runtime errors. Console capture was unavailable because the debugger was not attached.
