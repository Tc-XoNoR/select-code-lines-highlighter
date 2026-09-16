export interface LineRange {
	start: number;
	end: number;
}

export interface Position {
	line: number;
	ch: number;
}

export interface FenceBlock {
	openingLine: number;
	closingLine: number;
	character: "`" | "~";
	length: number;
	infoStart: number;
}

export type RenderedFenceMatch = FenceBlock | null;

export type FenceSelectionResult =
	| { ok: true; block: FenceBlock; selected: LineRange }
	| { ok: false; reason: "outside" | "multiple" };

export type FenceUpdateResult =
	| { ok: true; line: string; changed: boolean }
	| { ok: false };

export type PlannedFenceUpdate =
	| { ok: true; changed: boolean; line: number; replacement: string }
	| { ok: false; reason: "outside" | "multiple" | "invalid-metadata" };

function isSafePositiveInteger(value: string): boolean {
	if (!/^\d+$/.test(value)) return false;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0;
}

export function normalizeRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = ranges
		.map(({ start, end }) => ({ start, end }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const result: LineRange[] = [];

	for (const range of sorted) {
		if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start <= 0 || range.end < range.start) {
			throw new Error("Invalid line range");
		}
		const previous = result[result.length - 1];
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			result.push(range);
		}
	}
	return result;
}

export function parseHighlightSpec(spec: string): LineRange[] | null {
	if (spec.length === 0) return null;
	const ranges: LineRange[] = [];
	for (const part of spec.split(",")) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (!match || !isSafePositiveInteger(match[1])) return null;
		const start = Number(match[1]);
		const endText = match[2];
		if (endText !== undefined && !isSafePositiveInteger(endText)) return null;
		const end = endText === undefined ? start : Number(endText);
		if (end < start) return null;
		ranges.push({ start, end });
	}
	return normalizeRanges(ranges);
}

export function serializeHighlightSpec(ranges: readonly LineRange[]): string {
	return normalizeRanges(ranges)
		.map(({ start, end }) => start === end ? String(start) : `${start}-${end}`)
		.join(",");
}

export function getHighlightedLineNumbers(
	ranges: readonly LineRange[],
	contentLineCount: number
): number[] {
	if (!Number.isSafeInteger(contentLineCount) || contentLineCount < 0) {
		throw new Error("Invalid content line count");
	}
	const lines: number[] = [];
	for (const range of normalizeRanges(ranges)) {
		const lastLine = Math.min(range.end, contentLineCount);
		for (let line = range.start; line <= lastLine; line += 1) lines.push(line);
	}
	return lines;
}

export function addHighlightedLines(existing: readonly LineRange[], added: readonly LineRange[]): LineRange[] {
	return normalizeRanges([...existing, ...added]);
}

export function removeHighlightedLines(existing: readonly LineRange[], removed: readonly LineRange[]): LineRange[] {
	const subtractors = normalizeRanges(removed);
	const result: LineRange[] = [];

	for (const source of normalizeRanges(existing)) {
		let cursor = source.start;
		for (const removal of subtractors) {
			if (removal.end < cursor) continue;
			if (removal.start > source.end) break;
			if (removal.start > cursor) result.push({ start: cursor, end: removal.start - 1 });
			cursor = Math.max(cursor, removal.end + 1);
			if (cursor > source.end) break;
		}
		if (cursor <= source.end) result.push({ start: cursor, end: source.end });
	}
	return result;
}

function comparePosition(a: Position, b: Position): number {
	return a.line - b.line || a.ch - b.ch;
}

export function getSelectedLineRange(anchor: Position, head: Position): LineRange | null {
	if (comparePosition(anchor, head) === 0) return null;
	const from = comparePosition(anchor, head) < 0 ? anchor : head;
	const to = from === anchor ? head : anchor;
	const lastLine = to.ch === 0 ? to.line - 1 : to.line;
	if (lastLine < from.line) return null;
	return { start: from.line, end: lastLine };
}

function frontmatterEnd(lines: readonly string[]): number {
	if (lines[0]?.trim() !== "---") return -1;
	for (let index = 1; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();
		if (trimmed === "---" || trimmed === "...") return index;
	}
	return lines.length - 1;
}

export function findFenceBlocks(lines: readonly string[]): FenceBlock[] {
	const blocks: FenceBlock[] = [];
	const yamlEnd = frontmatterEnd(lines);
	let open: Omit<FenceBlock, "closingLine"> | null = null;

	for (let lineNumber = yamlEnd + 1; lineNumber < lines.length; lineNumber += 1) {
		const line = lines[lineNumber];
		if (!open) {
			const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
			if (!match) continue;
			if (isLikelyNestedInList(lines, lineNumber, match[1].length)) continue;
			const fence = match[2];
			const info = match[3];
			if (fence[0] === "`" && info.includes("`")) continue;
			open = {
				openingLine: lineNumber,
				character: fence[0] as "`" | "~",
				length: fence.length,
				infoStart: match[1].length + fence.length
			};
			continue;
		}

		const closing = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
		if (closing && closing[2][0] === open.character && closing[2].length >= open.length) {
			blocks.push({ ...open, closingLine: lineNumber });
			open = null;
		}
	}
	return blocks;
}

