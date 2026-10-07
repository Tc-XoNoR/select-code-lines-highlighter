import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo, isolateHistory } from "@codemirror/commands";
import { changeHighlights, emptyHighlights, highlightState, loadHighlights, serializeHighlights, setHighlights } from "../src/local-highlights";
import { SaveQueue, validateNotes } from "../src/highlight-store";

const doc = "```text\nprima CIAO mondo\nseconda riga\n```";
const selected = { from: doc.indexOf("CIAO"), to: doc.indexOf("CIAO") + 4 };
function session() {
	const { field, history: effects } = highlightState(emptyHighlights);
	let state = EditorState.create({ doc, extensions: [field, effects, history()] });
	const dispatch = (tr: Transaction) => { state = tr.state; };
	return { field, get state() { return state; }, dispatch,
		apply(spec: TransactionSpec) { dispatch(state.update(spec)); } };
}

describe("local text highlights", () => {
	it("does not change a single source byte and supports add/remove Undo/Redo", () => {
		const s = session();
		const value = changeHighlights(doc, emptyHighlights(), selected, "add");
		s.apply({ effects: setHighlights.of(value), annotations: isolateHistory.of("full") });
		expect(s.state.doc.toString()).toBe(doc);
		expect(undo(s)).toBe(true);
		expect(s.state.field(s.field).ranges).toEqual([]);
		expect(redo(s)).toBe(true);
		expect(s.state.field(s.field).ranges).toEqual([selected]);
	});
	it("tracks insertions, removes deleted targets from persisted data, and restores them on Undo", () => {
		const s = session();
		s.apply({ effects: setHighlights.of(changeHighlights(doc, emptyHighlights(), selected, "add")), annotations: isolateHistory.of("full") });
		s.apply({ changes: { from: selected.from, insert: "NEW " }, annotations: isolateHistory.of("full") });
		expect(s.state.field(s.field).ranges[0].from).toBe(selected.from + 4);
		s.apply({ changes: { from: selected.from + 4, to: selected.to + 4 }, annotations: [isolateHistory.of("full"), Transaction.userEvent.of("delete.selection")] });
		expect(serializeHighlights(s.state.doc.toString(), s.state.field(s.field))).toEqual([]);
		undo(s);
		expect(s.state.doc.sliceString(s.state.field(s.field).ranges[0].from, s.state.field(s.field).ranges[0].to)).toBe("CIAO");
		redo(s);
		expect(s.state.field(s.field).ranges).toEqual([]);
	});
	it("supports split, restart, note isolation and conservative external edits", () => {
		const value = changeHighlights(doc, emptyHighlights(), selected, "add");
		expect(changeHighlights(doc, value, selected, "add")).toEqual(value);
		const split = changeHighlights(doc, value, { from: selected.from + 1, to: selected.to - 1 }, "remove");
		expect(split.ranges.map(r => doc.slice(r.from, r.to))).toEqual(["C", "O"]);
		const anchors = serializeHighlights(doc, value);
		expect(loadHighlights(doc, anchors).ranges).toEqual([selected]);
		expect(loadHighlights(doc, []).ranges).toEqual([]);
		expect(loadHighlights(doc.replace("CIAO", "BYE"), anchors).unresolved).toEqual(anchors);
		expect(changeHighlights(doc, value, selected, "clear").ranges).toEqual([]);
	});
	it("preserves unresolved records after external replacement instead of treating it as a user deletion", () => {
		const s = session();
		s.apply({ effects: setHighlights.of(changeHighlights(doc, emptyHighlights(), selected, "add")) });
		s.apply({ changes: { from: 0, to: doc.length, insert: doc.replace("CIAO", "BYE") }, annotations: Transaction.addToHistory.of(false) });
		expect(s.state.field(s.field).ranges).toEqual([]);
		expect(s.state.field(s.field).unresolved[0].text).toBe("CIAO");
	});
	it("stops rendering oversized notes and rejects ambiguous persistence", () => {
		const anchors = serializeHighlights(doc, changeHighlights(doc, emptyHighlights(), selected, "add"));
		expect(loadHighlights("x".repeat(1048577), anchors)).toEqual({ ranges: [], unresolved: anchors });
		const repeated = "```\n" + ("x".repeat(40) + "CIAO" + "y".repeat(40) + "\n").repeat(2) + "```";
		const from = repeated.indexOf("CIAO");
		expect(() => changeHighlights(repeated, emptyHighlights(), { from, to: from + 4 }, "add")).toThrow(/ambiguous/);
	});
	it("rejects oversized selections and non-code selections", () => {
		expect(() => changeHighlights(doc, emptyHighlights(), { from: 0, to: 5 }, "add")).toThrow();
		const large = "```\n" + "x".repeat(4097) + "\n```";
		expect(() => changeHighlights(large, emptyHighlights(), { from: 4, to: 4101 }, "add")).toThrow();
	});
	it("bounds malformed and unknown note records", () => {
		expect(() => validateNotes({ "a.md": [{ text: "broken" }] })).toThrow();
		expect(() => validateNotes({ "a.md": new Array(257).fill(serializeHighlights(doc, changeHighlights(doc, emptyHighlights(), selected, "add"))[0]) })).toThrow();
	});
	it("handles thousands of highlights across independent notes within the store budget", () => {
		const source = "```text\n" + Array.from({ length: 10 }, (_, i) => `item-${i} sample`).join("\n") + "\n```";
		const ranges = Array.from({ length: 10 }, (_, i) => { const from = source.indexOf(`item-${i}`); return { from, to: from + 6 }; });
		const anchors = serializeHighlights(source, { ranges, unresolved: [] });
		const records = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`note-${i}.md`, anchors]));
		expect(Object.keys(validateNotes(records))).toHaveLength(400);
		for (let i = 0; i < 400; i++) expect(loadHighlights(source, records[`note-${i}.md`]).ranges).toEqual(ranges);
		expect(() => validateNotes({ ...records, "extra.md": Array(100).fill(anchors[0]) })).toThrow();
	});
});

describe("serial storage", () => {
	it("never overlaps writes and drains an edit made during a pending save", async () => {
		let release!: () => void;
		let calls = 0;
		const queue = new SaveQueue(async () => { if (++calls === 1) await new Promise<void>(resolve => { release = resolve; }); }, () => {});
		queue.mark();
		const first = queue.flush();
		queue.mark();
		expect(queue.flush()).toBe(first);
		release();
		expect(await first).toBe(true);
		expect(calls).toBe(2);
	});
	it("coalesces queued writes and preserves dirty state after a failure", async () => {
		let count = 0;
		let failures = 0;
		const queue = new SaveQueue(async () => { count++; if (count === 1) throw new Error("disk full"); }, () => failures++);
		queue.mark(); queue.mark();
		expect(await queue.flush()).toBe(false);
		expect(failures).toBe(1);
		expect(await queue.flush()).toBe(true);
		expect(count).toBe(2);
		expect(await queue.flush()).toBe(true);
		expect(count).toBe(2);
	});
});
