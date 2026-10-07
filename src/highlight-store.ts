import { decodePayload, encodePayload, type TextAnchor } from "./text-highlights";

export type NoteHighlights = Record<string, TextAnchor[]>;
export const MAX_STORE_BYTES = 4 * 1024 * 1024;

export function validateNotes(value: unknown): NoteHighlights {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid highlight database");
	const entries = Object.entries(value);
	if (entries.length > 512 || new TextEncoder().encode(JSON.stringify(value)).length > MAX_STORE_BYTES) throw new Error("Highlight database limit exceeded");
	const result: NoteHighlights = Object.create(null) as NoteHighlights;
	let count = 0;
	for (const [path, anchors] of entries) {
		if (!path.endsWith(".md") || path.length > 1024 || !Array.isArray(anchors)) throw new Error("Invalid note record");
		const payload = decodePayload(encodePayload({ version: 1, anchors: anchors as TextAnchor[] }));
		if (!payload || (count += payload.anchors.length) > 4096) throw new Error("Highlight database limit exceeded");
		if (payload.anchors.length) result[path] = payload.anchors;
	}
	return result;
}

/** Serial, coalescing writer: failures retain dirty state; no rejected background promises. */
export class SaveQueue {
	private running: Promise<boolean> | null = null;
	private revision = 0;
	private saved = 0;
	constructor(private write: () => Promise<void>, private failed: () => void) {}
	mark(): void { this.revision++; }
	flush(): Promise<boolean> {
		if (this.running) return this.running;
		this.running = this.drain().finally(() => { this.running = null; });
		return this.running;
	}
	private async drain(): Promise<boolean> {
		while (this.saved !== this.revision) {
			const revision = this.revision;
			try { await this.write(); this.saved = revision; }
			catch { this.failed(); return false; }
		}
		return true;
	}
}