function normalizeRenderedCode(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

export function matchRenderedFenceBlocks(
	lines: readonly string[],
	renderedCode: readonly string[]
): RenderedFenceMatch[] {
	const blocks = findFenceBlocks(lines);
	const used = new Set<number>();
	const canUseOrdinalFallback = blocks.length === renderedCode.length;

	return renderedCode.map((text, renderedIndex) => {
		const normalized = normalizeRenderedCode(text);
		let blockIndex = blocks.findIndex((block, index) => !used.has(index)
			&& lines.slice(block.openingLine + 1, block.closingLine).join("\n") === normalized);
		if (blockIndex < 0 && canUseOrdinalFallback && !used.has(renderedIndex)) {
			blockIndex = renderedIndex;
		}
		if (blockIndex < 0) return null;
		used.add(blockIndex);
		return blocks[blockIndex];
	});
}

function isLikelyNestedInList(lines: readonly string[], lineNumber: number, fenceIndent: number): boolean {
	if (fenceIndent === 0) return false;
	for (let index = lineNumber - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line.trim().length === 0) continue;
		const listItem = /^( *)(?:[-+*]|\d+[.)])\s+/.exec(line);
		if (listItem) return listItem[1].length < fenceIndent;
		const indentation = /^( *)/.exec(line)?.[1].length ?? 0;
		if (indentation < fenceIndent) return false;
	}
	return false;
}

export function findEnclosingFence(
	lines: readonly string[],
	selectedAbsolute: LineRange
): FenceSelectionResult {
	const blocks = findFenceBlocks(lines);
	const containingStart = blocks.find((block) => selectedAbsolute.start > block.openingLine && selectedAbsolute.start < block.closingLine);
	const containingEnd = blocks.find((block) => selectedAbsolute.end > block.openingLine && selectedAbsolute.end < block.closingLine);

	if (containingStart && containingEnd && containingStart.openingLine !== containingEnd.openingLine) {
		return { ok: false, reason: "multiple" };
	}
	if (!containingStart || containingStart !== containingEnd) {
		const intersected = blocks.filter((block) => selectedAbsolute.start < block.closingLine && selectedAbsolute.end > block.openingLine);
		return { ok: false, reason: intersected.length > 1 ? "multiple" : "outside" };
	}
	return {
		ok: true,
		block: containingStart,
		selected: {
			start: selectedAbsolute.start - containingStart.openingLine,
			end: selectedAbsolute.end - containingStart.openingLine
		}
	};
}

export function isValidFenceSelection(
	lines: readonly string[],
	selectedAbsolute: LineRange
): boolean {
	const enclosure = findEnclosingFence(lines, selectedAbsolute);
	if (!enclosure.ok) return false;
	return readFenceHighlightSpec(
		lines[enclosure.block.openingLine],
		enclosure.block.infoStart
	) !== null;
}

interface HighlightToken {
	start: number;
	end: number;
	spec: string;
}

function findHighlightTokens(info: string): HighlightToken[] | null {
	const tokens: HighlightToken[] = [];
	let quote: "\"" | "'" | null = null;
	let escaped = false;

	for (let index = 0; index < info.length; index += 1) {
		const character = info[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			continue;
		}
		if ((index === 0 || /\s/.test(info[index - 1])) && info.startsWith("hl:", index)) {
			let end = index + 3;
			while (end < info.length && !/\s/.test(info[end])) end += 1;
			tokens.push({ start: index, end, spec: info.slice(index + 3, end) });
			index = end - 1;
		}
	}
	return quote ? null : tokens;
}

export function readFenceHighlightSpec(openingLine: string, infoStart: number): LineRange[] | null {
	const tokens = findHighlightTokens(openingLine.slice(infoStart));
	if (tokens === null) return null;
	if (tokens.length === 0) return [];
	if (tokens.length > 1) return null;
	return parseHighlightSpec(tokens[0].spec);
}

export function updateFenceInfoString(
	openingLine: string,
	infoStart: number,
	selected: LineRange,
	mode: "add" | "remove"
): FenceUpdateResult {
	const info = openingLine.slice(infoStart);
	const tokens = findHighlightTokens(info);
	if (tokens === null) return { ok: false };
	if (tokens.length > 1) return { ok: false };
	const token = tokens[0];
	const existing = token ? parseHighlightSpec(token.spec) : [];
	if (existing === null) return { ok: false };
	const updated = mode === "add"
		? addHighlightedLines(existing, [selected])
		: removeHighlightedLines(existing, [selected]);
	const newSpec = serializeHighlightSpec(updated);
	let newInfo: string;

	if (token) {
		if (newSpec) {
			newInfo = `${info.slice(0, token.start)}hl:${newSpec}${info.slice(token.end)}`;
		} else {
			let removeStart = token.start;
			let removeEnd = token.end;
			if (removeEnd < info.length && /\s/.test(info[removeEnd])) removeEnd += 1;
			else if (removeStart > 0 && /\s/.test(info[removeStart - 1])) removeStart -= 1;
			newInfo = info.slice(0, removeStart) + info.slice(removeEnd);
		}
	} else if (mode === "remove") {
		return { ok: true, line: openingLine, changed: false };
	} else {
		const trailingStart = info.search(/\s*$/);
		const beforeTrailing = info.slice(0, trailingStart);
		const separator = beforeTrailing.length === 0 || /\s$/.test(beforeTrailing) ? "" : " ";
		newInfo = `${beforeTrailing}${separator}hl:${newSpec}${info.slice(trailingStart)}`;
	}

	const line = openingLine.slice(0, infoStart) + newInfo;
	return { ok: true, line, changed: line !== openingLine };
}

export function planFenceLineUpdate(
	lines: readonly string[],
	selectedAbsolute: LineRange,
	mode: "add" | "remove"
): PlannedFenceUpdate {
	const enclosure = findEnclosingFence(lines, selectedAbsolute);
	if (!enclosure.ok) return enclosure;
	const openingLine = lines[enclosure.block.openingLine];
	const update = updateFenceInfoString(openingLine, enclosure.block.infoStart, enclosure.selected, mode);
	if (!update.ok) return { ok: false, reason: "invalid-metadata" };
	return {
		ok: true,
		changed: update.changed,
		line: enclosure.block.openingLine,
		replacement: update.line
	};
}
