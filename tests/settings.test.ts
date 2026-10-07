import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

describe("plugin settings", () => {
	it("defaults older installations to exact text, preserves lines and rejects unknown modes", () => {
		expect(normalizeSettings({ highlightOpacity: 50 }).selectionMode).toBe("text");
		expect(normalizeSettings({ selectionMode: "lines" }).selectionMode).toBe("lines");
		expect(normalizeSettings({ selectionMode: "unknown" }).selectionMode).toBe("text");
	});
	it("uses defaults when stored data is missing", () => {
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it("accepts valid visual settings and normalizes colors", () => {
		expect(normalizeSettings({
			highlightColor: "#AABBCC",
			highlightOpacity: 55,
			accentColor: "#123456",
			accentWidth: 0
		})).toEqual({
			selectionMode: "text",
			highlightColor: "#aabbcc",
			highlightOpacity: 55,
			accentColor: "#123456",
			accentWidth: 0
		});
	});

	it("rejects malformed colors and out-of-range numbers", () => {
		expect(normalizeSettings({
			highlightColor: "yellow",
			highlightOpacity: 81,
			accentColor: "#fff",
			accentWidth: -1
		})).toEqual(DEFAULT_SETTINGS);
	});
});
