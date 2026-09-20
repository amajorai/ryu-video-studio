import { describe, expect, test } from "bun:test";
import { type Asset, newSegment, trimSegment } from "./project.ts";

const asset: Asset = {
	createdAt: new Date().toISOString(),
	duration: 10,
	hasAudio: true,
	height: 180,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Footage",
	width: 320,
};

describe("timeline edge trimming", () => {
	test("trims the start in source time while preserving the moved timeline edge", () => {
		const segment = newSegment(asset, 2);
		const trimmed = trimSegment(segment, asset.duration, "start", 0.5);

		expect(trimmed.start).toBe(2.5);
		expect(trimmed.sourceIn).toBe(0.5);
		expect(trimmed.sourceOut).toBe(10);
	});

	test("clamps the end and removes keyframes beyond the new duration", () => {
		const segment = {
			...newSegment(asset),
			sourceOut: 3,
			keyframes: [
				{
					id: crypto.randomUUID(),
					time: 1,
					property: "scale" as const,
					value: 1,
				},
				{
					id: crypto.randomUUID(),
					time: 3,
					property: "scale" as const,
					value: 1,
				},
			],
		};
		const trimmed = trimSegment(segment, asset.duration, "end", -1.5);

		expect(trimmed.sourceOut).toBe(1.5);
		expect(trimmed.keyframes).toHaveLength(1);
	});
});
