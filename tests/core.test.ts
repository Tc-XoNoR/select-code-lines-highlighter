import { describe, expect, it } from "vitest";
import {
	addHighlightedLines,
	findEnclosingFence,
	findFenceBlocks,
	getSelectedLineRange,
	getHighlightedLineNumbers,
	isValidFenceSelection,
	matchRenderedFenceBlocks,
	parseHighlightSpec,
	planFenceLineUpdate,
	readFenceHighlightSpec,
	removeHighlightedLines,
	serializeHighlightSpec,
	updateFenceInfoString
} from "../src/core";

describe("highlight ranges", () => {
	it.each([
		["2,4-6", [{ start: 2, end: 2 }, { start: 4, end: 6 }]],
		["1-3,5,8-10", [{ start: 1, end: 3 }, { start: 5, end: 5 }, { start: 8, end: 10 }]],
		["3", [{ start: 3, end: 3 }]],
		["3-5", [{ start: 3, end: 5 }]],
		["5,1,3,2,2,4-6", [{ start: 1, end: 6 }]],
		["1-3,3-5,6-8", [{ start: 1, end: 8 }]]
	])("parses and normalizes %s", (spec, expected) => {
		expect(parseHighlightSpec(spec)).toEqual(expected);
	});

	it.each(["", "2,foo,4-6", "4-2", "0", "-1", "1,,2", "1-", "1.5", "9007199254740992"])(
		"rejects invalid spec %s", (spec) => expect(parseHighlightSpec(spec)).toBeNull()
	);

	it("serializes compact ranges", () => {
		expect(serializeHighlightSpec([
			{ start: 8, end: 10 }, { start: 1, end: 1 }, { start: 2, end: 3 }, { start: 5, end: 5 }
		])).toBe("1-3,5,8-10");
	});

	it("bridges ranges when adding", () => {
		expect(addHighlightedLines([{ start: 2, end: 2 }, { start: 5, end: 5 }], [{ start: 3, end: 4 }]))
			.toEqual([{ start: 2, end: 5 }]);
	});

	it("splits a range when removing its center", () => {
		expect(removeHighlightedLines([{ start: 2, end: 6 }], [{ start: 3, end: 4 }]))
			.toEqual([{ start: 2, end: 2 }, { start: 5, end: 6 }]);
	});

	it("removes a complete range", () => {
		expect(removeHighlightedLines([{ start: 2, end: 3 }], [{ start: 2, end: 3 }])).toEqual([]);
	});

	it("maps normalized ranges to existing content lines for rendering", () => {
		expect(getHighlightedLineNumbers([
			{ start: 6, end: 7 },
			{ start: 2, end: 3 },
			{ start: 3, end: 4 },
			{ start: 20, end: 30 }
		], 8)).toEqual([2, 3, 4, 6, 7]);
	});

	it("rejects an invalid content line count", () => {
		expect(() => getHighlightedLineNumbers([{ start: 1, end: 1 }], -1)).toThrow("Invalid content line count");
	});
});

describe("document update planning", () => {
	it("changes only the opening fence", () => {
		const original = ["before", "```text", "one", "two", "three", "```", "after"];
		const plan = planFenceLineUpdate(original, { start: 3, end: 4 }, "add");
		expect(plan).toEqual({ ok: true, changed: true, line: 1, replacement: "```text hl:2-3" });
		if (!plan.ok) return;
		const updated = [...original];
		updated[plan.line] = plan.replacement;
		expect(updated.slice(2)).toEqual(original.slice(2));
	});

	it("returns an error without a replacement for malformed metadata", () => {
		const original = ["```text hl:2,nope", "one", "two", "```"];
		expect(planFenceLineUpdate(original, { start: 1, end: 2 }, "add"))
			.toEqual({ ok: false, reason: "invalid-metadata" });
		expect(original).toEqual(["```text hl:2,nope", "one", "two", "```"]);
	});
});

describe("selection lines", () => {
	it("counts partial first and last lines", () => {
		expect(getSelectedLineRange({ line: 2, ch: 4 }, { line: 4, ch: 3 })).toEqual({ start: 2, end: 4 });
	});

	it("supports a reversed selection", () => {
		expect(getSelectedLineRange({ line: 4, ch: 3 }, { line: 2, ch: 4 })).toEqual({ start: 2, end: 4 });
	});

	it("excludes the next line at column zero", () => {
		expect(getSelectedLineRange({ line: 2, ch: 2 }, { line: 4, ch: 0 })).toEqual({ start: 2, end: 3 });
	});

	it("rejects an empty selection", () => {
		expect(getSelectedLineRange({ line: 2, ch: 2 }, { line: 2, ch: 2 })).toBeNull();
	});
});

