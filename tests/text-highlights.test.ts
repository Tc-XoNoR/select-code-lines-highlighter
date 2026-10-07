import { describe, expect, it } from "vitest";
import { createAnchor, decodePayload, encodePayload, planTextUpdate, readTextHighlights, resolveAnchor, resolvedTextRanges } from "../src/text-highlights";

const fixture = (text = "before CIAO after") => ["intro", "```text", ...text.split("\n"), "```", "outro"];
function add(lines: string[], from = { line: 2, ch: 7 }, to = { line: 2, ch: 11 }) {
	const plan = planTextUpdate(lines, from, to, "add");
	expect(plan.ok).toBe(true);
	if (!plan.ok) throw new Error(plan.reason);
	const updated = [...lines]; updated[plan.line] = plan.replacement;
	return updated;
}

describe("text anchor identity", () => {
	it("follows the selected word after preceding text and lines are inserted", () => {
		const content = "before CIAO after";
		const anchor = createAnchor(content, { from: 7, to: 11 });
		for (const modified of ["prefix " + content, "new line\n" + content, "before inserted CIAO after"]) {
			expect(resolveAnchor(modified, anchor)).toEqual({ from: modified.indexOf("CIAO"), to: modified.indexOf("CIAO") + 4 });
		}
	});
	it("keeps the chosen repeated occurrence when context distinguishes it", () => {
		const text = "left CIAO right\nsecond CIAO end";
		const a = createAnchor(text, { from: 23, to: 27 });
		expect(a.text).toBe("CIAO");
		expect(resolveAnchor("prefix " + text, a)).toEqual({ from: 30, to: 34 });
	});
	it("does not relocate a deleted target onto a surviving duplicate", () => {
		const text = "CIAO one CIAO";
		const a = createAnchor(text, { from: 0, to: 4 });
		expect(resolveAnchor("HELLO one CIAO", a)).toBeNull();
	});
	it("does not use ordinal to guess between identical contexts", () => {
		const unit = "x".repeat(32) + "CIAO" + "y".repeat(32);
		const a = createAnchor(unit + unit, { from: 32, to: 36 });
		expect(resolveAnchor(unit + unit, a)).toBeNull();
	});
	it("rejects edited targets and fully changed contexts", () => {
		const a = createAnchor("before CIAO after", { from: 7, to: 11 });
		expect(resolveAnchor("before CIxAO after", a)).toBeNull();
		expect(resolveAnchor("different CIAO context", a)).toBeNull();
	});
	it("stores 32 Unicode code points of context and roundtrips Unicode", () => {
		const a = createAnchor("😀".repeat(40) + "caffè 日本", { from: 80, to: 88 });
		expect(Array.from(a.before)).toHaveLength(32);
		const p = { version: 1 as const, anchors: [a] };
		expect(decodePayload(encodePayload(p))).toEqual(p);
	});
});

describe("metadata validation", () => {
	it.each(["!", "=", "a", "_w", "e30", "eyJ2ZXJzaW9uIjoyLCJhbmNob3JzIjpbXX0"])("rejects malformed/unknown payload %s", value => {
		expect(decodePayload(value)).toBeNull();
	});
	it("rejects unsafe anchor shapes, empty text and excessive limits", () => {
		const a = createAnchor("hello", { from: 0, to: 5 });
		for (const bad of [{ ...a, ordinal: -1 }, { ...a, count: 0 }, { ...a, text: "" }, { ...a, text: "x".repeat(4097) }, { ...a, before: "x".repeat(33) }]) {
			const spec = btoa(JSON.stringify({ version: 1, anchors: [bad] })).replace(/=+$/, "");
			expect(decodePayload(spec)).toBeNull();
		}
		expect(() => encodePayload({ version: 1, anchors: Array.from({ length: 257 }, () => a) })).toThrow();
		expect(() => encodePayload({ version: 1, anchors: Array.from({ length: 30 }, () => ({ ...a, text: "x".repeat(4096) })) })).toThrow();
		expect(decodePayload("x".repeat(90000))).toBeNull();
	});
	it("ignores quoted metadata and rejects multiple autonomous ht tokens", () => {
		expect(readTextHighlights('```text title="ht:nope"', 3)).toEqual({ version: 1, anchors: [] });
		expect(readTextHighlights('```text ht:nope ht:nope', 3)).toBeNull();
		expect(readTextHighlights('```text title="unfinished', 3)).toBeNull();
	});
});

