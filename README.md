# Select Code Lines Highlighter

Select Code Lines Highlighter is a self-contained Obsidian plugin that highlights an exact text selection or whole lines inside a fenced Markdown code block. Highlights appear in the editor and Reading view. Exact-text highlights are stored in the plugin's local data, leaving the entire note unchanged. Whole-line highlights use compact `hl:` fence metadata.

It is useful for terminal output, Nmap scans, logs, stack traces, configuration snippets, and other blocks where copying or rewriting content just to emphasize a few lines is undesirable.

> [!IMPORTANT]
> Version 0.2.0 adds exact-text highlights with yellow and red colors. Exact-text highlights are stored in the plugin's local data: include that data in your backups. The default command mode is now **Exact text**; choose **Whole lines** in settings to keep using line highlights.

## Features

- Highlight exact text using local anchors, including multiline selections, without expanding the opening fence.
- Choose yellow for important text or red for critical text; both colors can coexist in one block.
- Keep the selected occurrence highlighted when text is inserted before it and its context remains identifiable.
- Optionally add selected code lines to an `hl:` specification.
- Remove selected lines from an existing specification.
- Access both actions from the editor context menu when the selection is inside a supported code block.
- Merge, sort, deduplicate, split, and compact line ranges automatically.
- Preserve the language identifier, unrelated metadata, whitespace, and all code-block content.
- Render highlighted lines directly in the editor and Reading view, without another plugin.
- Provide its own full-line background layer without Codeblock Customizer, Code Styler, themes, or external CSS snippets.
- Configure shared intensity, whole-line highlight color, accent color, and accent width from the native plugin settings.
- Support backtick and tilde fences, including fences longer than three characters.
- Refuse ambiguous selections or malformed `hl:` metadata without modifying the note.

## Usage

The default **Highlight selection as → Exact text** mode highlights only the selected characters. Select `CIAO` inside a code block, then run **Highlight code selection**. Inserting `prefix ` before that word keeps `CIAO` highlighted when its surrounding context can still identify it. Selecting across lines highlights the selected text on each line.

Right-click the selection and choose **Highlight code selection → Yellow** or **Red**. Recoloring replaces only the selected part; surrounding highlights keep their colors. The original command/shortcut uses yellow in Exact text mode. **Highlight code selection as critical (red)** is a separate command for red text, regardless of the global selection mode. Removal affects either color. The submenu uses an optional Obsidian hook; hosts without it receive two flat menu choices instead.

Exact-text anchors live in `.obsidian/plugins/select-code-lines-highlighter/data.json`, keyed by note path. Each stores the text, up to 32 Unicode characters of context on each side, and occurrence information. Copying code into another note does not copy its highlights. Back up the plugin data as well as your notes; uninstalling the plugin or syncing only Markdown files can lose the highlights.

Existing local anchors without a color remain yellow. The color-aware database is version 3 and accepts the earlier version 2 format. Earlier local builds cannot edit a version 3 database; retain a backup before downgrading.

Use **Remove highlight from code selection** to subtract only the selected part. **Clear text highlights in current code block** removes located local highlights in that block. **Clear all local text highlights in current note** also removes unresolved anchors, whose original block cannot be determined safely. These commands participate in native Undo/Redo during the editing session.

Deleting or editing highlighted text in the editor removes its local anchor. Undo restores both. External changes are treated conservatively: unrecognizable anchors remain hidden until the note is reopened or cleared. Note and folder rename/delete events update the database. No vault-wide scans run while typing; saves are batched after a short idle period. Abrupt application termination before a save completes can lose the latest highlight changes, but cannot change the note's code.

### Migrating the earlier local candidate

Legacy `ht:<base64url-json>` metadata is still rendered. Run **Move legacy text highlights to plugin storage in current note** to migrate it. The command backs up the opening fences in a timestamped file inside the plugin directory, saves and reads back the new database, then removes the tokens in one undoable transaction. It refuses malformed or unresolved anchors and leaves the note unchanged. Keep migration backups until you have verified the result; they are not automatically purged.

For whole-line highlights, select **Highlight selection as → Whole lines** in the plugin options.

Given this block:

````markdown
```text
PORT      STATE SERVICE
22/tcp    open  ssh
80/tcp    open  http
445/tcp   open  microsoft-ds
```
````

Select the last two lines and run **Highlight code selection** in Whole lines mode. The result is:

