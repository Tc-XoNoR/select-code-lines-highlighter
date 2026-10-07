import { findEnclosingFence, findFenceBlocks, findHighlightTokens, getSelectedLineRange, readFenceHighlightSpec, type Position } from "./core";

export type HighlightColor = "yellow" | "red";
export interface TextRange { from: number; to: number; color?: HighlightColor }
export interface TextAnchor {
	color?: HighlightColor;
	text: string;
	before: string;
	after: string;
	ordinal: number;
	count: number;
}
export interface TextPayload { version: 1; anchors: TextAnchor[] }
export type TextPlan = { ok: true; changed: boolean; line: number; replacement: string }
	| { ok: false; reason: "outside" | "multiple" | "invalid-metadata" | "limit" | "ambiguous" };
const encoder = new TextEncoder();
export const MAX_SELECTION_BYTES = 4096;
export const MAX_PAYLOAD_BYTES = 65536;
const MAX_ANCHORS = 256;

export function createAnchor(content: string, range: TextRange): TextAnchor {
	const text = content.slice(range.from, range.to);
	let count = 0;
	let ordinal = -1;
	if (text) {
		for (let from = content.indexOf(text); from >= 0; from = content.indexOf(text, from + 1)) {
			if (from === range.from) ordinal = count;
			count++;
		}
	}
	return {
		text,
		before: Array.from(content.slice(Math.max(0, range.from - 64), range.from)).slice(-32).join(""),
		after: Array.from(content.slice(range.to, range.to + 64)).slice(0, 32).join(""),
		ordinal, count
	};
}

// Ordinal/count are evidence, never permission to guess between identical contexts.
export function resolveAnchor(content: string, anchor: TextAnchor): TextRange | null {
	if (!anchor.text) return null;
	let count = 0;
	let best = 0;
	let tied = false;
	let winner: TextRange | null = null;
	for (let from = content.indexOf(anchor.text); from >= 0; from = content.indexOf(anchor.text, from + 1)) {
		count++;
		const to = from + anchor.text.length;
		const left = anchor.before ? content.slice(Math.max(0, from - anchor.before.length), from) === anchor.before : from === 0;
		const right = anchor.after ? content.slice(to, to + anchor.after.length) === anchor.after : to === content.length;
		const score = Number(left) + Number(right);
		if (score > best) { best = score; winner = { from, to }; tied = false; }
		else if (score === best) tied = true;
	}
	return best === 0 || tied || count < anchor.count ? null : winner;
}

function validAnchor(value: unknown): value is TextAnchor {
	if (!value || typeof value !== "object") return false;
	const a = value as Partial<TextAnchor>;
	return (a.color === undefined || a.color === "yellow" || a.color === "red")
		&& typeof a.text === "string" && a.text.length > 0 && !a.text.includes("\r")
		&& new TextDecoder().decode(encoder.encode(a.text)) === a.text
		&& encoder.encode(a.text).length <= MAX_SELECTION_BYTES
		&& typeof a.before === "string" && Array.from(a.before).length <= 32
		&& typeof a.after === "string" && Array.from(a.after).length <= 32
		&& typeof a.ordinal === "number" && Number.isSafeInteger(a.ordinal) && a.ordinal >= 0
		&& typeof a.count === "number" && Number.isSafeInteger(a.count) && a.count > a.ordinal;
}

export function encodePayload(payload: TextPayload): string {
	const bytes = encoder.encode(JSON.stringify(payload));
	if (bytes.length > MAX_PAYLOAD_BYTES || payload.anchors.length > MAX_ANCHORS
		|| !payload.anchors.every(validAnchor)) throw new Error("Highlight size limit exceeded");
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodePayload(spec: string): TextPayload | null {
	if (!spec || spec.length > Math.ceil(MAX_PAYLOAD_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(spec)) return null;
	try {
		const binary = atob(spec.replace(/-/g, "+").replace(/_/g, "/"));
		if (binary.length > MAX_PAYLOAD_BYTES) return null;
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
		if (!value || typeof value !== "object") return null;
		const payload = value as Partial<TextPayload>;
		if (payload.version !== 1 || !Array.isArray(payload.anchors) || payload.anchors.length > MAX_ANCHORS
			|| !payload.anchors.every(validAnchor)) return null;
		return { version: 1, anchors: payload.anchors };
	} catch { return null; }
}

export function readTextHighlights(opening: string, infoStart: number): TextPayload | null {
	const tokens = findHighlightTokens(opening.slice(infoStart), "ht");
	if (!tokens || tokens.length > 1) return null;
	return tokens.length ? decodePayload(tokens[0].spec) : { version: 1, anchors: [] };
}

export function mergeTextRanges(ranges: readonly TextRange[]): TextRange[] {
	const result: TextRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.from - b.from || a.to - b.to)) {
		if (range.to <= range.from) continue;
		const previous = result[result.length - 1];
		if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
		else result.push({ ...range });
	}
	return result;
}