describe("text editing plans", () => {
	it("changes only opening fence and preserves other tokens/whitespace", () => {
		const lines = fixture(); lines[1] = '```text title="ht:quoted" hl:1  ';
		const updated = add(lines);
		expect(updated[1]).toMatch(/^```text title="ht:quoted" hl:1 ht:[\w-]+ {2}$/);
		expect(updated.slice(2)).toEqual(lines.slice(2));
		expect(lines[1]).toBe('```text title="ht:quoted" hl:1  ');
	});
	it("supports reversed, partial multiline and column zero selections", () => {
		const lines = fixture("one CIAO\nnext line\nlast");
		const updated = add(lines, { line: 4, ch: 0 }, { line: 2, ch: 4 });
		const p = readTextHighlights(updated[1], 3);
		expect(p?.anchors[0].text).toBe("CIAO\nnext line\n");
	});
	it.each(["\n", "\r\n"])("supports documents normalized from %j", eol => {
		const lines = fixture().join(eol).split(/\r?\n/);
		expect(readTextHighlights(add(lines)[1], 3)?.anchors[0].text).toBe("CIAO");
	});
	it.each(["~~~", "`````", "   ```"])("supports fence %s", fence => {
		const lines = [fence + "text", "CIAO", fence];
		const p = planTextUpdate(lines, { line: 1, ch: 0 }, { line: 1, ch: 4 }, "add");
		expect(p.ok).toBe(true);
	});
	it("deduplicates and makes repeated addition a no-op", () => {
		const lines = add(fixture());
		expect(planTextUpdate(lines, { line: 2, ch: 7 }, { line: 2, ch: 11 }, "add")).toMatchObject({ ok: true, changed: false });
	});
	it("merges overlap, splits removal, and removes the last token cleanly", () => {
		let lines = add(fixture(), { line: 2, ch: 7 }, { line: 2, ch: 10 });
		lines = add(lines, { line: 2, ch: 9 }, { line: 2, ch: 11 });
		const split = planTextUpdate(lines, { line: 2, ch: 8 }, { line: 2, ch: 10 }, "remove");
		if (!split.ok) throw new Error("split");
		expect(readTextHighlights(split.replacement, 3)?.anchors.map(a => a.text)).toEqual(["C", "O"]);
		lines[1] = split.replacement;
		const removed = planTextUpdate(lines, { line: 2, ch: 7 }, { line: 2, ch: 11 }, "remove");
		expect(removed).toMatchObject({ ok: true, replacement: "```text" });
	});
	it("keeps unresolved anchors during editing and clears them explicitly", () => {
		const lines = add(fixture()); lines[2] = "before HELLO after";
		expect(resolvedTextRanges(lines[2], readTextHighlights(lines[1], 3))).toEqual([]);
		const newLines = add(lines, { line: 2, ch: 7 }, { line: 2, ch: 12 });
		expect(readTextHighlights(newLines[1], 3)?.anchors).toHaveLength(2);
		expect(planTextUpdate(newLines, { line: 2, ch: 0 }, { line: 2, ch: 0 }, "clear")).toMatchObject({ ok: true, replacement: "```text" });
	});
	it("refuses fences, outside selections, invalid positions and invalid metadata", () => {
		for (const [a, h] of [[{ line: 0, ch: 0 }, { line: 2, ch: 3 }], [{ line: 1, ch: 1 }, { line: 2, ch: 1 }], [{ line: 2, ch: 100 }, { line: 2, ch: 101 }]]) {
			expect(planTextUpdate(fixture(), a, h, "add").ok).toBe(false);
		}
		for (const token of ["hl:bad", "ht:bad", "ht:x ht:y"]) {
			const lines = fixture(); lines[1] += " " + token;
			expect(planTextUpdate(lines, { line: 2, ch: 7 }, { line: 2, ch: 11 }, "add")).toMatchObject({ ok: false, reason: "invalid-metadata" });
		}
	});
	it("enforces selection bytes, and never changes an empty block or empty selection", () => {
		expect(planTextUpdate(fixture("é".repeat(2049)), { line: 2, ch: 0 }, { line: 2, ch: 2049 }, "add")).toMatchObject({ ok: false, reason: "limit" });
		expect(planTextUpdate(fixture(), { line: 2, ch: 0 }, { line: 2, ch: 0 }, "add").ok).toBe(false);
	});
});
