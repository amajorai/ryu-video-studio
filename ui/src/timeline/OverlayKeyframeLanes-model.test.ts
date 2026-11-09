import { describe, expect, test } from "bun:test";
import { overlayKeyframeText } from "./OverlayKeyframeLanes-model.ts";

describe("overlayKeyframeText", () => {
	test("a value reads with the reader's decimal mark", () => {
		const frame = { property: "opacity", value: 0.5 } as const;
		expect(overlayKeyframeText(frame, "en")).toBe("0.50");
		expect(overlayKeyframeText(frame, "de")).toBe("0,50");
		expect(overlayKeyframeText({ property: "x", value: -12.345 }, "de")).toBe(
			"-12,35"
		);
	});

	test("a color channel reads as its color", () => {
		expect(
			overlayKeyframeText(
				{ color: "#ff0000", property: "fill", value: 0 },
				"de"
			)
		).toBe("#ff0000");
	});
});
