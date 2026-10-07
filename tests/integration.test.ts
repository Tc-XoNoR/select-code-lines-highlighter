import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { App, Editor, EditorSelection, EditorTransaction, PluginManifest, MarkdownPostProcessorContext, Menu, MenuItem } from "obsidian";
import { renderTextHighlights, TEXT_HIGHLIGHT_CLASS } from "../src/reading-text";
import { createAnchor, encodePayload } from "../src/text-highlights";

interface Harness {
	commands: Map<string, (editor: Editor) => void>; notices: string[]; data: unknown; saves: number;
	cleanup: (() => void)[]; post: null | ((element: HTMLElement, context: MarkdownPostProcessorContext) => void);
}
const harness = vi.hoisted((): Harness => ({ commands: new Map(), notices: [], data: null, saves: 0, cleanup: [], post: null }));
vi.mock("obsidian", () => ({
	Plugin: class {
		app = { workspace: { on: () => ({}) }, vault: { on: () => ({}) } };
		loadData() { return Promise.resolve(harness.data); }
		saveData() { harness.saves++; return Promise.resolve(); }
		addSettingTab() {} registerEditorExtension() {} registerEvent() {}
		registerMarkdownPostProcessor(callback: typeof harness.post) { harness.post = callback; }
		addCommand(c: { id: string; editorCallback: (editor: Editor) => void }) { harness.commands.set(c.id, c.editorCallback); }
	},
	PluginSettingTab: class {}, Setting: class {},
	MarkdownRenderChild: class { register(callback: () => void) { harness.cleanup.push(callback); } },
	Notice: class { constructor(text: string) { harness.notices.push(text); } }
}));
import Highlighter, { buildEditorDecorations, addColorMenu } from "../src/main";

function mockEditor(lines: string[], selections: EditorSelection[]) {
	const transactions: EditorTransaction[] = [];
	const editor = {
		lineCount: () => lines.length,
		getLine: (line: number) => lines[line],
		listSelections: () => selections,
		transaction: (transaction: EditorTransaction) => {
			transactions.push(transaction);
			for (const change of transaction.changes ?? []) {
				expect(change.from.line).toBe(0);
				expect(change.to?.line).toBe(0);
				lines[0] = change.text;
			}
		}
	} as unknown as Editor;
	return { editor, transactions };
}

