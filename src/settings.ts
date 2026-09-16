export interface HighlighterSettings {
	highlightColor: string;
	highlightOpacity: number;
	accentColor: string;
	accentWidth: number;
}

export const DEFAULT_SETTINGS: HighlighterSettings = {
	highlightColor: "#ffd54f",
	highlightOpacity: 32,
	accentColor: "#7c3aed",
	accentWidth: 3
};

function isHexColor(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number"
		&& Number.isInteger(value)
		&& value >= minimum
		&& value <= maximum;
}

export function normalizeSettings(value: unknown): HighlighterSettings {
	const source = value && typeof value === "object" ? value as Partial<HighlighterSettings> : {};
	return {
		highlightColor: isHexColor(source.highlightColor)
			? source.highlightColor.toLowerCase()
			: DEFAULT_SETTINGS.highlightColor,
		highlightOpacity: integerInRange(source.highlightOpacity, 10, 80)
			? source.highlightOpacity
			: DEFAULT_SETTINGS.highlightOpacity,
		accentColor: isHexColor(source.accentColor)
			? source.accentColor.toLowerCase()
			: DEFAULT_SETTINGS.accentColor,
		accentWidth: integerInRange(source.accentWidth, 0, 6)
			? source.accentWidth
			: DEFAULT_SETTINGS.accentWidth
	};
}
