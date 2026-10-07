import type { TextRange } from "./text-highlights";

/** Later ranges repaint earlier ones; adjacent ranges merge only when colors match. */
export function mergeColoredRanges(ranges: readonly TextRange[]): TextRange[] {
	let result: TextRange[] = [];
	for (const range of ranges) {
		if (range.from >= range.to) continue;
		result = result.flatMap(old => {
			if (old.to <= range.from || old.from >= range.to) return [old];
			return [{ ...old, to: range.from }, { ...old, from: range.to }].filter(r => r.from < r.to);
		});
		result.push(range.color === "red" ? { from: range.from, to: range.to, color: "red" } : { from: range.from, to: range.to });
	}
	result.sort((a, b) => a.from - b.from);
	const merged: TextRange[] = [];
	for (const range of result) {
		const previous = merged[merged.length - 1];
		if (previous && previous.to === range.from && previous.color === range.color) previous.to = range.to;
		else merged.push({ ...range });
	}
	return merged;
}
