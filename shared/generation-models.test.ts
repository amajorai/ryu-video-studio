import { describe, expect, test } from "bun:test";
import { generationRequestSchema } from "./generation.ts";
import {
	GENERATION_MODEL_PRESETS,
	generationTaskSchema,
	parseProviderInput,
	presetFor,
	presetProviderInput,
	presetsForTask,
	providerInputProblems,
	resolveImageProviderInput,
	TASK_BRIDGE,
} from "./generation-models.ts";

const AUDIO_TASKS = new Set(["music", "sfx"]);

describe("generation model presets", () => {
	test("every task has at least one preset and every preset is unverified", () => {
		for (const task of generationTaskSchema.options) {
			expect(presetsForTask(task).length).toBeGreaterThan(0);
		}
		for (const row of GENERATION_MODEL_PRESETS) {
			expect(row.verified).toBe(false);
			expect(row.id).toBe(`${row.provider}:${row.model}`);
		}
		expect(new Set(GENERATION_MODEL_PRESETS.map((row) => row.id)).size).toBe(
			GENERATION_MODEL_PRESETS.length
		);
	});

	test("every preset maps exactly the inputs its task sends", () => {
		for (const row of GENERATION_MODEL_PRESETS) {
			expect(
				providerInputProblems(row.task, row.providerInput, {
					duration: AUDIO_TASKS.has(row.task),
				})
			).toEqual([]);
		}
	});

	test("the documented field names are kept", () => {
		expect(presetFor("v2v", "fal:fal-ai/wan-vace-14b")?.providerInput).toEqual({
			video_url: "$input_video",
		});
		expect(presetFor("flf", "fal:fal-ai/wan-flf2v")?.providerInput).toEqual({
			end_image_url: "$input_images.1",
			start_image_url: "$input_images.0",
		});
		expect(
			presetsForTask("flf").map((row) => row.providerInput)
		).toContainEqual({
			image_url: "$input_images.0",
			tail_image_url: "$input_images.1",
		});
		expect(presetsForTask("lipsync").map((row) => row.model)).toEqual([
			"fal-ai/sync-lipsync",
			"fal-ai/latentsync",
			"bytedance/latentsync",
		]);
		expect(presetFor("matte-video")?.model).toBe("fal-ai/birefnet/v2/video");
		expect(presetFor("matte-image")?.model).toBe("fal-ai/birefnet/v2");
		expect(presetFor("sfx")?.model).toBe("fal-ai/elevenlabs/sound-effects");
		expect(presetsForTask("music").map((row) => row.model)).toEqual([
			"fal-ai/stable-audio",
			"meta/musicgen",
		]);
	});

	test("an unknown preset id falls back to the task's first preset", () => {
		expect(presetFor("v2v", "nope")?.model).toBe("fal-ai/wan-vace-14b");
	});

	test("edited field maps are checked before sending", () => {
		expect(providerInputProblems("v2v", {})).toEqual([
			"Map $input_video to the model's field for it.",
		]);
		expect(
			providerInputProblems("v2v", {
				a: "$input_video",
				b: "$input_video",
			})
		).toEqual(["$input_video is mapped more than once."]);
		expect(
			providerInputProblems("v2v", { prompt: "x", v: "$input_video" })
		).toEqual(["“prompt” is set by Ryu and cannot be a model field."]);
		expect(
			providerInputProblems("v2v", { v: "$input_video", a: "$input_audio" })
		).toEqual(["$input_audio is not sent for this task."]);
		expect(providerInputProblems("v2v", { v: "$input_vid" })).toContain(
			"“$input_vid” is not an input Ryu can send."
		);
		expect(
			providerInputProblems("music", { d: "$duration_s" }, { duration: true })
		).toEqual([]);
	});

	test("parses only JSON objects", () => {
		expect(parseProviderInput('{"video_url":"$input_video"}')).toEqual({
			video_url: "$input_video",
		});
		expect(() => parseProviderInput("[1]")).toThrow("JSON object");
		expect(() => parseProviderInput("nope")).toThrow("JSON object");
	});

	test("the prompt goes into a model-specific prompt field once", () => {
		const sfx = presetFor("sfx");
		if (!sfx) {
			throw new Error("missing sfx preset");
		}
		expect(presetProviderInput(sfx, "door slam")).toEqual({
			duration_seconds: "$duration_s",
			text: "door slam",
		});
		// The preset table itself is not mutated.
		expect(sfx.providerInput).toEqual({ duration_seconds: "$duration_s" });
	});

	test("image tasks inline the still where the preset references it", () => {
		const fields = resolveImageProviderInput(
			{ image_url: "$input_images.0", nested: { keep: "$other" } },
			"data:image/png;base64,AAAA"
		);
		expect(fields).toEqual({
			image_url: "data:image/png;base64,AAAA",
			nested: { keep: "$other" },
		});
		expect(() =>
			resolveImageProviderInput({}, "data:image/png;base64,A")
		).toThrow("$input_images.0");
	});
});

describe("task generation requests", () => {
	const base = {
		id: crypto.randomUUID(),
		projectId: crypto.randomUUID(),
		prompt: "Make it rain",
	};

	test("a task must match the bridge kind it runs on", () => {
		for (const task of generationTaskSchema.options) {
			const consent =
				task === "lipsync" || task === "avatar"
					? { consent: "subjects-agreed" as const }
					: {};
			expect(
				generationRequestSchema.safeParse({
					...base,
					...consent,
					kind: TASK_BRIDGE[task],
					task,
				}).success
			).toBe(true);
		}
		expect(
			generationRequestSchema.safeParse({ ...base, kind: "image", task: "v2v" })
				.success
		).toBe(false);
	});

	test("lip-sync and avatars require the consent notice", () => {
		const result = generationRequestSchema.safeParse({
			...base,
			kind: "video",
			task: "lipsync",
		});
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain("agreed");
	});

	test("reference inputs are refused without a task", () => {
		expect(
			generationRequestSchema.safeParse({
				...base,
				kind: "video",
				providerInput: { video_url: "$input_video" },
			}).success
		).toBe(false);
	});

	test("first/last-frame requests carry two frame stills", () => {
		const parsed = generationRequestSchema.parse({
			...base,
			durationSeconds: 1.5,
			inputAssetIds: [crypto.randomUUID(), crypto.randomUUID()],
			kind: "video",
			task: "flf",
		});
		expect(parsed.inputAssetIds).toHaveLength(2);
	});
});
