import { describe, expect, test } from "bun:test";
import { summarizeRenderReview } from "./render-review.ts";

const facts = {
	actual: {
		bytes: 120_000,
		duration: 5,
		frameRate: 30,
		hasAudio: true,
		height: 1080,
		width: 1920,
	},
	expected: {
		duration: 5,
		fps: 30,
		hasAudio: true,
		height: 1080,
		width: 1920,
	},
};

describe("render delivery review", () => {
	test("passes a matching render with visible samples", () => {
		const review = summarizeRenderReview({
			...facts,
			samples: [32, 96, 144, 88],
		});

		expect(review.passed).toBe(true);
		expect(review.checks.every((check) => check.status === "passed")).toBe(
			true
		);
	});

	test("blocks an all-black render while retaining the measured facts", () => {
		const review = summarizeRenderReview({
			...facts,
			samples: [16, 16, 17, 16],
		});

		expect(review.passed).toBe(false);
		expect(review.checks.find((check) => check.id === "content")?.status).toBe(
			"failed"
		);
	});

	test("reports missing expected audio as a delivery failure", () => {
		const review = summarizeRenderReview({
			...facts,
			actual: { ...facts.actual, hasAudio: false },
			samples: [32, 96],
		});

		expect(review.passed).toBe(false);
		expect(
			review.checks.find((check) => check.id === "audio")?.message
		).toContain("no audio stream");
	});
});
