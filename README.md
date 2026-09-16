# Select Code Lines Highlighter

Select Code Lines Highlighter is a self-contained Obsidian plugin that turns a mouse selection inside a fenced Markdown code block into a visible line highlight. It stores the selection as `hl:` metadata and never changes the code itself.

It is useful for terminal output, Nmap scans, logs, stack traces, configuration snippets, and other blocks where copying or rewriting content just to emphasize a few lines is undesirable.

> [!IMPORTANT]
> Version 0.1.0 is the initial release and is being prepared for submission to the official Obsidian Community Plugins directory.

## Features

- Add selected code lines to an `hl:` specification.
- Remove selected lines from an existing specification.
- Access both actions from the editor context menu when the selection is inside a supported code block.
- Merge, sort, deduplicate, split, and compact line ranges automatically.
- Preserve the language identifier, unrelated metadata, whitespace, and all code-block content.
- Render highlighted lines directly in the editor and Reading view, without another plugin.
- Provide its own full-line background layer without Codeblock Customizer, Code Styler, themes, or external CSS snippets.
- Configure highlight color, intensity, accent color, and accent width from the native plugin settings.
- Support backtick and tilde fences, including fences longer than three characters.
- Refuse ambiguous selections or malformed `hl:` metadata without modifying the note.

## Usage

Given this block:

````markdown
```text
PORT      STATE SERVICE
22/tcp    open  ssh
80/tcp    open  http
445/tcp   open  microsoft-ds
```
````

Select the last two lines and run **Highlight selected code lines**. The result is:

````markdown
```text hl:3-4
PORT      STATE SERVICE
22/tcp    open  ssh
80/tcp    open  http
445/tcp   open  microsoft-ds
```
````

Only the opening fence changes. Run **Remove highlight from selected code lines** to subtract selected lines from the existing `hl:` value.

You can also right-click a selection inside a supported fenced code block. The context menu shows **Highlight selected code lines** and **Remove highlight from selected code lines** only when the selection can be handled safely. The entries stay hidden for normal note text, selections that touch a fence, unsupported nested blocks, multiple selections, and malformed `hl:` metadata.

To assign a shortcut, open **Settings → Hotkeys**, search for **Highlight selected code lines**, and choose your preferred key combination. You can assign a second shortcut to the removal command.

## Settings

Open **Settings → Community plugins → Select Code Lines Highlighter → Options** to configure the highlight color and intensity, plus the color and width of the accent marker. Changes apply immediately in the editor and Reading view. Use **Restore defaults** to return to the original appearance.

## Rendering

The plugin includes its own renderer for the editor and Reading view. It does not require Codeblock Customizer, Code Styler, or a special theme. The portable `hl:` metadata remains compatible with other tools that understand the same syntax.

## Manual installation

Requires Obsidian 1.13.0 or later.

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create `<your-vault>/.obsidian/plugins/select-code-lines-highlighter/`.
3. Copy all three files into that directory.
4. Reload Obsidian if it is already open.
5. Open **Settings → Community plugins → Installed plugins** and enable **Select Code Lines Highlighter**.

## Limitations

- A selection must be non-empty, continuous, and wholly inside the content of one fenced code block.
- Version 0.1 targets top-level fenced blocks. Nested blocks in lists, block quotes, or callouts are not supported.
- Existing `hl:` values must contain only positive safe integers and ascending ranges such as `2,4-6`.
- Multiple selections, unclosed fences, multiple `hl:` tokens, and malformed metadata are rejected.
- Soft-wrapped visual lines retain one highlight for the logical Markdown line.

## Development

Requires Node.js 18 or later and pnpm.

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

The production bundle is written to `main.js`. The source structure and build configuration follow the current official Obsidian sample plugin conventions.

## Privacy and security

The plugin runs locally. It contains no telemetry, analytics, network requests, or data collection. It modifies only the opening fence of the code block targeted by the active editor selection.

## License

[MIT](LICENSE)
