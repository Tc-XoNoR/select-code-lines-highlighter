import { StateEffect, StateField, type EditorState, type Transaction, type ChangeDesc } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { findFenceBlocks } from "./core";
import { createAnchor, encodePayload, resolveAnchor, type HighlightColor, type TextAnchor, type TextRange } from "./text-highlights";
import { mergeColoredRanges } from "./highlight-colors";

export const MAX_DOCUMENT = 1024 * 1024;
export const MAX_DOCUMENT_LINES = 10000;
export interface LocalHighlights { ranges: TextRange[]; unresolved: TextAnchor[] }
export const emptyHighlights = (): LocalHighlights => ({ ranges: [], unresolved: [] });
export const setHighlights = StateEffect.define<LocalHighlights>({ map: (value, changes) => mapRanges(value, changes) });

export function codeRanges(source: string): TextRange[] {
	if (source.length > MAX_DOCUMENT) return [];
	const lines = source.split("\n");
	if (lines.length > MAX_DOCUMENT_LINES) return [];
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
	return findFenceBlocks(lines).map(b => ({ from: offsets[b.openingLine + 1], to: offsets[b.closingLine] - 1 }));
}

export function loadHighlights(source: string, anchors: TextAnchor[]): LocalHighlights {
	if (source.length > MAX_DOCUMENT) return { ranges: [], unresolved: anchors };
	const blocks = codeRanges(source);
	const ranges: TextRange[] = [];
	const unresolved: TextAnchor[] = [];
	for (const anchor of anchors) {
		const range = resolveAnchor(source, anchor);
		if (range && blocks.some(b => range.from >= b.from && range.to <= b.to)) ranges.push({ ...range, color: anchor.color });
		else unresolved.push(anchor);
	}
	return { ranges: mergeColoredRanges(ranges), unresolved };
}

export function serializeHighlights(source: string, value: LocalHighlights): TextAnchor[] {
	const anchors = [...value.unresolved, ...value.ranges.map(r => ({ ...createAnchor(source, r), ...(r.color === "red" ? { color: r.color } : {}) }))];
	encodePayload({ version: 1, anchors }); // Validate byte/count budgets before persistence.
	return anchors;
}

export function changeHighlights(source: string, value: LocalHighlights, selected: TextRange, mode: "add" | "remove" | "clear", color: HighlightColor = "yellow"): LocalHighlights {
	if (source.length > MAX_DOCUMENT) throw new Error("This note exceeds the 1 MiB highlighting limit.");
	const block = codeRanges(source).find(b => selected.from >= b.from && selected.to <= b.to);
	if (!block || selected.from > selected.to || mode !== "clear" && selected.from === selected.to) throw new Error("Select code inside one fenced block.");
	if (mode !== "clear" && new TextEncoder().encode(source.slice(selected.from, selected.to)).length > 4096) throw new Error("Select at most 4 KiB of text.");
	const cut = mode === "clear" ? block : selected;
	const ranges = mode === "add" ? mergeColoredRanges([...value.ranges, { ...selected, color }]) : value.ranges.flatMap(r => {
		if (r.to <= cut.from || r.from >= cut.to) return [r];
		return [{ ...r, to: Math.min(r.to, cut.from) }, { ...r, from: Math.max(r.from, cut.to) }].filter(r => r.from < r.to);
	});
	// Unresolved anchors have no reliable block identity. A separate note-wide clear handles them.
	const result = { ranges, unresolved: value.unresolved };
	serializeHighlights(source, result);
	if (ranges.some(r => {
		const found = resolveAnchor(source, createAnchor(source, r));
		return !found || found.from !== r.from || found.to !== r.to;
	})) throw new Error("Repeated text is ambiguous. Select more context.");
	return result;
}

function mapRanges(value: LocalHighlights, changes: ChangeDesc): LocalHighlights {
	const ranges: TextRange[] = [];
	for (const range of value.ranges) {
		let touched = false;
		changes.iterChangedRanges((from, to) => {
			if (from < range.to && to > range.from || from === to && from > range.from && from < range.to) touched = true;
		});
		if (!touched) ranges.push({ ...range, from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) });
	}
	return { ranges, unresolved: value.unresolved };
}

export function mapHighlights(value: LocalHighlights, tr: Transaction): LocalHighlights {
	const mapped = mapRanges(value, tr.changes);
	const editing = ["input", "delete", "undo", "redo", "move"].some(event => tr.isUserEvent(event));
	if (!editing && mapped.ranges.length < value.ranges.length && tr.startState.doc.length <= MAX_DOCUMENT) {
		// External replacement/synchronization is not proof of intentional deletion.
		try { return loadHighlights(tr.newDoc.toString(), serializeHighlights(tr.startState.doc.toString(), value)); }
		catch { return { ranges: [], unresolved: value.unresolved }; }
	}
	return mapped;
}

export function highlightState(initial: (state: EditorState) => LocalHighlights, identity: (state: EditorState) => string = () => "") {
	const field = StateField.define<LocalHighlights>({
		create: initial,
		update(value, tr) {
			if (identity(tr.startState) !== identity(tr.state)) return initial(tr.state);
			if (tr.docChanged) value = mapHighlights(value, tr);
			for (const effect of tr.effects) if (effect.is(setHighlights)) value = effect.value;
			return value;
		}
	});
	const history = invertedEffects.of(tr => tr.docChanged || tr.effects.some(e => e.is(setHighlights))
		? [setHighlights.of(tr.startState.field(field))] : []);
	return { field, history };
}
