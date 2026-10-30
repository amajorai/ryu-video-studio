import { describe, expect, test } from "bun:test";
import { STALE_INPUT_LIMIT_MS } from "./compositor/compositor.ts";
import { compositorShownAfter } from "./PreviewBlendCompositor.tsx";

describe("compositorShownAfter", () => {
	test("drawn and briefly stale frames stay on screen", () => {
		expect(compositorShownAfter("drawn", true, 0)).toBe(true);
		expect(compositorShownAfter("stale", true, 0)).toBe(true);
		expect(compositorShownAfter("stale", false, 0)).toBe(true);
	});

	test("a waiting frame never freezes the old composite over playback", () => {
		expect(compositorShownAfter("waiting", true, 0)).toBe(false);
	});

	test("paused, a waiting frame hides once it has waited too long", () => {
		expect(compositorShownAfter("waiting", false, 0)).toBe(true);
		expect(
			compositorShownAfter("waiting", false, STALE_INPUT_LIMIT_MS + 1)
		).toBe(false);
	});
});
