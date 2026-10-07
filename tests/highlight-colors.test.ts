import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory, undo, redo } from "@codemirror/commands";
import { parseHTML } from "linkedom";
import { changeHighlights, emptyHighlights, highlightState, loadHighlights, serializeHighlights, setHighlights } from "../src/local-highlights";
import { mergeColoredRanges } from "../src/highlight-colors";
import { createAnchor, decodePayload, encodePayload, type TextAnchor } from "../src/text-highlights";
import { renderTextHighlights } from "../src/reading-text";

const doc = "```text\nprima CIAO mondo\nseconda riga\n```";
const selected = { from: doc.indexOf("CIAO"), to: doc.indexOf("CIAO") + 4 };

describe("per-highlight colors", () => {
	it("repaints only the overlap and merges only equal colors", () => {
		const yellow = changeHighlights(doc, emptyHighlights(), selected, "add");
		const middle = { from: selected.from + 1, to: selected.to - 1 };
		const red = changeHighlights(doc, yellow, middle, "add", "red");
		expect(red.ranges).toEqual([{ from: selected.from, to: middle.from }, { ...middle, color: "red" }, { from: middle.to, to: selected.to }]);
		expect(changeHighlights(doc, red, middle, "add", "red")).toEqual(red);
		expect(changeHighlights(doc, red, middle, "add", "yellow")).toEqual(yellow);
	});
	it("preserves red on partial removal, restart, insertion and unresolved anchors", () => {
		const red = changeHighlights(doc, emptyHighlights(), selected, "add", "red");
		const split = changeHighlights(doc, red, { from: selected.from + 1, to: selected.to - 1 }, "remove");
		expect(split.ranges.map(r => [doc.slice(r.from, r.to), r.color])).toEqual([["C", "red"], ["O", "red"]]);
		const anchors = serializeHighlights(doc, split);
		expect(loadHighlights(doc, anchors)).toEqual(split);
		const full = serializeHighlights(doc, red);
		expect(loadHighlights("prefix\n" + doc, full).ranges).toEqual([{ from: selected.from + 7, to: selected.to + 7, color: "red" }]);
		expect(loadHighlights(doc.replace("CIAO", "BYE"), full).unresolved[0].color).toBe("red");
		expect(changeHighlights(doc, red, selected, "clear").ranges).toEqual([]);
	});
	it("loads old anchors as yellow and rejects unknown colors", () => {
		const anchor = createAnchor(doc, selected);
		expect(loadHighlights(doc, [anchor]).ranges).toEqual([selected]);
		for (const color of ["red", "yellow"] as const) expect(decodePayload(encodePayload({ version: 1, anchors: [{ ...anchor, color }] }))?.anchors[0].color).toBe(color);
		const bad = { ...anchor, color: "blue" } as unknown as TextAnchor;
		expect(() => encodePayload({ version: 1, anchors: [bad] })).toThrow();
		expect(decodePayload(btoa(JSON.stringify({ version: 1, anchors: [bad] })).replace(/=+$/, ""))).toBeNull();
	});
	it("restores colors through recolor, deletion, Undo and Redo without source edits", () => {
		const { field, history: effects } = highlightState(emptyHighlights);
		let state = EditorState.create({ doc, extensions: [field, effects, history()] });
		const dispatch = (tr: Transaction) => { state = tr.state; };
		const session = { get state() { return state; }, dispatch };
		for (const color of ["yellow", "red"] as const) dispatch(state.update({ effects: setHighlights.of(changeHighlights(doc, state.field(field), selected, "add", color)), annotations: isolateHistory.of("full") }));
		expect(state.doc.toString()).toBe(doc);
		undo(session); expect(state.field(field).ranges).toEqual([selected]);
		redo(session); expect(state.field(field).ranges[0].color).toBe("red");
		dispatch(state.update({ changes: { from: selected.from, insert: "NEW " }, annotations: [Transaction.userEvent.of("input"), isolateHistory.of("full")] }));
		expect(state.field(field).ranges[0]).toEqual({ from: selected.from + 4, to: selected.to + 4, color: "red" });
		dispatch(state.update({ changes: { from: selected.from + 4, to: selected.to + 4 }, annotations: [Transaction.userEvent.of("delete"), isolateHistory.of("full")] }));
		expect(serializeHighlights(state.doc.toString(), state.field(field))).toEqual([]);
		undo(session); expect(state.field(field).ranges[0].color).toBe("red");
	});
	it("wraps both colors across syntax nodes, Unicode and newlines without changing text", () => {
		const { document } = parseHTML('<code>😀<span class="token">CIAO</span>\nworld</code>');
		const code = document.querySelector("code")!;
		const source = code.textContent;
		const ranges = [{ from: 0, to: source.length }, { from: 3, to: 9, color: "red" as const }];
		for (let i = 0; i < 2; i++) {
			expect(renderTextHighlights(code, source, ranges)).toBe(true);
			expect(code.textContent).toBe(source);
			expect(code.querySelectorAll(".token")).toHaveLength(1);
			expect(Array.from(code.querySelectorAll(".select-code-lines-highlighter-critical")).map(n => n.textContent).join("")).toBe(source.slice(3, 9));
		}
	});
	it("keeps a bounded alternating-color set stable under repeated normalization", () => {
		const ranges = Array.from({ length: 256 }, (_, i) => ({ from: i * 2, to: i * 2 + 1, ...(i % 2 ? { color: "red" as const } : {}) }));
		expect(mergeColoredRanges(mergeColoredRanges(ranges))).toEqual(ranges);
	});
});