describe("fenced blocks", () => {
	it("finds backtick, tilde, and longer fences without accepting a short close", () => {
		const lines = ["````text", "a", "```", "b", "````", "~~~bash", "c", "~~~"];
		expect(findFenceBlocks(lines)).toEqual([
			{ openingLine: 0, closingLine: 4, character: "`", length: 4, infoStart: 4 },
			{ openingLine: 5, closingLine: 7, character: "~", length: 3, infoStart: 3 }
		]);
	});

	it("ignores fence-like text in frontmatter and unclosed fences", () => {
		expect(findFenceBlocks(["---", "example: ```", "---", "```text", "body"])).toEqual([]);
	});

	it("maps absolute lines to one-based content lines", () => {
		const result = findEnclosingFence(["before", "```text", "one", "two", "three", "```"], { start: 3, end: 4 });
		expect(result).toMatchObject({ ok: true, selected: { start: 2, end: 3 } });
	});

	it("rejects a selection that touches a fence", () => {
		expect(findEnclosingFence(["```", "one", "```"], { start: 0, end: 1 })).toEqual({ ok: false, reason: "outside" });
	});

	it("reports a selection across two blocks", () => {
		const lines = ["```", "one", "```", "gap", "```", "two", "```"];
		expect(findEnclosingFence(lines, { start: 1, end: 5 })).toEqual({ ok: false, reason: "multiple" });
	});

	it("handles CRLF-derived lines", () => {
		const lines = "```text\r\none\r\ntwo\r\n```".split(/\r?\n/);
		expect(findEnclosingFence(lines, { start: 1, end: 2 })).toMatchObject({ ok: true, selected: { start: 1, end: 2 } });
	});

	it("rejects a fence nested under a list item", () => {
		expect(findFenceBlocks(["- item", "  ```text", "  code", "  ```"])).toEqual([]);
	});

	it("allows context actions only for content in one valid fenced block", () => {
		const lines = ["before", "```text hl:2", "one", "two", "```", "after"];
		expect(isValidFenceSelection(lines, { start: 2, end: 3 })).toBe(true);
		expect(isValidFenceSelection(lines, { start: 0, end: 0 })).toBe(false);
		expect(isValidFenceSelection(lines, { start: 1, end: 2 })).toBe(false);
	});

	it("hides context actions when existing highlight metadata is unsafe", () => {
		const lines = ["```text hl:2,nope", "one", "two", "```"];
		expect(isValidFenceSelection(lines, { start: 1, end: 2 })).toBe(false);
	});

	it("matches rendered code exactly when other section content is present", () => {
		const lines = ["intro", "```text hl:2", "one", "two", "```", "outro"];
		expect(matchRenderedFenceBlocks(lines, ["one\ntwo\n"]))
			.toMatchObject([{ openingLine: 1, closingLine: 4 }]);
	});

	it("falls back to fence order when Reading view normalizes code text", () => {
		const lines = ["```text hl:1", "one\tvalue", "```", "~~~bash hl:1", "two", "~~~"];
		expect(matchRenderedFenceBlocks(lines, ["one    value", "two"]))
			.toMatchObject([
				{ openingLine: 0, closingLine: 2 },
				{ openingLine: 3, closingLine: 5 }
			]);
	});

	it("does not use an ambiguous ordinal fallback", () => {
		const lines = ["```text hl:1", "one", "```", "~~~bash hl:1", "two", "~~~"];
		expect(matchRenderedFenceBlocks(lines, ["normalized text"])).toEqual([null]);
	});
});

describe("opening fence updates", () => {
	it("reads only an autonomous unquoted hl token", () => {
		expect(readFenceHighlightSpec('```text title="hl:9" hl:2,4-6', 3)).toEqual([
			{ start: 2, end: 2 }, { start: 4, end: 6 }
		]);
	});
	it("adds a new token while preserving language and whitespace", () => {
		expect(updateFenceInfoString("```text  ", 3, { start: 2, end: 3 }, "add"))
			.toEqual({ ok: true, line: "```text hl:2-3  ", changed: true });
	});

	it("merges an existing token without changing other metadata", () => {
		expect(updateFenceInfoString('```text title:"Nmap scan" hl:2,5', 3, { start: 3, end: 4 }, "add"))
			.toEqual({ ok: true, line: '```text title:"Nmap scan" hl:2-5', changed: true });
	});

	it("ignores hl-like text inside quotes", () => {
		expect(updateFenceInfoString('```text title:"hl:2 demo"', 3, { start: 4, end: 4 }, "add"))
			.toEqual({ ok: true, line: '```text title:"hl:2 demo" hl:4', changed: true });
	});

	it("removes selected lines and splits a range", () => {
		expect(updateFenceInfoString("```text hl:2-6", 3, { start: 3, end: 4 }, "remove"))
			.toEqual({ ok: true, line: "```text hl:2,5-6", changed: true });
	});

	it("removes an empty token cleanly", () => {
		expect(updateFenceInfoString("```text hl:2-3", 3, { start: 2, end: 3 }, "remove"))
			.toEqual({ ok: true, line: "```text", changed: true });
	});

	it("makes remove a no-op if no token exists", () => {
		expect(updateFenceInfoString("```text", 3, { start: 2, end: 3 }, "remove"))
			.toEqual({ ok: true, line: "```text", changed: false });
	});

	it.each(["```text hl:2,foo", "```text hl:2 hl:3", "```text hl:", '```text title="open hl:2'])("rejects unsafe metadata in %s", (line) => {
		expect(updateFenceInfoString(line, 3, { start: 1, end: 1 }, "add")).toEqual({ ok: false });
	});
});
