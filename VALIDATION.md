# Validation record

## 0.2.0

- Vault conventions moved from source constants into settings with neutral defaults. Default settings check only Obsidian's built-in properties, saved property types, dates and unresolved property links.
- `npm run check` passes 46 tests, source and bundle syntax checks, and the build.
- New coverage: neutral defaults raise no convention findings, daily-note rules depend on the configured folder, link-property rules, allowed values on list properties, a custom status property, settings text parsers, and positive folder restrictions in Base filters.
- Compared 0.1.0 and 0.2.0 on a real vault of about 1,800 notes and Bases, with the 0.1.0 conventions entered as settings: both versions produced the same findings.

## 0.1.0

Automated tests cover:

- Empty-value cleanup, preserving `false` and `0`, exact tag deduplication and scalar-to-list conversion.
- No splitting of comma-containing author names; ambiguous tag strings remain manual review.
- Date validity, leap years, existing timestamps, template expression handling, and protected properties.
- Invalid or duplicate YAML keys, commented or complex YAML refusal, CRLF and BOM preservation, exact body preservation, selected-property isolation, and idempotence.
- Unresolved link reporting, the allowed orphan link list, inline Base extraction, and conservative template exclusion checks.
- Stale input and undo conflicts, per-file write failures, durable backup before writes, failure to save the initial backup, recovery from prepared journals, protected-folder changes, serialised settings and journal saves, and overlapping operation prevention.

Live checks in Obsidian:

- Loaded and enabled the plugin without restarting the app.
- Ran a read-only audit of a full vault, including daily notes.
- With a temporary fixture note, selected cleanup findings, inspected the rendered before/after preview, applied the fixes, then restored the original exactly through the undo preview.
- Confirmed the allowed orphan link sections render collapsed and the setting and command are registered.

## Limits

- Mobile APIs are compatible by design but have not been tested on a device.
- Base exclusion checking is deliberately conservative, not a full Bases expression interpreter.
- The plugin reads saved property types, not Obsidian's undocumented inferred-type registry. Unknown properties without a saved or fallback type are not type-checked.
