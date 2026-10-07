import { Annotation, Transaction, type Range, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import {
	editorInfoField,
	MarkdownRenderChild,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type Editor,
	type EditorPosition,
	type MarkdownPostProcessorContext,
	type Menu,
	type MenuItem
} from "obsidian";
import {
	findFenceBlocks,
	getSelectedLineRange,
	getHighlightedLineNumbers,
	isValidFenceSelection,
	matchRenderedFenceBlocks,
	planFenceLineUpdate,
	readFenceHighlightSpec,
} from "./core";
import { DEFAULT_SETTINGS, normalizeSettings, type HighlighterSettings } from "./settings";
import { planTextUpdate, readTextHighlights, resolvedTextRanges, resolveAnchor, type HighlightColor } from "./text-highlights";
import { renderTextHighlights, textHighlightClass } from "./reading-text";
import { mergeColoredRanges } from "./highlight-colors";
import { changeHighlights, emptyHighlights, highlightState, loadHighlights, serializeHighlights, setHighlights, MAX_DOCUMENT, MAX_DOCUMENT_LINES, type LocalHighlights } from "./local-highlights";
import { SaveQueue, validateNotes, type NoteHighlights } from "./highlight-store";

type Mode = "add" | "remove";
const synchronized = Annotation.define<boolean>();

export default class SelectCodeLinesHighlighterPlugin extends Plugin {
	settings: HighlighterSettings = { ...DEFAULT_SETTINGS };
	private notes: NoteHighlights = Object.create(null) as NoteHighlights;
	private writable = true;
	private views = new Set<EditorView>();
	private pendingViews = new Set<EditorView>();
	private readers = new Set<() => void>();
	private codeObservers = new WeakMap<HTMLElement, () => void>();
	private readingCache = new Map<string, { source: string; anchors: unknown; value: LocalHighlights }>();
	private timer: number | null = null;
	private queue = new SaveQueue(async () => {
		if (!this.writable) throw new Error("Storage is read-only");
		await this.saveData({ version: 3, settings: this.settings, notes: this.notes });
	}, () => new Notice("Could not save highlights. Your notes are unchanged; retry before closing Obsidian."));
	private local = highlightState(state => {
		const path = state.field(editorInfoField, false)?.file?.path;
		return path ? loadHighlights(state.doc.toString(), this.notes[path] ?? []) : emptyHighlights();
	}, state => state.field(editorInfoField, false)?.file?.path ?? "");

	async onload(): Promise<void> {
		try {
			const data: unknown = await this.loadData();
			const stored = data as { version?: unknown; settings?: unknown; notes?: unknown } | null;
			if (stored?.version !== undefined) {
				if (stored.version !== 2 && stored.version !== 3) throw new Error("Unknown database version");
				this.notes = validateNotes(stored.notes);
				this.settings = normalizeSettings(stored.settings);
			} else this.settings = normalizeSettings(data);
		} catch {
			this.writable = false;
			new Notice("Highlight data could not be read. It has been preserved; local highlighting is read-only.");
		}
		this.applySettings();
		this.addSettingTab(new SelectCodeLinesHighlighterSettingTab(this.app, this));
		this.registerEditorExtension(this.createEditorHighlightExtension());
		this.registerMarkdownPostProcessor(
			(element, context) => this.renderReadingHighlights(element, context),
			1000
		);
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
			this.addEditorMenuItems(menu, editor);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			const moved = Object.entries(this.notes).filter(([path]) => path === oldPath || path.startsWith(oldPath + "/"));
			for (const [path, anchors] of moved) { delete this.notes[path]; this.notes[file.path + path.slice(oldPath.length)] = anchors; }
			if (moved.length) this.scheduleSave();
		}));
		this.registerEvent(this.app.vault.on("delete", file => {
			for (const path of Object.keys(this.notes)) if (path === file.path || path.startsWith(file.path + "/")) delete this.notes[path];
			this.scheduleSave();
		}));
		this.addCommand({ id: "clear-all-text-highlights-in-note", name: "Clear all local text highlights in current note", editorCallback: editor => {
			const view = this.findView(editor);
			if (view && this.writable) view.dispatch({ effects: setHighlights.of(emptyHighlights()), annotations: isolateHistory.of("full") });
		} });
		this.addCommand({ id: "migrate-text-highlights", name: "Move legacy text highlights to plugin storage in current note", editorCallback: editor => { void this.migrateLegacy(editor); } });

		this.addCommand({
			id: "highlight-selected-code-lines",
			name: "Highlight code selection",
			editorCallback: (editor) => this.updateHighlight(editor, "add")
		});

		this.addCommand({
			id: "highlight-critical-code-selection",
			name: "Highlight code selection as critical (red)",
			editorCallback: editor => this.updateLocal(editor, "add", "red")
		});
		this.addCommand({
			id: "remove-highlight-from-selected-code-lines",
			name: "Remove highlight from code selection",
			editorCallback: (editor) => this.updateHighlight(editor, "remove")
		});
		this.addCommand({
			id: "clear-text-highlights-in-current-code-block",
			name: "Clear text highlights in current code block",
			editorCallback: (editor) => this.clearTextHighlights(editor)
		});
	}

	onunload(): void {
		if (this.timer) window.clearTimeout(this.timer);
		this.flushViews();
		void this.queue.flush();
		this.views.clear();
		this.readers.clear();
		this.readingCache.clear();
		for (const property of [
			"--select-code-lines-highlight-color",
			"--select-code-lines-highlight-opacity",
			"--select-code-lines-accent-color",
			"--select-code-lines-accent-width"
		]) document.body.style.removeProperty(property);
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		this.queue.mark();
		await this.queue.flush();
		this.applySettings();
	}

	private applySettings(): void {
		const style = document.body.style;
		style.setProperty("--select-code-lines-highlight-color", this.settings.highlightColor);
		style.setProperty("--select-code-lines-highlight-opacity", `${this.settings.highlightOpacity}%`);
		style.setProperty("--select-code-lines-accent-color", this.settings.accentColor);
		style.setProperty("--select-code-lines-accent-width", `${this.settings.accentWidth}px`);
	}

	private addEditorMenuItems(menu: Menu, editor: Editor): void {
		const selectedLines = this.getSingleSelectedLineRange(editor);
		if (!selectedLines) return;
		const lines = this.readEditorLines(editor);
		if (!isValidFenceSelection(lines, selectedLines)) return;
		const selection = editor.listSelections()[0];
		const textPlan = planTextUpdate(lines, selection.anchor, selection.head, "remove");
		if (!textPlan.ok && (this.settings.selectionMode === "text" || textPlan.reason === "invalid-metadata")) return;

		if (this.settings.selectionMode === "text") {
			addColorMenu(menu, color => this.updateLocal(editor, "add", color));
		} else {
			menu.addItem(item => item.setTitle("Highlight code selection").setIcon("highlighter")
				.setSection("select-code-lines-highlighter").onClick(() => this.updateHighlight(editor, "add")));
		}
		menu.addItem((item) => item
			.setTitle("Remove highlight from code selection")
			.setIcon("eraser")
			.setSection("select-code-lines-highlighter")
			.onClick(() => this.updateHighlight(editor, "remove")));
		menu.addItem(item => item
			.setTitle("Clear text highlights in current code block")
			.setIcon("eraser")
			.setSection("select-code-lines-highlighter")
			.onClick(() => this.clearTextHighlights(editor)));
	}

	private createEditorHighlightExtension(): Extension {
		// A CodeMirror ViewPlugin instance has its own `this`.
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- ViewPlugin owns a different instance.
		const plugin = this;
		return [this.local.field, this.local.history, ViewPlugin.fromClass(class {
			decorations: DecorationSet;

			constructor(private view: EditorView) {
				plugin.views.add(view);
				this.decorations = buildEditorDecorations(view, view.state.field(plugin.local.field));
			}
			destroy(): void { if (plugin.pendingViews.delete(this.view)) plugin.persistView(this.view); plugin.views.delete(this.view); }

			update(update: ViewUpdate): void {
				if (update.docChanged || update.startState.field(plugin.local.field) !== update.state.field(plugin.local.field)) {
					this.decorations = buildEditorDecorations(update.view, update.state.field(plugin.local.field));
					const authored = update.transactions.some(tr => !tr.annotation(synchronized) &&
						(tr.effects.some(effect => effect.is(setHighlights)) || ["input", "delete", "undo", "redo", "move"].some(event => tr.isUserEvent(event))));
					if (authored) {
						plugin.pendingViews.add(update.view);
						plugin.scheduleSave();
						queueMicrotask(() => plugin.synchronizeViews(update.view));
					}
				}
			}
		}, {
			decorations: (value) => value.decorations
		})];
	}

	private renderReadingHighlights(element: HTMLElement, context: MarkdownPostProcessorContext): void {
		this.flushViews();
		const section = context.getSectionInfo(element);
		if (!section) return;
		if (section.text.length > MAX_DOCUMENT) return;
		const sourceLines = section.text.split(/\r?\n/);
		if (sourceLines.length > MAX_DOCUMENT_LINES) return;
		const source = sourceLines.join("\n");
		const codeElements = this.findRenderedCodeElements(element);
		const matchedBlocks = matchRenderedFenceBlocks(
			sourceLines,
			codeElements.map((code) => code.textContent ?? ""),
			{ start: section.lineStart, end: section.lineEnd }
		);

		for (const [index, codeElement] of codeElements.entries()) {
			const block = matchedBlocks[index];
			if (!block) continue;
			const ranges = readFenceHighlightSpec(sourceLines[block.openingLine], block.infoStart);
			const content = sourceLines.slice(block.openingLine + 1, block.closingLine).join("\n");
			const offset = sourceLines.slice(0, block.openingLine + 1).reduce((n, line) => n + line.length + 1, 0);
			const legacy = resolvedTextRanges(content, readTextHighlights(sourceLines[block.openingLine], block.infoStart));
			// Syntax highlighting can replace text nodes after the postprocessor returns.
			// Observe only this code element and disconnect during our own DOM writes.
			const child = new MarkdownRenderChild(codeElement);
			this.codeObservers.get(codeElement)?.();
			let observer: MutationObserver | undefined;
			const render = () => {
				observer?.disconnect();
				const local = this.readingHighlights(context.sourcePath, source);
				const textRanges = [...legacy, ...local.ranges.filter(r => r.from >= offset && r.to <= offset + content.length)
					.map(r => ({ ...r, from: r.from - offset, to: r.to - offset }))];
				renderTextHighlights(codeElement, content, textRanges);
				observer?.observe(codeElement, { childList: true, subtree: true, characterData: true });
			};
			observer = new MutationObserver(render);
			this.readers.add(render);
			const dispose = () => { observer?.disconnect(); this.readers.delete(render); };
			this.codeObservers.set(codeElement, dispose);
			child.register(dispose);
			context.addChild(child);
			render();

			const pre = codeElement.parentElement;
			if (!pre) continue;
			pre.querySelector(":scope > .select-code-lines-highlighter-reading-lines")?.remove();
			pre.classList.toggle("select-code-lines-highlighter-reading", !!ranges?.length);
			if (!ranges?.length) continue;

			const contentLineCount = block.closingLine - block.openingLine - 1;
			const highlightedLines = new Set(getHighlightedLineNumbers(ranges, contentLineCount));
			const markerLayer = pre.createSpan();
			markerLayer.className = "select-code-lines-highlighter-reading-lines";
			for (let line = 1; line <= contentLineCount; line += 1) {
				const marker = markerLayer.createSpan();
				marker.className = "select-code-lines-highlighter-reading-line";
				marker.setAttribute("aria-hidden", "true");
				if (highlightedLines.has(line)) marker.classList.add("is-highlighted");
				markerLayer.appendChild(marker);
			}
		}
	}
	private readingHighlights(path: string, source: string): LocalHighlights {
		const anchors = this.notes[path];
		const cached = this.readingCache.get(path);
		if (cached?.source === source && cached.anchors === anchors) return cached.value;
		const value = loadHighlights(source, anchors ?? []);
		if (this.readingCache.size >= 8) this.readingCache.clear();
		this.readingCache.set(path, { source, anchors, value });
		return value;
	}

	private findRenderedCodeElements(element: HTMLElement): HTMLElement[] {
		const elements: HTMLElement[] = [];
		if (element.matches("pre > code")) elements.push(element);
		if (element.matches("pre")) {
			const directCode = element.querySelector<HTMLElement>(":scope > code");
			if (directCode) elements.push(directCode);
		}
		for (const code of Array.from(element.querySelectorAll<HTMLElement>("pre > code"))) {
			if (!elements.includes(code)) elements.push(code);
		}
		return elements;
	}

	private updateHighlight(editor: Editor, mode: Mode): void {
		if (this.settings.selectionMode === "text") { this.updateLocal(editor, mode); return; }
		const selections = editor.listSelections();
		if (selections.length !== 1) {
			new Notice("Multiple selections are not supported.");
			return;
		}

		const selection = selections[0];
		const selectedLines = getSelectedLineRange(
			this.toPosition(selection.anchor),
			this.toPosition(selection.head)
		);
		if (!selectedLines) {
			new Notice("No text selected.");
			return;
		}

		const lines = this.readEditorLines(editor);
		const textPlan = planTextUpdate(lines, selection.anchor, selection.head, mode);
		const update = !textPlan.ok && textPlan.reason === "invalid-metadata"
			? textPlan : planFenceLineUpdate(lines, selectedLines, mode);
		if (!update.ok) {
			new Notice(update.reason === "multiple"
				? "Selection spans multiple code blocks."
				: update.reason === "invalid-metadata"
					? "Unable to safely parse highlight metadata."
					: update.reason === "limit" ? "Text highlight limit exceeded (4 KiB per selection; 64 KiB per block)."
					: update.reason === "ambiguous" ? "Repeated text is ambiguous. Select more surrounding text."
					: "Selection is not inside a fenced code block.");
			return;
		}
		if (!update.changed) return;

		const line = update.line;
		const openingLine = lines[line];
		editor.transaction({
			selections: selections.map(s => ({ from: s.anchor, to: s.head })),
			changes: [{
				from: { line, ch: 0 },
				to: { line, ch: openingLine.length },
				text: update.replacement
			}]
		});
	}

	private clearTextHighlights(editor: Editor): void {
		this.updateLocal(editor, "clear");
	}

	private findView(editor: Editor): EditorView | undefined {
		return [...this.views].find(view => view.state.field(editorInfoField, false)?.editor === editor);
	}
	private synchronizeViews(source: EditorView): void {
		if (!this.views.has(source)) return;
		const path = source.state.field(editorInfoField, false)?.file?.path;
		const value = source.state.field(this.local.field);
		for (const peer of this.views) {
			if (peer === source || !path || peer.state.field(editorInfoField, false)?.file?.path !== path || !peer.state.doc.eq(source.state.doc)) continue;
			if (peer.state.field(this.local.field) === value) continue;
			peer.dispatch({ effects: setHighlights.of(value), annotations: [synchronized.of(true), Transaction.addToHistory.of(false)] });
		}
	}

	private updateLocal(editor: Editor, mode: "add" | "remove" | "clear", color: HighlightColor = "yellow"): void {
		if (!this.writable) { new Notice("Highlight storage is read-only. Existing data has been preserved."); return; }
		const view = this.findView(editor);
		if (!view) { new Notice("Open this note in the editor to highlight text."); return; }
		try {
			this.flushViews();
			if (view.state.selection.ranges.length !== 1) throw new Error("Multiple selections are not supported.");
			const selection = view.state.selection.main;
			const before = view.state.field(this.local.field);
			const after = changeHighlights(view.state.doc.toString(), before, { from: selection.from, to: selection.to }, mode, color);
			if (JSON.stringify(before) === JSON.stringify(after)) return;
			const path = view.state.field(editorInfoField).file?.path;
			if (!path) throw new Error("Save the note before highlighting.");
			validateNotes({ ...this.notes, [path]: serializeHighlights(view.state.doc.toString(), after) });
			view.dispatch({ effects: setHighlights.of(after), annotations: isolateHistory.of("full") });
		} catch (error) { new Notice(error instanceof Error ? error.message : "Could not apply highlight."); }
	}

	private persistView(view: EditorView): void {
		if (!this.writable) return;
		if (view.state.doc.length > MAX_DOCUMENT) return;
		const path = view.state.field(editorInfoField, false)?.file?.path;
		if (!path) return;
		if (!this.app.vault.getAbstractFileByPath(path)) return;
		try {
			const anchors = serializeHighlights(view.state.doc.toString(), view.state.field(this.local.field));
			validateNotes({ ...this.notes, [path]: anchors });
			if (anchors.length) this.notes[path] = anchors;
			else delete this.notes[path];
			this.queue.mark();
		} catch { new Notice("Highlight limits exceeded. Saved highlights were preserved."); }
	}
	private flushViews(): void {
		const changed = this.pendingViews.size > 0;
		for (const view of this.pendingViews) this.persistView(view);
		this.pendingViews.clear();
		if (changed) for (const render of this.readers) render();
	}

	private scheduleSave(): void {
		if (!this.writable) return;
		this.queue.mark();
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => { this.timer = null; this.flushViews(); void this.queue.flush(); }, 750);
	}

	private async migrateLegacy(editor: Editor): Promise<void> {
		this.flushViews();
		const view = this.findView(editor);
		const path = view?.state.field(editorInfoField).file?.path;
		if (!view || !path || !this.writable) return;
		const start = view.state;
		try {
			if (start.doc.length > MAX_DOCUMENT) throw new Error("Note exceeds the highlighting limit.");
			const lines = start.doc.toString().split("\n");
			const changes: { from: number; to: number; insert: string }[] = [];
			const imported = [];
			const backup = [];
			for (const block of findFenceBlocks(lines)) {
				const payload = readTextHighlights(lines[block.openingLine], block.infoStart);
				if (!payload) throw new Error("Malformed legacy metadata; migration cancelled.");
				if (!payload.anchors.length) continue;
				const content = lines.slice(block.openingLine + 1, block.closingLine).join("\n");
				const offset = start.doc.line(block.openingLine + 2).from;
				for (const anchor of payload.anchors) {
					const range = resolveAnchor(content, anchor);
					if (!range) throw new Error("Unresolved legacy highlight; migration cancelled without changing the note.");
					imported.push({ from: offset + range.from, to: offset + range.to });
				}
				const plan = planTextUpdate(lines, { line: block.openingLine + 1, ch: 0 }, { line: block.openingLine + 1, ch: 0 }, "clear");
				if (!plan.ok) throw new Error("Unsafe legacy fence; migration cancelled.");
				const line = start.doc.line(block.openingLine + 1);
				changes.push({ from: line.from, to: line.to, insert: plan.replacement });
				backup.push({ line: block.openingLine, opening: line.text });
			}
			if (!changes.length) { new Notice("No legacy text highlights in this note."); return; }
			const transaction = start.update({ changes });
			const before = start.field(this.local.field);
			const after: LocalHighlights = { unresolved: before.unresolved, ranges: mergeColoredRanges([...imported, ...before.ranges].map(r => ({
				...r, from: transaction.changes.mapPos(r.from, 1), to: transaction.changes.mapPos(r.to, -1)
			}))) };
			const anchors = serializeHighlights(transaction.newDoc.toString(), after);
			validateNotes({ ...this.notes, [path]: anchors });
			if (!this.manifest.dir) throw new Error("Plugin storage directory is unavailable.");
			await this.app.vault.adapter.write(`${this.manifest.dir}/migration-backup-${Date.now()}.json`, JSON.stringify({ path, backup }));
			this.notes[path] = anchors;
			this.queue.mark();
			if (!await this.queue.flush()) return;
			const verified = await this.loadData() as { notes?: NoteHighlights };
			if (JSON.stringify(verified.notes?.[path]) !== JSON.stringify(anchors)) throw new Error("Storage verification failed; note left unchanged.");
			if (!view.state.doc.eq(start.doc) || view.state.field(this.local.field) !== before || view.state.field(editorInfoField).file?.path !== path) throw new Error("Note changed during migration; retry. Legacy metadata was preserved.");
			view.dispatch({ changes, effects: setHighlights.of(after), annotations: isolateHistory.of("full") });
			new Notice("Legacy highlights backed up and moved to plugin storage.");
		} catch (error) { new Notice(error instanceof Error ? error.message : "Migration failed; legacy metadata preserved."); }
	}

	private getSingleSelectedLineRange(editor: Editor) {
		const selections = editor.listSelections();
		if (selections.length !== 1) return null;
		return getSelectedLineRange(
			this.toPosition(selections[0].anchor),
			this.toPosition(selections[0].head)
		);
	}

	private readEditorLines(editor: Editor): string[] {
		return Array.from({ length: editor.lineCount() }, (_, line) => editor.getLine(line));
	}

	private toPosition(position: EditorPosition): EditorPosition {
		return { line: position.line, ch: position.ch };
	}
}

class SelectCodeLinesHighlighterSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly highlighter: SelectCodeLinesHighlighterPlugin) {
		super(app, highlighter);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Highlight selection as")
			.setDesc("Choose what the highlight and removal commands affect. Existing highlights remain visible.")
			.addDropdown(dropdown => dropdown
				.addOption("text", "Exact text")
				.addOption("lines", "Whole lines")
				.setValue(this.highlighter.settings.selectionMode)
				.onChange(async value => {
					this.highlighter.settings.selectionMode = value === "lines" ? "lines" : "text";
					await this.highlighter.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Whole-line highlight color")
			.setDesc("Background for whole lines. Exact text uses yellow (important) or red (critical), chosen in the editor context menu.")
			.addColorPicker((picker) => picker
				.setValue(this.highlighter.settings.highlightColor)
				.onChange(async (value) => {
					this.highlighter.settings.highlightColor = value;
					await this.highlighter.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Highlight intensity")
			.setDesc("Opacity of the highlight background.")
			.addSlider((slider) => slider
				.setLimits(10, 80, 5)
				.setValue(this.highlighter.settings.highlightOpacity)
				.onChange(async (value) => {
					this.highlighter.settings.highlightOpacity = value;
					await this.highlighter.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Accent color")
			.setDesc("Color of the marker at the start of each highlighted line.")
			.addColorPicker((picker) => picker
				.setValue(this.highlighter.settings.accentColor)
				.onChange(async (value) => {
					this.highlighter.settings.accentColor = value;
					await this.highlighter.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Accent width")
			.setDesc("Width of the marker. Set it to zero to hide the marker.")
			.addSlider((slider) => slider
				.setLimits(0, 6, 1)
				.setValue(this.highlighter.settings.accentWidth)
				.onChange(async (value) => {
					this.highlighter.settings.accentWidth = value;
					await this.highlighter.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Restore defaults")
			.setDesc("Reset all visual options to their original values.")
			.addButton((button) => button
				.setButtonText("Restore")
				.onClick(async () => {
					this.highlighter.settings = { ...DEFAULT_SETTINGS };
					await this.highlighter.saveSettings();
					this.display();
				}));
	}
}

export function buildEditorDecorations(view: EditorView, local: LocalHighlights = emptyHighlights()): DecorationSet {
	const decorations: Range<Decoration>[] = [];
	if (view.state.doc.length > MAX_DOCUMENT || view.state.doc.lines > MAX_DOCUMENT_LINES) return Decoration.none;
	const sourceLines = view.state.doc.toString().split("\n");
	let blockOffset = 0;
	let offsetLine = 0;
	for (const block of findFenceBlocks(sourceLines)) {
		while (offsetLine <= block.openingLine) blockOffset += sourceLines[offsetLine++].length + 1;
		const ranges = readFenceHighlightSpec(sourceLines[block.openingLine], block.infoStart);
		const content = sourceLines.slice(block.openingLine + 1, block.closingLine).join("\n");
		const textRanges = mergeColoredRanges([...resolvedTextRanges(content, readTextHighlights(sourceLines[block.openingLine], block.infoStart)),
			...local.ranges.filter(r => r.from >= blockOffset && r.to <= blockOffset + content.length).map(r => ({ ...r, from: r.from - blockOffset, to: r.to - blockOffset }))]);
		let offset = 0;
		for (let line = block.openingLine + 1; line < block.closingLine; line++) {
			const documentLine = view.state.doc.line(line + 1);
			for (const range of textRanges) {
				const from = Math.max(range.from, offset);
				const to = Math.min(range.to, offset + documentLine.length);
				if (from < to) decorations.push(Decoration.mark({ class: textHighlightClass(range) }).range(documentLine.from + from - offset, documentLine.from + to - offset));
			}
			offset += documentLine.length + 1;
		}
		if (!ranges) continue;
		const contentLineCount = block.closingLine - block.openingLine - 1;
		for (const relativeLine of getHighlightedLineNumbers(ranges, contentLineCount)) {
			const documentLine = view.state.doc.line(block.openingLine + relativeLine + 1);
			decorations.push(Decoration.line({
				attributes: { class: "select-code-lines-highlighter-editor-line" }
			}).range(documentLine.from));
		}
	}
	return Decoration.set(decorations, true);
}

/** Obsidian's submenu hook is not in its public typings; older hosts get flat choices. */
export function addColorMenu(menu: Menu, choose: (color: HighlightColor) => void): void {
	const colorTitle = (color: HighlightColor, title: string): DocumentFragment => {
		const fragment = createFragment();
		const label = createSpan();
		label.className = `select-code-lines-menu-${color}`;
		label.textContent = title;
		fragment.appendChild(label);
		return fragment;
	};
	const addChoice = (target: Menu, color: HighlightColor, title: string) => target.addItem(item => item
		.setTitle(colorTitle(color, title)).setIcon("highlighter").setSection("select-code-lines-highlighter").onClick(() => choose(color)));
	let nested = false;
	menu.addItem(item => {
		const compatible = item as MenuItem & { setSubmenu?: () => Menu };
		if (typeof compatible.setSubmenu === "function") {
			item.setTitle("Highlight code selection").setIcon("highlighter").setSection("select-code-lines-highlighter");
			const submenu = compatible.setSubmenu();
			addChoice(submenu, "yellow", "Yellow");
			addChoice(submenu, "red", "Red");
			nested = true;
		} else {
			item.setTitle(colorTitle("yellow", "Highlight code selection: Yellow")).setIcon("highlighter")
				.setSection("select-code-lines-highlighter").onClick(() => choose("yellow"));
		}
	});
	if (!nested) addChoice(menu, "red", "Highlight code selection: Red");
}
