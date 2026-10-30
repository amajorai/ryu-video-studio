import { describe, expect, test } from "bun:test";
import type { GenerationRequest } from "../../../shared/generation.ts";
import { type Asset, newProject, newSegment } from "../../../shared/project.ts";
import type { ScriptScene } from "../../../shared/script-to-video.ts";
import type { StockSearchResult } from "../../../shared/stock.ts";
import type { GenerationServices } from "../ai/media-bridge.ts";
import {
	assembleBody,
	assembledSpan,
	draftsFor,
	isVisualStockResult,
	planScript,
	produceScene,
	type SceneDraft,
	type ScriptPipelineServices,
	scoreAssembledScript,
} from "./script-to-video-pipeline.ts";

const projectId = crypto.randomUUID();

function asset(kind: Asset["kind"], name: string): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: kind === "image" ? 0 : 2,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 1280,
	};
}

function stockResult(identifier: string, format: string): StockSearchResult {
	return {
		attribution: "Someone",
		duration: null,
		format,
		identifier,
		provider: "openverse.image",
		rights: "CC BY",
		sizeBytes: null,
		sourceUrl: "https://example.org/item",
		title: identifier,
	};
}

/** Fake generation services: a data URL per kind, recorded calls. */
function fakeGeneration(log: string[], failKinds = new Set<string>()) {
	const uploaded: Asset[] = [];
	const media: GenerationServices = {
		admit: () => Promise.resolve(),
		bridge: {
			image: (input) => {
				log.push(`image:${input.prompt}`);
				return Promise.resolve(["data:image/png;base64,iVBORw0KGgo="]);
			},
			tts: (input) => {
				log.push(`tts:${input.text}`);
				if (failKinds.has("audio")) {
					return Promise.reject(new Error("voice unavailable"));
				}
				return Promise.resolve("data:audio/wav;base64,UklGRg==");
			},
		},
		finish: (_id, outcome) => {
			log.push(`finish:${outcome.status}`);
			return Promise.resolve();
		},
		readImage: () => Promise.resolve(""),
		record: (generation: GenerationRequest) => {
			log.push(`record:${generation.kind}`);
			return Promise.resolve();
		},
		upload: (file) => {
			const kind = file.type.startsWith("audio") ? "audio" : "image";
			const result = asset(kind, file.name);
			uploaded.push(result);
			return Promise.resolve(result);
		},
	};
	return { media, uploaded };
}

const scene: ScriptScene = {
	imagePrompt: "A lighthouse at dusk.",
	narration: "The lighthouse wakes at dusk.",
	visualQuery: "lighthouse dusk",
};

describe("planning", () => {
	test("uses the model when available and the local splitter otherwise", async () => {
		const prompts: string[] = [];
		const viaModel = await planScript("One. Two.", (input) => {
			prompts.push(input.system);
			return Promise.resolve(
				JSON.stringify({ scenes: [{ narration: "One. Two." }] })
			);
		});
		expect(viaModel.source).toBe("model");
		expect(viaModel.scenes).toHaveLength(1);
		expect(prompts[0]).toContain("visualQuery");
		const local = await planScript("First part.\n\nSecond part.", undefined);
		expect(local.source).toBe("local");
		expect(local.scenes.map((item) => item.narration)).toEqual([
			"First part.",
			"Second part.",
		]);
	});
});

