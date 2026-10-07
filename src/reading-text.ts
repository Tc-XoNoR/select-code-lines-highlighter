import type { TextRange } from "./text-highlights";
import { mergeColoredRanges } from "./highlight-colors";

export const TEXT_HIGHLIGHT_CLASS = "select-code-lines-highlighter-text";
export const textHighlightClass = (range: TextRange): string => TEXT_HIGHLIGHT_CLASS + (range.color === "red" ? " select-code-lines-highlighter-critical" : "");

/** Wrap text-node slices only; syntax spans and copyable text remain intact. */
export function renderTextHighlights(code: HTMLElement, source: string, ranges: readonly TextRange[]): boolean {
	for (const mark of Array.from(code.querySelectorAll(`span.${TEXT_HIGHLIGHT_CLASS}`))) mark.replaceWith(...Array.from(mark.childNodes));
	code.normalize();
	const rendered = code.textContent ?? "";
	if (rendered !== source && rendered !== source + "\n") return false;
	const document = code.ownerDocument;
	const walker = document.createTreeWalker(code, 4 /* SHOW_TEXT */);
	const nodes: { node: Text; from: number; to: number }[] = [];
	let offset = 0;
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		nodes.push({ node, from: offset, to: offset + node.length });
		offset += node.length;
	}
	const merged = mergeColoredRanges(ranges);
	for (const { node, from, to } of nodes) {
		const overlaps = merged.filter(r => r.from < to && r.to > from);
		if (!overlaps.length) continue;
		const fragment = document.createDocumentFragment();
		let cursor = 0;
		for (const range of overlaps) {
			const start = Math.max(range.from - from, 0);
			const end = Math.min(range.to - from, node.length);
			fragment.appendChild(document.createTextNode(node.data.slice(cursor, start)));
			const mark = document.createElement("span");
			mark.className = textHighlightClass(range);
			mark.textContent = node.data.slice(start, end);
			fragment.appendChild(mark);
			cursor = end;
		}
		fragment.appendChild(document.createTextNode(node.data.slice(cursor)));
		node.replaceWith(fragment);
	}
	return true;
}
