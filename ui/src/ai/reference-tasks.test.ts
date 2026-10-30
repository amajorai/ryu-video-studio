import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { motionGapRefusal } from "../../../shared/gap-fill.ts";
import {
	type GenerationOutcomeInput,
	type GenerationRequest,
	LIKENESS_CONSENT_NOTICE,
} from "../../../shared/generation.ts";
import { presetFor } from "../../../shared/generation-models.ts";
import { type Asset, newProject, newSegment } from "../../../shared/project.ts";
import { planIsCurrent } from "../editing-ui.ts";
import type { GenerationServices, MediaBridge } from "./media-bridge.ts";
import {
	describeShotsWithVision,
	overwritePlacementEdit,
	runAiMatte,
	runGapFillMotion,
	runGeneratedAudio,
	runPhotoreal,
	runVideoToVideo,
} from "./reference-tasks.ts";
import {
	assertTaskChoice,
	localEngineChoice,
	presetChoice,
	visionErrorMessage,
} from "./task-generation.ts";

const VIDEO_DATA = "data:video/mp4;base64,AAAAIGZ0eXBpc29t";
const PNG_DATA = "data:image/png;base64,iVBORw0KGgo=";
const AUDIO_DATA = "data:audio/mp4;base64,AAAAHGZ0eXBNNEEg";

// These runners only touch `window.ryu`; alias it to the global object
// when no DOM is registered.
const ownsWindow = !("window" in globalThis);
if (ownsWindow) {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: globalThis,
	});
}
afterAll(() => {
	if (ownsWindow) {
		Reflect.deleteProperty(globalThis, "window");
	}
});
afterEach(() => {
	Reflect.deleteProperty(window, "ryu");
});

function asset(kind: Asset["kind"], extra: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 12,
		hasAudio: kind !== "image",
		height: 1080,
		id: crypto.randomUUID(),
		kind,
		name: `${kind} source`,
		width: 1920,
		...extra,
	};
}

/** A fake sidecar behind `window.ryu.app.request`, logging each call. */
function installSidecar(handlers: Record<string, (body: unknown) => unknown>): {
	calls: { body: unknown; method: string; path: string }[];
} {
	const calls: { body: unknown; method: string; path: string }[] = [];
	const inputs = new Map<string, string>();
	const prepared = (data: string, extra: Record<string, unknown>) => {
		const id = crypto.randomUUID();
		const base64 = data.slice(data.indexOf(",") + 1);
		inputs.set(id, base64);
		return {
			id,
			mediaType: data.slice(5, data.indexOf(";")),
			size: atob(base64).length,
			...extra,
		};
	};
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			app: {
				request: async (input: {
					body?: unknown;
					method?: string;
					path: string;
				}) => {
					const method = input.method ?? "GET";
					calls.push({ body: input.body, method, path: input.path });
					const read = input.path.match(/^\/generation-inputs\/([^/]+)\/data/);
					if (read?.[1]) {
						return { data: inputs.get(read[1]) ?? "", done: true };
					}
					if (input.path.endsWith("/generation-input")) {
						const body = input.body as {
							kind: string;
							start?: number;
							end?: number;
						};
						return body.kind === "clip"
							? prepared(VIDEO_DATA, {
									end: Math.min(body.end ?? 0, (body.start ?? 0) + 10),
									start: body.start ?? 0,
								})
							: prepared(AUDIO_DATA, { end: body.end, start: body.start });
					}
					if (input.path.endsWith("/gap-fill-frames")) {
						return {
							gap: 1,
							motionSeconds: 1,
							next: {
								assetId: crypto.randomUUID(),
								frame: 12,
								input: prepared(PNG_DATA, { end: 0.5, frame: 12, start: 0.5 }),
							},
							previous: {
								assetId: crypto.randomUUID(),
								frame: 17,
								input: prepared(PNG_DATA, { end: 0.7, frame: 17, start: 0.7 }),
							},
						};
					}
					if (input.path.endsWith("/photoreal-inputs")) {
						const body = input.body as { mode: string };
						return {
							audio: prepared(AUDIO_DATA, { end: 3, start: 0.5 }),
							picture:
								body.mode === "lipsync"
									? prepared(VIDEO_DATA, { end: 3.5, start: 1 })
									: prepared(PNG_DATA, { end: 1, frame: 25, start: 1 }),
							plan: {
								audio: { assetId: crypto.randomUUID(), end: 3, start: 0.5 },
								duration: 2.5,
								mode: body.mode,
								picture: { assetId: crypto.randomUUID(), end: 3.5, start: 1 },
								start: 1,
								track: 0,
								truncated: false,
							},
						};
					}
					const handler = handlers[input.path];
					if (handler) {
						return handler(input.body);
					}
					throw new Error(`unexpected sidecar call ${method} ${input.path}`);
				},
			},
		},
		writable: true,
	});
	return { calls };
}