describe("production", () => {
	test("narrates, transcribes, and imports a stock visual in order", async () => {
		const log: string[] = [];
		const { media } = fakeGeneration(log);
		const visual = asset("video", "stock.mp4");
		const added: string[] = [];
		const transcribed: string[] = [];
		const services: ScriptPipelineServices = {
			generation: media,
			importStock: (result) => {
				log.push(`import:${result.identifier}`);
				return Promise.resolve(visual);
			},
			onAsset: (item) => added.push(item.name),
			searchStock: (provider, query) => {
				log.push(`search:${provider}:${query}`);
				return Promise.resolve([
					stockResult("song", "MP3 audio"),
					stockResult("clip", "MP4 video"),
				]);
			},
			transcribe: (id) => {
				transcribed.push(id);
				log.push("transcribe");
				return Promise.resolve();
			},
		};
		const [draft] = draftsFor([scene], () => "scene-1");
		const steps: SceneDraft["step"][] = [];
		const result = await produceScene(
			projectId,
			draft as SceneDraft,
			{ provider: "openverse.image", visualSource: "stock", voice: "alto" },
			services,
			(next) => steps.push(next.step)
		);
		expect(result.status).toBe("ready");
		expect(result.transcribed).toBe(true);
		expect(result.visualAssetId).toBe(visual.id);
		expect(log).toEqual([
			"record:audio",
			"tts:The lighthouse wakes at dusk.",
			"finish:completed",
			"transcribe",
			"search:openverse.image:lighthouse dusk",
			"import:clip",
		]);
		expect(transcribed).toEqual([result.narrationAssetId ?? ""]);
		expect(steps).toContain("transcript");
		expect(added).toHaveLength(2);
	});

	test("a failed step keeps earlier results and a retry resumes there", async () => {
		const log: string[] = [];
		const { media } = fakeGeneration(log);
		let stockAvailable = false;
		const services: ScriptPipelineServices = {
			generation: media,
			importStock: () => Promise.resolve(asset("image", "photo.jpg")),
			searchStock: () =>
				Promise.resolve(stockAvailable ? [stockResult("photo", "JPEG")] : []),
			transcribe: () => Promise.reject(new Error("no words")),
		};
		const [draft] = draftsFor([scene]);
		const options = {
			provider: "openverse.image" as const,
			visualSource: "stock" as const,
			voice: "",
		};
		const failed = await produceScene(
			projectId,
			draft as SceneDraft,
			options,
			services
		);
		expect(failed.status).toBe("failed");
		expect(failed.step).toBe("visual");
		expect(failed.error).toContain("No stock visuals matched");
		expect(failed.narrationAssetId).toBeDefined();
		expect(failed.transcriptNote).toContain("estimated timing");
		stockAvailable = true;
		const retried = await produceScene(projectId, failed, options, services);
		expect(retried.status).toBe("ready");
		expect(retried.narrationAssetId).toBe(failed.narrationAssetId);
		// Narration was generated once.
		expect(log.filter((entry) => entry === "record:audio")).toHaveLength(1);
	});

	test("generated visuals go through an image generation", async () => {
		const log: string[] = [];
		const { media } = fakeGeneration(log);
		const services: ScriptPipelineServices = {
			generation: media,
			importStock: () => Promise.reject(new Error("unused")),
			searchStock: () => Promise.reject(new Error("unused")),
		};
		const [draft] = draftsFor([scene]);
		const result = await produceScene(
			projectId,
			draft as SceneDraft,
			{ provider: "openverse.image", visualSource: "generated", voice: "" },
			services
		);
		expect(result.status).toBe("ready");
		expect(result.transcribed).toBe(false);
		expect(log).toContain("image:A lighthouse at dusk.");
		expect(log.filter((entry) => entry.startsWith("record:"))).toEqual([
			"record:audio",
			"record:image",
		]);
	});

	test("narration failures are reported on the scene", async () => {
		const log: string[] = [];
		const { media } = fakeGeneration(log, new Set(["audio"]));
		const [draft] = draftsFor([scene]);
		const result = await produceScene(
			projectId,
			draft as SceneDraft,
			{ provider: "openverse.image", visualSource: "generated", voice: "" },
			{
				generation: media,
				importStock: () => Promise.reject(new Error("unused")),
				searchStock: () => Promise.reject(new Error("unused")),
			}
		);
		expect(result).toMatchObject({
			error: "voice unavailable",
			status: "failed",
			step: "narration",
		});
		expect(log).toContain("finish:incomplete");
	});
});

