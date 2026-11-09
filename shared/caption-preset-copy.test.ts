import { describe, expect, test } from "bun:test";
import { CAPTION_PRESET_COPY } from "./caption-preset-copy.ts";
import { CAPTION_PRESETS, captionPreset } from "./caption-style.ts";

describe("caption preset copy", () => {
	test("every preset takes its label and description from the copy table", () => {
		expect(CAPTION_PRESETS.map((preset) => preset.id)).toEqual(
			Object.keys(CAPTION_PRESET_COPY)
		);
		for (const preset of CAPTION_PRESETS) {
			const copy =
				CAPTION_PRESET_COPY[preset.id as keyof typeof CAPTION_PRESET_COPY];
			expect(preset.label).toBe(copy.label);
			expect(preset.description).toBe(copy.description);
			expect(preset.style.presetId).toBe(preset.id);
		}
	});

	test("labels are unique and descriptions are whole sentences", () => {
		const labels = CAPTION_PRESETS.map((preset) => preset.label);
		expect(new Set(labels).size).toBe(labels.length);
		for (const preset of CAPTION_PRESETS) {
			expect(preset.description).toMatch(/^[A-Z].*\.$/u);
		}
	});

	test("ambiguous one-word names use their caption sense, ids stay stable", () => {
		expect(captionPreset("reveal")?.label).toBe("Word reveal");
		expect(captionPreset("broadcast")?.label).toBe("News broadcast");
		expect(captionPreset("reveal")?.style.presetId).toBe("reveal");
		expect(captionPreset("broadcast")?.style.presetId).toBe("broadcast");
	});
});
