# Changelog

## 0.2.0

- Highlight selected characters inside code blocks in Live Preview and Reading view, including Unicode and multiline selections.
- Choose **Yellow** or **Red** from the editor context submenu, with matching highlighter icons. Both colors can coexist in a block.
- Keep highlights attached to identifiable text after insertions before it. Ambiguous or changed targets are hidden rather than guessed.
- Store exact-text highlights in local plugin data, keeping the entire Markdown note unchanged. Editing or deleting a highlighted target in the editor removes its local anchor; Undo restores it.
- Recolor and remove only the selected part, preserving the rest. Highlight actions support native Undo/Redo.
- Choose **Exact text** (the new default) or **Whole lines** in settings. Existing `hl:` highlights remain supported; original command IDs and hotkeys are preserved.
- Add a red-text command, commands for clearing text highlights, and a backed-up migration command for earlier local `ht:` metadata.
- Bound note and database processing, coalesce saves, and preserve corrupt or unknown storage formats in read-only mode.

### Updating from 0.1.1

Use Obsidian's **Check for updates** action for community plugins, then update this plugin. Existing whole-line highlights remain visible. Select **Whole lines** in the plugin settings if you want the original commands to continue affecting complete lines.

Exact-text highlights belong to the note path in the plugin's `data.json`; copying Markdown to another note does not copy them. Back up plugin data along with notes and avoid uninstalling the plugin as an update method.

### Validation

Production build, TypeScript, ESLint and 108 Vitest tests passed. Desktop checks in Obsidian 1.13.7 covered both views, context-menu colors, partial recoloring/removal, settings intensity, Undo/Redo and reload persistence. Mobile, other themes and long-duration application stress were not manually verified.

## 0.1.1

- Fix Reading view highlights and compatibility with older Obsidian desktop versions.