describe("assembly body", () => {
	test("lists scenes in order with the caption settings", () => {
		const ready: SceneDraft[] = [
			{
				id: "a",
				narrationAssetId: "n1",
				scene,
				status: "ready",
				visualAssetId: "v1",
			},
		];
		expect(assembleBody(ready, { captions: "words", gap: 0.5 })).toEqual({
			captionChunking: { mode: "words" },
			gap: 0.5,
			scenes: [
				{
					narrationAssetId: "n1",
					text: scene.narration,
					visualAssetId: "v1",
				},
			],
		});
		// The project's saved limits and filters survive a new mode.
		expect(
			assembleBody(ready, {
				captions: "segments",
				chunking: { maxWords: 3, mode: "words", profanity: "mask" },
				gap: 0,
			}).captionChunking
		).toEqual({ maxWords: 3, mode: "segments", profanity: "mask" });
		expect(assembleBody(ready, { captions: "none", gap: 0 })).toMatchObject({
			captions: false,
		});
		expect(() =>
			assembleBody([{ id: "b", scene, status: "pending" }], {
				captions: "words",
				gap: 0,
			})
		).toThrow("Scene 1 still needs narration and a visual.");
	});

	test("adds the presenter preset", () => {
		const ready: SceneDraft[] = [
			{
				id: "a",
				narrationAssetId: "n1",
				scene,
				status: "ready",
				visualAssetId: "v1",
			},
		];
		expect(
			assembleBody(ready, { avatar: "corner", captions: "none", gap: 0 })
		).toMatchObject({ avatar: { preset: "corner" }, captions: false });
	});

	test("audio stock results are not offered as visuals", () => {
		expect(isVisualStockResult(stockResult("x", "MP3 audio"))).toBe(false);
		expect(isVisualStockResult(stockResult("x", "MP4 video"))).toBe(true);
	});
});

describe("music bed", () => {
	const span = {
		duration: 6,
		scenes: [
			{ end: 3, start: 10 },
			{ end: 16, start: 13 },
		],
	};

	test("reads the assembled span from the route extras", () => {
		expect(assembledSpan({ ...span, captions: 2 })).toEqual(span);
		expect(assembledSpan({ duration: 0, scenes: [] })).toBeUndefined();
	});

	test("plans locally without a model: style by keyword, sections at scenes", async () => {
		const bodies: unknown[] = [];
		const music = asset("audio", "bed.wav");
		const scored = await scoreAssembledScript({
			assets: [],
			create: (body) => {
				bodies.push(body);
				return Promise.resolve(music);
			},
			music: { description: "epic and dramatic" },
			project: newProject("Bed"),
			span,
		});
		expect(scored).toEqual({ asset: music, planner: "local" });
		expect(bodies[0]).toMatchObject({
			duration: 6,
			mood: "cinematic",
			sections: [
				{ end: 3, start: 0 },
				{ end: 6, start: 3 },
			],
		});
	});

	test("uses Ryu's plan for a description, keeping an explicit style", async () => {
		const narration = { ...asset("audio", "voice.wav"), duration: 16 };
		const assembled = {
			...newProject("Bed"),
			segments: [newSegment(narration, 0, 1)],
		};
		const bodies: unknown[] = [];
		const prompts: string[] = [];
		const scored = await scoreAssembledScript({
			assets: [],
			complete: (input) => {
				prompts.push(input.prompt);
				return Promise.resolve(
					JSON.stringify({
						bpm: 100,
						sections: [{ end: 6, intensity: 0.4, start: 0 }],
						style: "ambient",
					})
				);
			},
			create: (body) => {
				bodies.push(body);
				return Promise.resolve(asset("audio", "planned.wav"));
			},
			music: { description: "soft piano", mood: "warm" },
			project: assembled,
			span,
		});
		expect(scored.planner).toBe("model");
		expect(prompts[0]).toContain("soft piano");
		expect(bodies[0]).toMatchObject({ bpm: 100, duration: 6, mood: "warm" });
	});

	test("falls back to the local plan when Ryu's plan fails", async () => {
		const scored = await scoreAssembledScript({
			assets: [],
			complete: () => Promise.resolve("not json"),
			create: () => Promise.resolve(asset("audio", "bed.wav")),
			music: { description: "calm" },
			project: newProject("Bed"),
			span,
		});
		expect(scored.planner).toBe("local");
		expect(scored.note).toContain("local plan was used");
	});
});
