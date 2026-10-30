import { z } from "zod";

export const renderReviewCheckSchema = z
	.object({
		id: z.string().min(1).max(80),
		label: z.string().min(1).max(120),
		status: z.enum(["passed", "warning", "failed"]),
		message: z.string().min(1).max(400),
	})
	.strict();

export const renderReviewSchema = z
	.object({
		bytes: z.number().int().positive(),
		checks: z.array(renderReviewCheckSchema).max(20),
		duration: z.number().finite().nonnegative(),
		frameRate: z.number().finite().positive(),
		hasAudio: z.boolean(),
		height: z.number().int().positive(),
		passed: z.boolean(),
		samples: z.array(z.number().finite().min(0).max(255).nullable()).max(8),
		width: z.number().int().positive(),
	})
	.strict();

export type RenderReview = z.infer<typeof renderReviewSchema>;

export interface RenderReviewFacts {
	actual: {
		bytes: number;
		duration: number;
		frameRate: number;
		hasAudio: boolean;
		height: number;
		width: number;
	};
	expected: {
		duration: number;
		fps: number;
		hasAudio: boolean;
		height: number;
		width: number;
	};
	samples: Array<number | null>;
}

function check(
	id: string,
	label: string,
	status: "passed" | "warning" | "failed",
	message: string
) {
	return { id, label, status, message };
}

/**
 * Summarize facts collected from a rendered file into an auditable delivery
 * review. This remains deterministic and sidecar-independent so agents and
 * tests can reason about the same quality gate as the Companion.
 */
export function summarizeRenderReview(facts: RenderReviewFacts): RenderReview {
	const { actual, expected, samples } = facts;
	const validSamples = samples.filter(
		(sample): sample is number => sample !== null && Number.isFinite(sample)
	);
	const allBlack =
		validSamples.length > 0 && validSamples.every((sample) => sample <= 18);
	const checks = [
		actual.width === expected.width && actual.height === expected.height
			? check(
					"dimensions",
					"Frame size",
					"passed",
					`${actual.width} × ${actual.height}`
				)
			: check(
					"dimensions",
					"Frame size",
					"failed",
					`Expected ${expected.width} × ${expected.height}; received ${actual.width} × ${actual.height}.`
				),
		Math.abs(actual.frameRate - expected.fps) <= 0.01
			? check(
					"frame-rate",
					"Frame rate",
					"passed",
					`${actual.frameRate.toFixed(2)} fps`
				)
			: check(
					"frame-rate",
					"Frame rate",
					"failed",
					`Expected ${expected.fps} fps; received ${actual.frameRate.toFixed(2)} fps.`
				),
		Math.abs(actual.duration - expected.duration) <= 0.2
			? check(
					"duration",
					"Duration",
					"passed",
					`${actual.duration.toFixed(2)} seconds`
				)
			: check(
					"duration",
					"Duration",
					"failed",
					`Expected ${expected.duration.toFixed(2)} seconds; received ${actual.duration.toFixed(2)} seconds.`
				),
		actual.bytes >= 1000
			? check(
					"file-size",
					"Encoded file",
					"passed",
					`${(actual.bytes / 1e6).toFixed(1)} MB`
				)
			: check(
					"file-size",
					"Encoded file",
					"failed",
					"The encoded file is unexpectedly small."
				),
		actual.hasAudio === expected.hasAudio
			? check(
					"audio",
					"Audio presence",
					"passed",
					actual.hasAudio ? "Audio stream present" : "No audio expected"
				)
			: expected.hasAudio
				? check(
						"audio",
						"Audio presence",
						"failed",
						"The timeline contains audio, but the export has no audio stream."
					)
				: check(
						"audio",
						"Audio presence",
						"warning",
						"The export contains an audio stream that the timeline did not require."
					),
		validSamples.length === 0
			? check(
					"content",
					"Frame samples",
					"failed",
					"The renderer returned no inspectable frame samples."
				)
			: allBlack
				? check(
						"content",
						"Frame samples",
						"failed",
						"Every sampled frame is black; review the timeline before delivery."
					)
				: check(
						"content",
						"Frame samples",
						"passed",
						`${validSamples.length} frame samples contain visible luma`
					),
	];

	return renderReviewSchema.parse({
		...actual,
		checks,
		passed: checks.every((item) => item.status !== "failed"),
		samples,
	});
}