function services(bridge: MediaBridge, saved: Partial<Asset> = {}) {
	const recorded: GenerationRequest[] = [];
	const outcomes: GenerationOutcomeInput[] = [];
	const admitted: string[] = [];
	const value: GenerationServices = {
		admit: async (_projectId, kind) => {
			admitted.push(kind);
		},
		bridge,
		finish: async (_id, outcome) => {
			outcomes.push(outcome);
		},
		readImage: async () => PNG_DATA,
		record: async (generation) => {
			recorded.push(generation);
		},
		upload: async (file) =>
			asset(
				file.type.startsWith("audio")
					? "audio"
					: file.type.startsWith("image")
						? "image"
						: "video",
				{
					duration: 4,
					name: file.name,
					...saved,
				}
			),
	};
	return { admitted, outcomes, recorded, services: value };
}

const PROJECT = crypto.randomUUID();

describe("AI edit → Video", () => {
	test("sends the bounded clip as input_video with the preset field map and places a take", async () => {
		const { calls } = installSidecar({});
		const sent: unknown[] = [];
		const bridge: MediaBridge = {
			video: async (input) => {
				sent.push(input);
				return [{ mediaType: "video/mp4", url: VIDEO_DATA }];
			},
		};
		const { recorded, outcomes, services: generation } = services(bridge);
		const source = asset("video");
		const segment = { ...newSegment(source, 2, 1), sourceIn: 1, sourceOut: 13 };
		const placements: unknown[] = [];
		const preset = presetFor("v2v");
		if (!preset) {
			throw new Error("missing preset");
		}
		const result = await runVideoToVideo({
			asset: source,
			choice: presetChoice(preset),
			place: async (placement) => {
				placements.push(placement);
				return true;
			},
			projectId: PROJECT,
			prompt: "Make it snow",
			segment,
			services: generation,
		});
		expect(calls[0]).toMatchObject({
			body: { audio: true, end: 13, kind: "clip", start: 1 },
			path: `/assets/${source.id}/generation-input`,
		});
		expect(sent[0]).toMatchObject({
			input_video: VIDEO_DATA,
			model: "fal-ai/wan-vace-14b",
			prompt: "Make it snow",
			provider: "fal",
			provider_input: { video_url: "$input_video" },
		});
		expect(sent[0]).not.toHaveProperty("duration_s");
		expect(recorded[0]).toMatchObject({
			kind: "video",
			purpose: "ai-edit",
			sourceAssetId: source.id,
			sourceRange: { end: 11, start: 1 },
			task: "v2v",
		});
		expect(outcomes[0]?.status).toBe("completed");
		expect(placements[0]).toEqual({
			assetId: result.asset.id,
			at: 2,
			sourceOut: 4,
			speed: 1,
			track: 1,
		});
		expect(result).toMatchObject({ placed: true, truncated: true });
	});

	test("a local or provider refusal is surfaced and recorded as incomplete", async () => {
		installSidecar({});
		const bridge: MediaBridge = {
			video: async () => {
				throw new Error(
					"the local video model cannot edit video; choose a cloud provider"
				);
			},
		};
		const { outcomes, services: generation } = services(bridge);
		const source = asset("video");
		const preset = presetFor("v2v");
		if (!preset) {
			throw new Error("missing preset");
		}
		await expect(
			runVideoToVideo({
				asset: source,
				choice: presetChoice(preset),
				projectId: PROJECT,
				prompt: "x",
				segment: newSegment(source),
				services: generation,
			})
		).rejects.toThrow("cannot edit video");
		expect(outcomes[0]).toMatchObject({ status: "incomplete" });
		expect(outcomes[0]?.message).toContain("cannot edit video");
	});

	test("no video bridge: refused with a reason before anything is recorded", async () => {
		const { calls } = installSidecar({});
		const { recorded, services: generation } = services({});
		const source = asset("video");
		const preset = presetFor("v2v");
		if (!preset) {
			throw new Error("missing preset");
		}
		await expect(
			runVideoToVideo({
				asset: source,
				choice: presetChoice(preset),
				projectId: PROJECT,
				prompt: "x",
				segment: newSegment(source),
				services: generation,
			})
		).rejects.toThrow("unavailable in this host");
		expect(recorded).toEqual([]);
		expect(calls).toEqual([]);
	});
});