describe("editor integration", () => {
	beforeEach(() => { harness.commands.clear(); harness.notices.length = 0; harness.data = null; harness.saves = 0; });
	async function plugin() {
		vi.stubGlobal("document", { body: { style: { setProperty: () => {} } } });
		const p = new Highlighter({} as App, {} as PluginManifest);
		await p.onload();
		p.settings.selectionMode = "lines";
		return p;
	}
	it("uses one opening-fence transaction, preserves reverse selection and performs no-op without a transaction", async () => {
		await plugin();
		const lines = ["```text", "before CIAO after", "```"];
		const selections = [{ anchor: { line: 1, ch: 11 }, head: { line: 1, ch: 7 } }];
		const { editor, transactions } = mockEditor(lines, selections);
		const add = harness.commands.get("highlight-selected-code-lines")!;
		add(editor);
		expect(transactions).toHaveLength(1);
		expect(transactions[0].selections).toEqual([{ from: selections[0].anchor, to: selections[0].head }]);
		expect(lines.slice(1)).toEqual(["before CIAO after", "```"]);
		add(editor);
		expect(transactions).toHaveLength(1);
		harness.commands.get("remove-highlight-from-selected-code-lines")!(editor);
		expect(lines[0]).toBe("```text");
		expect(transactions).toHaveLength(2);
	});
	it("keeps old IDs and refuses unsupported editors without changing source", async () => {
		const p = await plugin();
		const lines = ["```text", "CIAO", "```"];
		const selection = { anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 4 } };
		const { editor } = mockEditor(lines, [selection]);
		p.settings.selectionMode = "lines";
		harness.commands.get("highlight-selected-code-lines")!(editor);
		expect(lines[0]).toBe("```text hl:1");
		p.settings.selectionMode = "text";
		harness.commands.get("highlight-selected-code-lines")!(editor);
		expect(lines[0]).toBe("```text hl:1");
		selection.head.ch = 0;
		harness.commands.get("clear-text-highlights-in-current-code-block")!(editor);
		expect(lines[0]).toBe("```text hl:1");
	});
	it("leaves invalid documents identical and emits brief notices", async () => {
		await plugin();
		for (const lines of [["plain", "CIAO"], ["``` ht:bad", "CIAO", "```"], ["``` hl:bad", "CIAO", "```"], ["```", "CIAO"]]) {
			const original = [...lines];
			const { editor, transactions } = mockEditor(lines, [{ anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 4 } }]);
			harness.commands.get("highlight-selected-code-lines")!(editor);
			expect(transactions).toHaveLength(0);
			expect(lines).toEqual(original);
		}
		const selection = { anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 4 } };
		const { editor, transactions } = mockEditor(["```", "CIAO", "```"], [selection, selection]);
		harness.commands.get("highlight-selected-code-lines")!(editor);
		expect(transactions).toHaveLength(0);
		expect(harness.notices).toHaveLength(5);
	});
	it("builds sorted line and inline decorations for a multiline selection", () => {
		const content = "prefix CIAO\nnext end";
		const ht = encodePayload({ version: 1, anchors: [createAnchor(content, { from: 7, to: 16 })] });
		const state = EditorState.create({ doc: "```text hl:1 ht:" + ht + "\n" + content + "\n```" });
		const set = buildEditorDecorations({ state } as EditorView);
		const ranges: { from: number; to: number; name: string }[] = [];
		set.between(0, state.doc.length, (from, to, decoration) => {
			const spec = decoration.spec as { class?: string };
			ranges.push({ from, to, name: spec.class ?? "line" });
		});
		expect(ranges).toHaveLength(3);
		expect(ranges.filter(r => r.name === TEXT_HIGHLIGHT_CLASS).map(r => state.doc.sliceString(r.from, r.to))).toEqual(["CIAO", "next"]);
	});
	it("renders red and yellow inline ranges without overlapping decorations", () => {
		const state = EditorState.create({ doc: "```text\nCIAO\nworld\n```" });
		const ranges = [{ from: 8, to: 18 }, { from: 9, to: 15, color: "red" as const }];
		const set = buildEditorDecorations({ state } as EditorView, { ranges, unresolved: [] });
		const red: string[] = [];
		set.between(0, state.doc.length, (from, to, decoration) => {
			if ((decoration.spec as { class?: string }).class?.includes("critical")) red.push(state.doc.sliceString(from, to));
		});
		expect(red).toEqual(["IAO", "wo"]);
	});
	it("offers two submenu colors and falls back to flat choices on older hosts", () => {
		vi.stubGlobal("document", parseHTML("<html><body></body></html>").document);
		vi.stubGlobal("createFragment", () => document.createDocumentFragment());
		vi.stubGlobal("createSpan", () => document.createElement("span"));
		for (const nested of [true, false]) {
			const actions = new Map<string, () => void>();
			const makeMenu = (): Menu => ({ addItem(callback: (item: MenuItem) => void) {
				let title = "";
				const item = { setTitle(value: string | DocumentFragment) { title = typeof value === "string" ? value : value.firstChild?.textContent ?? ""; return item; }, setIcon() { return item; }, setSection() { return item; }, onClick(action: () => void) { actions.set(title, action); return item; }, ...(nested ? { setSubmenu: makeMenu } : {}) };
				callback(item as unknown as MenuItem);
			} }) as unknown as Menu;
			const choose = vi.fn();
			addColorMenu(makeMenu(), choose);
			expect(actions.size).toBe(2);
			for (const action of actions.values()) action();
			expect(choose.mock.calls).toEqual([["yellow"], ["red"]]);
		}
	});
	it("accepts version 2 and 3 stores and refuses unknown database versions", async () => {
		for (const version of [2, 3, 4]) {
			harness.notices.length = 0; harness.saves = 0;
			harness.data = { version, notes: {} };
			const p = await plugin();
			await p.saveSettings();
			expect(harness.saves).toBe(version === 4 ? 0 : 1);
			expect(harness.commands.has("highlight-critical-code-selection")).toBe(true);
		}
	});
	it("preserves corrupt storage and keeps commands from writing over it", async () => {
		harness.data = { version: 2, notes: { "bad.md": [{ text: "invalid" }] } };
		const p = await plugin();
		await p.saveSettings();
		expect(harness.saves).toBe(0);
		expect(harness.notices.some(n => n.includes("read-only"))).toBe(true);
	});
});