export function resolvedTextRanges(content: string, payload: TextPayload | null): TextRange[] {
	return mergeTextRanges((payload?.anchors ?? []).flatMap(anchor => {
		const range = resolveAnchor(content, anchor);
		return range ? [range] : [];
	}));
}

function replaceToken(opening: string, infoStart: number, spec: string): string {
	const token = findHighlightTokens(opening.slice(infoStart), "ht")?.[0];
	if (token) {
		let start = infoStart + token.start;
		let end = infoStart + token.end;
		if (spec) return opening.slice(0, start) + `ht:${spec}` + opening.slice(end);
		if (/\s/.test(opening[end] ?? "")) end++;
		else if (start > infoStart && /\s/.test(opening[start - 1])) start--;
		return opening.slice(0, start) + opening.slice(end);
	}
	if (!spec) return opening;
	const end = opening.search(/\s*$/);
	return opening.slice(0, end) + (end === infoStart ? "" : " ") + `ht:${spec}` + opening.slice(end);
}

export function planTextUpdate(lines: readonly string[], anchor: Position, head: Position, mode: "add" | "remove" | "clear"): TextPlan {
	const selected = getSelectedLineRange(anchor, head);
	const enclosure = mode === "clear"
		? findFenceBlocks(lines).find(block => anchor.line > block.openingLine && anchor.line < block.closingLine)
		: selected ? findEnclosingFence(lines, selected) : undefined;
	if (!enclosure) return { ok: false, reason: "outside" };
	if ("ok" in enclosure && !enclosure.ok) return enclosure;
	const block = "block" in enclosure ? enclosure.block : enclosure;
	const opening = lines[block.openingLine];
	const payload = readTextHighlights(opening, block.infoStart);
	if (!payload || readFenceHighlightSpec(opening, block.infoStart) === null) return { ok: false, reason: "invalid-metadata" };
	const content = lines.slice(block.openingLine + 1, block.closingLine).join("\n");
	let anchors: TextAnchor[] = [];
	if (mode !== "clear") {
		const offset = (p: Position): number => {
			if (!Number.isInteger(p.line) || !Number.isInteger(p.ch) || p.ch < 0 || p.ch > (lines[p.line]?.length ?? -1)) return -1;
			return lines.slice(block.openingLine + 1, p.line).reduce((n, line) => n + line.length + 1, 0) + p.ch;
		};
		const from = Math.min(offset(anchor), offset(head));
		const to = Math.max(offset(anchor), offset(head));
		// A selection ending at closing-fence column zero includes a final newline only.
		const end = Math.min(to, content.length);
		if (from < 0 || from >= end || to > content.length + 1) return { ok: false, reason: "outside" };
		if (encoder.encode(content.slice(from, end)).length > MAX_SELECTION_BYTES) return { ok: false, reason: "limit" };
		const resolved = resolvedTextRanges(content, payload);
		const unresolved = payload.anchors.filter(a => !resolveAnchor(content, a));
		let updated: TextRange[];
		if (mode === "add") updated = mergeTextRanges([...resolved, { from, to: end }]);
		else updated = resolved.flatMap(range => {
			if (range.to <= from || range.from >= end) return [range];
			return [ { from: range.from, to: Math.min(from, range.to) }, { from: Math.max(end, range.from), to: range.to } ].filter(r => r.to > r.from);
		});
		if (JSON.stringify(updated) === JSON.stringify(resolved)) return { ok: true, changed: false, line: block.openingLine, replacement: opening };
		anchors = [...unresolved, ...updated.map(range => createAnchor(content, range))];
		if (updated.some(range => {
			const resolved = resolveAnchor(content, createAnchor(content, range));
			return !resolved || resolved.from !== range.from || resolved.to !== range.to;
		})) return { ok: false, reason: "ambiguous" };
	}
	try {
		const replacement = replaceToken(opening, block.infoStart, anchors.length ? encodePayload({ version: 1, anchors }) : "");
		return { ok: true, changed: replacement !== opening, line: block.openingLine, replacement };
	} catch { return { ok: false, reason: "limit" }; }
}