describe("takes follow the clip's speed", () => {
	const v2vPreset = presetFor("v2v");
	const mattePreset = presetFor("matte-video");
	if (!(v2vPreset && mattePreset)) {
		throw new Error("missing preset");
	}

	test("AI edit → Video on a 2x clip covers the same source at 2x", async () => {
		installSidecar({});
		const bridge: MediaBridge = {
			video: async () => [{ mediaType: "video/mp4", url: VIDEO_DATA }],
		};
		// The model returns the full 10 s of edited source.
		const { services: generation } = services(bridge, { duration: 10 });
		const source = asset("video", { duration: 20 });
		// 10 s of source at 2x: 5 s on the timeline.
		const segment = {
			...newSegment(source, 3, 0),
			sourceIn: 0,
			sourceOut: 10,
			speed: 2,
		};
		const placements: Record<string, unknown>[] = [];
		await runVideoToVideo({
			asset: source,
			choice: presetChoice(v2vPreset),
			place: async (placement) => {
				placements.push(placement);
				return true;
			},
			projectId: PROJECT,
			prompt: "Make it rain",
			segment,
			services: generation,
		});
		expect(placements[0]).toMatchObject({ at: 3, sourceOut: 10, speed: 2 });
		const placed = placements[0] as { sourceOut: number; speed: number };
		expect(placed.sourceOut / placed.speed).toBe(5);
	});

	test("AI matte on a 2x clip replaces exactly the clip's timeline length", async () => {
		const source = asset("video", { duration: 20 });
		const derivative = asset("video", { derivation: "ai-matte", duration: 10 });
		installSidecar({ [`/assets/${source.id}/ai-matte`]: () => derivative });
		const bridge: MediaBridge = {
			video: async () => [{ mediaType: "video/mp4", url: VIDEO_DATA }],
		};
		const { services: generation } = services(bridge, { duration: 10 });
		const segment = {
			...newSegment(source, 0, 0),
			sourceIn: 0,
			sourceOut: 10,
			speed: 2,
		};
		const placements: Record<string, unknown>[] = [];
		await runAiMatte({
			asset: source,
			choice: presetChoice(mattePreset),
			place: async (placement) => {
				placements.push(placement);
				return true;
			},
			projectId: PROJECT,
			segment,
			services: generation,
		});
		expect(placements[0]).toMatchObject({
			assetId: derivative.id,
			at: 0,
			sourceOut: 10,
			speed: 2,
		});
	});

	test("a speed ramp or an unplaceable speed is refused before anything is sent", async () => {
		const { calls } = installSidecar({});
		const sent: unknown[] = [];
		const bridge: MediaBridge = {
			video: async (input) => {
				sent.push(input);
				return [];
			},
		};
		const { recorded, services: generation } = services(bridge);
		const source = asset("video");
		const ramped = {
			...newSegment(source),
			speedCurve: {
				points: [
					{ speed: 1, t: 0 },
					{ speed: 2, t: 1 },
				],
			},
		};
		await expect(
			runAiMatte({
				asset: source,
				choice: presetChoice(mattePreset),
				projectId: PROJECT,
				segment: ramped,
				services: generation,
			})
		).rejects.toThrow("speed ramp");
		await expect(
			runVideoToVideo({
				asset: source,
				choice: presetChoice(v2vPreset),
				projectId: PROJECT,
				prompt: "x",
				segment: { ...newSegment(source), speed: 8 },
				services: generation,
			})
		).rejects.toThrow("Change this clip's speed first");
		expect(sent).toEqual([]);
		expect(recorded).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("placement carries the speed and a stamp of the input timeline", () => {
		const source = asset("video");
		const clip = { ...newSegment(source, 2, 0), sourceOut: 6 };
		const inputs = { ...newProject("Stamp"), segments: [clip] };
		const { body, options } = overwritePlacementEdit(inputs, {
			assetId: source.id,
			at: 2,
			sourceOut: 6,
			speed: 2,
			track: 0,
		});
		expect(body).toEqual({
			at: 2,
			entries: [{ assetId: source.id, sourceIn: 0, sourceOut: 6, speed: 2 }],
			track: 0,
		});
		const moved = { ...inputs, segments: [{ ...clip, start: 4 }] };
		expect(planIsCurrent(options.planStamp, inputs)).toBe(true);
		expect(planIsCurrent(options.planStamp, moved)).toBe(false);
	});
});

describe("AI matte", () => {
	test("a still goes through media.image with the still inlined in provider_input", async () => {
		const derivative = asset("image", { derivation: "ai-matte" });
		const { calls } = installSidecar({});
		const still = asset("image");
		calls.length = 0;
		const window_ = window as unknown as {
			ryu: { app: { request: (i: { path: string }) => Promise<unknown> } };
		};
		const base = window_.ryu.app.request;
		window_.ryu.app.request = async (input) =>
			input.path === `/assets/${still.id}/ai-matte` ? derivative : base(input);
		const sent: unknown[] = [];
		const bridge: MediaBridge = {
			image: async (input) => {
				sent.push(input);
				return [PNG_DATA];
			},
		};
		const { services: generation } = services(bridge);
		const preset = presetFor("matte-image");
		if (!preset) {
			throw new Error("missing preset");
		}
		const swapped: string[] = [];
		const result = await runAiMatte({
			asset: still,
			choice: presetChoice(preset),
			projectId: PROJECT,
			segment: newSegment(still),
			services: generation,
			swapStill: async (_clip, output) => {
				swapped.push(output.id);
				return true;
			},
		});
		expect(sent[0]).toMatchObject({
			model: "fal-ai/birefnet/v2",
			provider_input: { image_url: PNG_DATA },
		});
		expect(sent[0]).not.toHaveProperty("input_images");
		expect(result.output?.id).toBe(derivative.id);
		expect(swapped).toEqual([derivative.id]);
	});
});

describe("Photoreal (cloud)", () => {
	test("consent is required before anything is prepared", async () => {
		const { calls } = installSidecar({});
		const { recorded, services: generation } = services({
			video: async () => [],
		});
		const preset = presetFor("lipsync");
		if (!preset) {
			throw new Error("missing preset");
		}
		await expect(
			runPhotoreal({
				audioClipId: crypto.randomUUID(),
				choice: presetChoice(preset),
				consent: false,
				mode: "lipsync",
				pictureClipId: crypto.randomUUID(),
				project: newProject("P"),
				services: generation,
			})
		).rejects.toThrow(LIKENESS_CONSENT_NOTICE);
		expect(calls).toEqual([]);
		expect(recorded).toEqual([]);
	});

	test("lip-sync sends input_video and input_audio and places the result muted", async () => {
		installSidecar({});
		const sent: unknown[] = [];
		const { recorded, services: generation } = services({
			video: async (input) => {
				sent.push(input);
				return [{ mediaType: "video/mp4", url: VIDEO_DATA }];
			},
		});
		const preset = presetFor("lipsync");
		if (!preset) {
			throw new Error("missing preset");
		}
		const placements: unknown[] = [];
		await runPhotoreal({
			audioClipId: crypto.randomUUID(),
			choice: presetChoice(preset),
			consent: true,
			mode: "lipsync",
			pictureClipId: crypto.randomUUID(),
			place: async (placement) => {
				placements.push(placement);
				return true;
			},
			project: newProject("P"),
			services: generation,
		});
		expect(sent[0]).toMatchObject({
			input_audio: AUDIO_DATA,
			input_video: VIDEO_DATA,
			provider_input: { audio_url: "$input_audio", video_url: "$input_video" },
		});
		expect(recorded[0]).toMatchObject({
			consent: "subjects-agreed",
			task: "lipsync",
		});
		expect(placements[0]).toMatchObject({
			at: 1,
			sourceOut: 2.5,
			track: 0,
			volume: 0,
		});
	});

	test("an avatar sends the frame as input_images[0] with the audio", async () => {
		installSidecar({});
		const sent: { input_images?: string[] }[] = [];
		const { services: generation } = services({
			video: async (input) => {
				sent.push(input);
				return [{ mediaType: "video/mp4", url: VIDEO_DATA }];
			},
		});
		const preset = presetFor("avatar");
		if (!preset) {
			throw new Error("missing preset");
		}
		await runPhotoreal({
			audioClipId: crypto.randomUUID(),
			choice: presetChoice(preset),
			consent: true,
			mode: "avatar",
			pictureClipId: crypto.randomUUID(),
			project: newProject("P"),
			services: generation,
		});
		expect(sent[0]?.input_images).toEqual([PNG_DATA]);
		expect(sent[0]).toMatchObject({ input_audio: AUDIO_DATA });
	});
});

describe("Generate motion", () => {
	test("both exact boundary frames go to a first/last-frame model, then the gap-fill route", async () => {
		installSidecar({});
		const sent: { input_images?: string[] }[] = [];
		const { recorded, services: generation } = services({
			video: async (input) => {
				sent.push(input);
				return [{ mediaType: "video/mp4", url: VIDEO_DATA }];
			},
		});
		const source = asset("video");
		const a = { ...newSegment(source, 0), sourceOut: 2 };
		const b = { ...newSegment(source, 3), sourceIn: 2, sourceOut: 4 };
		const project = { ...newProject("Gap"), segments: [a, b] };
		const preset = presetFor("flf");
		if (!preset) {
			throw new Error("missing preset");
		}
		const placed: unknown[] = [];
		const result = await runGapFillMotion({
			assets: [source],
			choice: presetChoice(preset),
			clipId: a.id,
			place: async (placement) => {
				placed.push(placement);
				return "clip-1";
			},
			project,
			services: generation,
		});
		expect(sent[0]?.input_images).toEqual([PNG_DATA, PNG_DATA]);
		expect(sent[0]).not.toHaveProperty("duration_s");
		expect(recorded[0]).toMatchObject({ durationSeconds: 1, task: "flf" });
		expect(placed[0]).toEqual({ afterClipId: a.id, assetId: result.asset.id });
		expect(result.placedClipId).toBe("clip-1");
	});

	test("the local engine choice sends both frames with no model or field map", async () => {
		installSidecar({});
		const sent: Record<string, unknown>[] = [];
		const { recorded, services: generation } = services({
			video: async (input) => {
				sent.push(input);
				return [{ mediaType: "video/webm", url: VIDEO_DATA }];
			},
		});
		const source = asset("video");
		const a = { ...newSegment(source, 0), sourceOut: 2 };
		const b = { ...newSegment(source, 3), sourceIn: 2, sourceOut: 4 };
		const project = { ...newProject("Gap"), segments: [a, b] };
		await runGapFillMotion({
			assets: [source],
			choice: localEngineChoice(),
			clipId: a.id,
			place: async () => "clip-1",
			project,
			services: generation,
		});
		expect(sent[0]).toMatchObject({
			input_images: [PNG_DATA, PNG_DATA],
			provider: "local",
		});
		expect(sent[0]).not.toHaveProperty("model");
		expect(sent[0]).not.toHaveProperty("provider_input");
		expect(recorded[0]).toMatchObject({
			provider: "local",
			route: "local",
			task: "flf",
		});
		expect(recorded[0]?.providerInput).toBeUndefined();
	});

	test("a local engine refusal is surfaced as given and recorded", async () => {
		installSidecar({});
		const refusal =
			"the active local video model is text-to-video only and cannot start from an image";
		const { outcomes, services: generation } = services({
			video: async () => {
				throw new Error(refusal);
			},
		});
		const source = asset("video");
		const a = { ...newSegment(source, 0), sourceOut: 2 };
		const b = { ...newSegment(source, 3), sourceIn: 2, sourceOut: 4 };
		const project = { ...newProject("Gap"), segments: [a, b] };
		await expect(
			runGapFillMotion({
				assets: [source],
				choice: localEngineChoice(),
				clipId: a.id,
				place: async () => "clip-1",
				project,
				services: generation,
			})
		).rejects.toThrow(refusal);
		expect(outcomes[0]).toMatchObject({ status: "incomplete" });
	});

	test("a gap wider than the local clip can fill is refused before anything runs", async () => {
		const sidecar = installSidecar({});
		const sent: unknown[] = [];
		const {
			admitted,
			recorded,
			services: generation,
		} = services({
			video: async (input) => {
				sent.push(input);
				return [{ mediaType: "video/webm", url: VIDEO_DATA }];
			},
		});
		const source = asset("video");
		const a = { ...newSegment(source, 0), sourceOut: 2 };
		// A 30 s gap: wider than the ~2.06 s local clip slowed to 10%.
		const b = { ...newSegment(source, 32), sourceIn: 2, sourceOut: 4 };
		const project = { ...newProject("Gap"), segments: [a, b] };
		expect(motionGapRefusal(30, project.fps)).toBeUndefined();
		await expect(
			runGapFillMotion({
				assets: [source],
				choice: localEngineChoice(),
				clipId: a.id,
				place: async () => "clip-1",
				project,
				services: generation,
			})
		).rejects.toThrow("fills gaps up to 20.6 s");
		expect(sent).toEqual([]);
		expect(recorded).toEqual([]);
		expect(admitted).toEqual([]);
		expect(
			sidecar.calls.some((call) => call.path.endsWith("/gap-fill-frames"))
		).toBe(false);
	});

	test("tasks without a local model refuse the local engine choice", () => {
		expect(() => assertTaskChoice("v2v", localEngineChoice())).toThrow(
			"has no local model"
		);
		expect(assertTaskChoice("flf", localEngineChoice())).toBe(true);
	});
});

describe("Generated music and sound effects", () => {
	test("music goes to media.audio with the duration mapped, then is fitted", async () => {
		const fitted = asset("audio", { duration: 8 });
		const { calls } = installSidecar({ "/soundtrack-conform": () => fitted });
		const sent: unknown[] = [];
		const { services: generation } = services({
			audio: async (input) => {
				sent.push(input);
				return [
					{ mediaType: "audio/mpeg", url: "data:audio/mpeg;base64,SUQz" },
				];
			},
		});
		const preset = presetFor("music");
		if (!preset) {
			throw new Error("missing preset");
		}
		const result = await runGeneratedAudio({
			choice: presetChoice(preset),
			duration: 8,
			music: { bpm: 96, mood: "warm" },
			projectId: PROJECT,
			services: generation,
		});
		expect(sent[0]).toMatchObject({
			duration_s: 8,
			kind: "music",
			model: "fal-ai/stable-audio",
			provider_input: { seconds_total: "$duration_s" },
		});
		expect(calls.at(-1)).toMatchObject({
			body: { assetId: result.asset.id, duration: 8 },
			path: "/soundtrack-conform",
		});
		expect(result.output.id).toBe(fitted.id);
	});

	test("a sound effect carries its prompt in the model's text field", async () => {
		installSidecar({ "/sfx-conform": () => asset("audio") });
		const sent: { provider_input?: Record<string, unknown> }[] = [];
		const { services: generation } = services({
			audio: async (input) => {
				sent.push(input);
				return [
					{ mediaType: "audio/mpeg", url: "data:audio/mpeg;base64,SUQz" },
				];
			},
		});
		const preset = presetFor("sfx");
		if (!preset) {
			throw new Error("missing preset");
		}
		await runGeneratedAudio({
			choice: presetChoice(preset),
			description: "glass shattering",
			duration: 2,
			projectId: PROJECT,
			services: generation,
			sfxKind: "impact",
		});
		expect(sent[0]?.provider_input).toMatchObject({
			duration_seconds: "$duration_s",
			text: expect.stringContaining("glass shattering"),
		});
	});

	test("no audio bridge: the panel's reason names the local fallback", async () => {
		installSidecar({});
		const { services: generation } = services({});
		const preset = presetFor("music");
		if (!preset) {
			throw new Error("missing preset");
		}
		await expect(
			runGeneratedAudio({
				choice: presetChoice(preset),
				duration: 4,
				music: { bpm: 96, mood: "warm" },
				projectId: PROJECT,
				services: generation,
			})
		).rejects.toThrow("local score");
	});
});

describe("vision shot descriptions", () => {
	test("keyframes go to model.complete as images and descriptions are stored", async () => {
		const stored: unknown[] = [];
		const assetId = crypto.randomUUID();
		installSidecar({
			[`/assets/${assetId}/shots/descriptions`]: (body) => {
				stored.push(body);
				return {};
			},
			[`/assets/${assetId}/shots/keyframes`]: () => ({
				analysisCreatedAt: "2026-01-01T00:00:00.000Z",
				keyframes: [
					{
						end: 2,
						frame: 25,
						image: "data:image/jpeg;base64,/9j/",
						index: 0,
						start: 0,
					},
				],
				revision: 3,
				total: 1,
			}),
		});
		const prompts: { images?: string[]; prompt: string }[] = [];
		const count = await describeShotsWithVision({
			assetId,
			complete: async (input) => {
				prompts.push(input);
				return '{"shots":[{"index":0,"caption":"A cat.","tags":["cat"]}]}';
			},
			model: "vision-model",
		});
		expect(count).toBe(1);
		expect(prompts[0]?.images).toEqual(["data:image/jpeg;base64,/9j/"]);
		expect(stored[0]).toMatchObject({
			model: "vision-model",
			revision: 3,
			shots: [{ index: 0 }],
		});
	});

	test("a model that cannot read images is named as such", () => {
		expect(
			visionErrorMessage(
				new Error("Upstream: this model does not support image input")
			)
		).toContain("selected model cannot read images");
		expect(visionErrorMessage(new Error("rate limited"))).toBe("rate limited");
	});
});