````markdown
```text hl:3-4
PORT      STATE SERVICE
22/tcp    open  ssh
80/tcp    open  http
445/tcp   open  microsoft-ds
```
````

Only the opening fence changes. Run **Remove highlight from code selection** in Whole lines mode to subtract selected lines from the existing `hl:` value.

You can also right-click a selection inside a supported fenced code block to access these commands. Local text highlights, legacy `ht:` and `hl:` render together regardless of the selected command mode. Migrate legacy text highlights before editing/removing them with the local commands.

To assign a shortcut, open **Settings → Hotkeys**, search for **Highlight code selection**, and choose your preferred key combination. Existing shortcuts remain valid because the original command IDs have not changed. No shortcuts are assigned automatically.

## Settings

Open **Settings → Community plugins → Select Code Lines Highlighter → Options** to choose Exact text or Whole lines. Text highlights have two fixed colors (yellow and red), selected per highlight in the context menu. Highlight intensity affects both colors and whole-line highlights. The color picker, accent color and accent width apply only to whole-line highlights. Visual changes apply immediately in the editor and Reading view. **Restore defaults** resets visual settings and selects Exact text mode; it does not recolor existing text highlights.

## Rendering

The plugin includes its own renderer for the editor and Reading view. It does not require Codeblock Customizer, Code Styler, or a special theme. The portable `hl:` metadata remains compatible with other tools that understand the same syntax.

## Installation and updates

In Obsidian, open **Settings → Community plugins → Browse**, search for **Select Code Lines Highlighter**, and install and enable it. Existing users can use **Check for updates** and update the plugin in place, preserving settings and local text highlights.

The [GitHub release](https://github.com/Tc-XoNoR/select-code-lines-highlighter/releases/latest) also provides the files for manual installation. The community listing notes that the plugin has not been manually reviewed by Obsidian staff.

### Manual installation

Requires Obsidian 1.5.0 or later.

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create `<your-vault>/.obsidian/plugins/select-code-lines-highlighter/`.
3. Copy all three files into that directory.
4. Reload Obsidian if it is already open.
5. Open **Settings → Community plugins → Installed plugins** and enable **Select Code Lines Highlighter**.

## Limitations

- A selection must be non-empty, continuous, and wholly inside the content of one fenced code block.
- Top-level fenced blocks are supported. Nested blocks in lists, block quotes, or callouts are not supported.
- Existing `hl:` values must contain only positive safe integers and ascending ranges such as `2,4-6`.
- Multiple selections, unclosed fences, multiple `hl:` tokens, and malformed metadata are rejected.
- Soft-wrapped visual lines retain one highlight for the logical Markdown line.
- Text highlights are case-sensitive exact matches. Edited/deleted text, reduced occurrence counts, or ambiguous/missing context leave an anchor unresolved. Select the new text again; use the clear command to remove obsolete anchors.
- Text and context cannot establish identity after arbitrary rewrites or replacement with identical content. Ordinal alone is never used to guess. Very repetitive selections may be refused; select more surrounding text instead.
- Text selections and each resulting anchor are limited to 4 KiB UTF-8. A note supports up to 256 anchors and 64 KiB JSON; the local database supports 512 notes, 4,096 anchors and 4 MiB total. Oversized changes are refused. Notes over 1,048,576 UTF-16 code units or 10,000 lines skip highlighting to bound processing; the note remains editable.
- In Reading view, text highlights are skipped when a renderer changes the code text in a way that prevents exact offset mapping (for example, expanding tabs). Deferred syntax highlighting is observed without replacing the syntax spans.
- Corrupt or unknown database formats switch local storage to read-only, preserving the original data. A failed save shows a Notice and remains pending for a later save. These safeguards and tests cannot guarantee that every third-party plugin combination is crash-free.

## Development

Requires Node.js 18 or later and pnpm.

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

The production bundle is written to `main.js`. The source structure and build configuration follow the current official Obsidian sample plugin conventions.

Tests cover pure anchoring/metadata logic, mocked editor transactions, CodeMirror decorations and Reading view DOM slices. Real Obsidian visual checks are tracked separately from automated tests; unit tests alone do not establish visual correctness, persistence or Undo/Redo behavior.

## Privacy and security

The plugin runs locally with no telemetry, analytics or network requests. Highlight data and migration backups contain selected text and nearby context in plain text, inside your vault's plugin directory. Exact-text commands do not edit notes; whole-line commands and explicit legacy migration change only opening fences.

## License

[MIT](LICENSE)