describe("Reading view DOM", () => {
	it("survives delayed syntax highlighting and repeated postprocessing without retaining duplicate observers", async () => {
		const { document, window } = parseHTML('<html><body><pre><code>CIAO world\n</code></pre></body></html>');
		vi.stubGlobal("document", document);
		vi.stubGlobal("MutationObserver", window.MutationObserver);
		const source = "```text\nCIAO world\n```";
		harness.data = { version: 2, notes: { "test.md": [createAnchor(source, { from: 8, to: 12 })] } };
		const p = new Highlighter({} as App, {} as PluginManifest);
		await p.onload();
		const code = document.querySelector("code")!;
		const context = { sourcePath: "test.md", getSectionInfo: () => ({ text: source, lineStart: 0, lineEnd: 2 }), addChild: () => {} } as unknown as MarkdownPostProcessorContext;
		harness.post!(code.parentElement!, context);
		harness.post!(code.parentElement!, context);
		const syntax = document.createElement("span");
		syntax.className = "token";
		syntax.textContent = "CIAO";
		code.replaceChildren(syntax, document.createTextNode(" world\n"));
		await vi.waitFor(() => expect(code.querySelectorAll(`.${TEXT_HIGHLIGHT_CLASS}`)).toHaveLength(1));
		expect(code.querySelector(".token")?.textContent).toBe("CIAO");
		for (const cleanup of harness.cleanup.splice(0)) cleanup();
	});
	it("wraps exact slices across syntax spans while preserving markup, text and repeatability", () => {
		const { document } = parseHTML('<pre><code><span class="token keyword">const</span> name = <span class="token string">"CIAO"</span>;\nsecond</code></pre>');
		const code = document.querySelector("code")!;
		const original = code.textContent;
		const ranges = [{ from: 3, to: original.indexOf("CIAO") + 4 }];
		expect(renderTextHighlights(code, original, ranges)).toBe(true);
		expect(code.textContent).toBe(original);
		expect(code.querySelectorAll(".token")).toHaveLength(2);
		const highlighted = () => Array.from(code.querySelectorAll(`.${TEXT_HIGHLIGHT_CLASS}`)).map(n => n.textContent).join("");
		expect(highlighted()).toBe(original.slice(ranges[0].from, ranges[0].to));
		renderTextHighlights(code, original, ranges);
		expect(highlighted()).toBe(original.slice(ranges[0].from, ranges[0].to));
		renderTextHighlights(code, original, []);
		expect(code.querySelectorAll(`.${TEXT_HIGHLIGHT_CLASS}`)).toHaveLength(0);
		expect(code.textContent).toBe(original);
	});
	it("rejects normalized/unmappable text and tolerates the renderer's extra final newline", () => {
		const { document } = parseHTML('<code>one    two</code>');
		const code = document.querySelector("code")!;
		expect(renderTextHighlights(code, "one\ttwo", [{ from: 4, to: 7 }])).toBe(false);
		expect(code.querySelectorAll("span")).toHaveLength(0);
		const fixture = "😀CIAO\n";
		code.textContent = fixture;
		expect(renderTextHighlights(code, "😀CIAO", [{ from: 2, to: 6 }])).toBe(true);
		expect(code.querySelector("span")?.textContent).toBe("CIAO");
	});
});
