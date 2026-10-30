import { describe, expect, test } from "bun:test";
import type { Asset } from "./project.ts";
import { takeQuality } from "./take-quality.ts";

const asset = (patch: Partial<Asset> = {}): Asset => ({
	createdAt: new Date().toISOString(),
	duration: 4,
	hasAudio: true,
	height: 1080,
	id: crypto.randomUUID(),
	kind: "video",
	name: "take.mp4",
	width: 1920,
	...patch,
});

describe("technical take quality", () => {
	test("passes a full-resolution audible visual take", () => {
		const result = takeQuality(asset(), { width: 1920, height: 1080 });
		expect(result.status).toBe("ready");
		expect(result.score).toBe(100);
		expect(result.detail).toContain("audio");
	});

	test("marks low-resolution or empty takes for review", () => {
		expect(
			takeQuality(asset({ width: 320, height: 180 }), {
				width: 1920,
				height: 1080,
			}).status
		).toBe("review");
		expect(
			takeQuality(asset({ duration: 0 }), { width: 1920, height: 1080 }).score
		).toBe(70);
	});
});
