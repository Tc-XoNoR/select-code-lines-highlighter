import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import {
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type Editor,
	type EditorPosition,
	type MarkdownPostProcessorContext,
	type Menu
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

type Mode = "add" | "remove";

export default class SelectCodeLinesHighlighterPlugin extends Plugin {
	settings: HighlighterSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
		this.applySettings();
		this.addSettingTab(new SelectCodeLinesHighlighterSettingTab(this.app, this));
		this.registerEditorExtension(this.createEditorHighlightExtension());
		this.registerMarkdownPostProcessor((element, context) => this.renderReadingHighlights(element, context));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
			this.addEditorMenuItems(menu, editor);
		}));

		this.addCommand({
			id: "highlight-selected-code-lines",
			name: "Highlight selected code lines",
			editorCallback: (editor) => this.updateHighlight(editor, "add")
		});

		this.addCommand({
			id: "remove-highlight-from-selected-code-lines",
			name: "Remove highlight from selected code lines",
			editorCallback: (editor) => this.updateHighlight(editor, "remove")
		});
	}

	onunload(): void {
		for (const property of [
			"--select-code-lines-highlight-color",
			"--select-code-lines-highlight-opacity",
			"--select-code-lines-accent-color",
			"--select-code-lines-accent-width"
		]) document.body.style.removeProperty(property);
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
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

		menu.addItem((item) => item
			.setTitle("Highlight selected code lines")
			.setIcon("highlighter")
			.setSection("select-code-lines-highlighter")
			.onClick(() => this.updateHighlight(editor, "add")));
		menu.addItem((item) => item
			.setTitle("Remove highlight from selected code lines")
			.setIcon("eraser")
			.setSection("select-code-lines-highlighter")
			.onClick(() => this.updateHighlight(editor, "remove")));
	}

	private createEditorHighlightExtension(): Extension {
		return ViewPlugin.fromClass(class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildEditorDecorations(view);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildEditorDecorations(update.view);
				}
			}
		}, {
			decorations: (value) => value.decorations
		});
	}

	private renderReadingHighlights(element: HTMLElement, context: MarkdownPostProcessorContext): void {
		const section = context.getSectionInfo(element);
		if (!section) return;
		const sourceLines = section.text.split(/\r?\n/);
		const codeElements = this.findRenderedCodeElements(element);
		const matchedBlocks = matchRenderedFenceBlocks(
			sourceLines,
			codeElements.map((code) => code.textContent ?? "")
		);

		for (const [index, codeElement] of codeElements.entries()) {
			const block = matchedBlocks[index];
			if (!block) continue;
			const ranges = readFenceHighlightSpec(sourceLines[block.openingLine], block.infoStart);
			if (!ranges?.length) continue;

			const pre = codeElement.parentElement;
			if (!pre) continue;
			pre.classList.add("select-code-lines-highlighter-reading");
			const contentLayer = document.createElement("span");
			contentLayer.className = "select-code-lines-highlighter-reading-content";
			while (codeElement.firstChild) contentLayer.appendChild(codeElement.firstChild);
			codeElement.appendChild(contentLayer);

			const contentLineCount = block.closingLine - block.openingLine - 1;
			const highlightedLines = new Set(getHighlightedLineNumbers(ranges, contentLineCount));
			const markerLayer = document.createElement("span");
			markerLayer.className = "select-code-lines-highlighter-reading-lines";
			for (let line = 1; line <= contentLineCount; line += 1) {
				const marker = document.createElement("span");
				marker.className = "select-code-lines-highlighter-reading-line";
				marker.setAttribute("aria-hidden", "true");
				if (highlightedLines.has(line)) marker.classList.add("is-highlighted");
				markerLayer.appendChild(marker);
			}
			codeElement.appendChild(markerLayer);
		}
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
		const update = planFenceLineUpdate(lines, selectedLines, mode);
		if (!update.ok) {
			new Notice(update.reason === "multiple"
				? "Selection spans multiple code blocks."
				: update.reason === "invalid-metadata"
					? "Unable to safely parse existing hl metadata."
					: "Selection is not inside a fenced code block.");
			return;
		}
		if (!update.changed) return;

		const line = update.line;
		const openingLine = lines[line];
		editor.transaction({
			changes: [{
				from: { line, ch: 0 },
				to: { line, ch: openingLine.length },
				text: update.replacement
			}]
		});
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
		containerEl.createEl("h2", { text: "Select Code Lines Highlighter" });

		new Setting(containerEl)
			.setName("Highlight color")
			.setDesc("Background color applied to highlighted code lines.")
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
				.setDisplayFormat((value) => `${value}%`)
				.setInstant(true)
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
				.setDisplayFormat((value) => `${value}px`)
				.setInstant(true)
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

function buildEditorDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const sourceLines = view.state.doc.toString().split("\n");
	for (const block of findFenceBlocks(sourceLines)) {
		const ranges = readFenceHighlightSpec(sourceLines[block.openingLine], block.infoStart);
		if (!ranges) continue;
		const contentLineCount = block.closingLine - block.openingLine - 1;
		for (const relativeLine of getHighlightedLineNumbers(ranges, contentLineCount)) {
			const documentLine = view.state.doc.line(block.openingLine + relativeLine + 1);
			builder.add(documentLine.from, documentLine.from, Decoration.line({
				attributes: { class: "select-code-lines-highlighter-editor-line" }
			}));
		}
	}
	return builder.finish();
}
