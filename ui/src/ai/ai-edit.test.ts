import { describe, expect, test } from "bun:test";
import { freezeFrame } from "../../../shared/freeze-frame.ts";
import {
	type GenerationJob,
	generationJobSchema,
	generationRequestSchema,
} from "../../../shared/generation.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import {
	aiEditAvailability,
	aiEditClip,
	EDIT_FRAME_HOLD_SECONDS,
	editFrameAsStill,
	insertedStillSegment,
	regenerateClip,
	swapGeneratedMedia,
	swapStillMedia,
} from "./ai-edit.ts";
import type { GenerationServices, MediaBridge } from "./media-bridge.ts";
import {
	referenceCandidates,
	toggleReference,
} from "./ReferenceImagePicker.tsx";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function media(kind: Asset["kind"], name: string, duration = 5): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: 720,
		id: crypto.randomUUID(),
		kind,
		name,
		width: 1280,
	};
}

/**
 * An in-memory library and timeline: generated media is "uploaded" into
 * `assets` (stills with the sidecar's nominal 5 s image duration), and swaps
 * run the same edits the inspector applies on `project`.
 */
function harness(project: Project, initial: Asset[]) {
	const state = { assets: [...initial], project };
	const hostInputs: unknown[] = [];
	const bridge: MediaBridge = {
		image: async (input) => {
			hostInputs.push(input);
			return [PNG];
		},
		video: async (input) => {
			hostInputs.push(input);
			return [{ mediaType: "video/mp4", url: "data:video/mp4;base64,AAAA" }];
		},
	};
	const services: GenerationServices = {
		admit: async () => undefined,
		bridge,
		finish: async () => undefined,
		readImage: async (asset) => `data:image/png;base64,${btoa(asset.id)}`,
		record: async () => undefined,
		upload: async (file) => {
			const asset = file.type.startsWith("video")
				? media("video", file.name, 30)
				: media("image", file.name, 5);
			state.assets.push(asset);
			return asset;
		},
	};
	const swap = async (clipId: string, asset: Asset) => {
		state.project = swapGeneratedMedia(
			state.project,
			state.assets,
			clipId,
			asset
		);
		return true;
	};
	return { bridge, hostInputs, services, state, swap };
}

function completedJob(
	request: Parameters<typeof generationRequestSchema.parse>[0],
	assetIds: string[]
): GenerationJob {
	const parsed = generationRequestSchema.parse(request);
	return generationJobSchema.parse({
		assetIds,
		createdAt: "2026-01-01T00:00:00.000Z",
		id: parsed.id,
		message: "",
		projectRevision: 0,
		request: parsed,
		status: "completed",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
}

describe("aiEditAvailability", () => {
	test("offers edit for images, edit-frame for video, regenerate for generated media", () => {
		const still = media("image", "still");
		const clip = media("video", "clip");
		const voice = media("audio", "vo");
		const assets = [still, clip, voice];
		const job = completedJob(
			{
				id: crypto.randomUUID(),
				kind: "audio",
				projectId: crypto.randomUUID(),
				prompt: "Hello",
			},
			[voice.id]
		);
		expect(
			aiEditAvailability(newSegment(still, 0), assets, [job])
		).toMatchObject({ edit: true, editFrame: false, regenerate: false });
		expect(
			aiEditAvailability(newSegment(clip, 0), assets, [job])
		).toMatchObject({ edit: false, editFrame: true, regenerate: false });
		const narration = aiEditAvailability(newSegment(voice, 0), assets, [job]);
		expect(narration).toMatchObject({
			edit: false,
			editFrame: false,
			regenerate: true,
		});
		expect(narration.provenance?.prompt).toBe("Hello");
	});

	test("offers nothing for missing media or nested sequences", () => {
		const nested = {
			...media("video", "nest"),
			sequenceProjectId: crypto.randomUUID(),
		};
		expect(aiEditAvailability(newSegment(nested, 0), [nested], [])).toEqual({
			edit: false,
			editFrame: false,
			regenerate: false,
		});
		expect(aiEditAvailability(newSegment(nested, 0), [], [])).toEqual({
			edit: false,
			editFrame: false,
			regenerate: false,
		});
	});
});

describe("aiEditClip swap chain", () => {
	test("edits an image clip and swaps the result in, keeping its treatment", async () => {
		const still = media("image", "poster.png");
		const reference = media("image", "style.png");
		const segment = {
			...newSegment(still, 2),
			opacity: 0.8,
			rotation: 12,
			scale: 1.4,
			sourceOut: 3,
			x: 0.1,
		};
		const project = { ...newProject("AI edit"), segments: [segment] };
		const { hostInputs, services, state, swap } = harness(project, [
			still,
			reference,
		]);
		const result = await aiEditClip({
			assets: state.assets,
			model: "edit-model",
			projectId: project.id,
			prompt: "  Turn day into night  ",
			referenceIds: [reference.id, still.id],
			segment,
			services,
			swap,
		});
		expect(result.swappedClipId).toBe(segment.id);
		expect(hostInputs[0]).toMatchObject({
			input_images: [
				`data:image/png;base64,${btoa(still.id)}`,
				`data:image/png;base64,${btoa(reference.id)}`,
			],
			model: "edit-model",
			prompt: "Turn day into night",
		});
		const swapped = state.project.segments[0];
		expect(swapped?.assetId).toBe(result.asset.id);
		expect(swapped).toMatchObject({
			opacity: 0.8,
			rotation: 12,
			scale: 1.4,
			sourceIn: 0,
			sourceOut: 3,
			start: 2,
			x: 0.1,
		});
		expect(result.asset.name).toBe("AI edit — Turn day into night.png");
	});

	test("keeps a still longer than the new image's nominal duration", async () => {
		const still = media("image", "title-card.png");
		const segment = { ...newSegment(still, 1), sourceIn: 2, sourceOut: 12 };
		const after = newSegment(still, 11);
		const project = { ...newProject("Long still"), segments: [segment, after] };
		const { services, state, swap } = harness(project, [still]);
		const result = await aiEditClip({
			assets: state.assets,
			projectId: project.id,
			prompt: "Warmer",
			segment,
			services,
			swap,
		});
		expect(result.asset.duration).toBe(5);
		expect(state.project.segments[0]).toMatchObject({
			assetId: result.asset.id,
			sourceIn: 2,
			sourceOut: 12,
			start: 1,
		});
		expect(state.project.segments[1]).toEqual(after);
	});

	test("reports the saved media when the swap is refused", async () => {
		const still = media("image", "poster.png");
		const segment = newSegment(still, 0);
		const project = { ...newProject("Refused"), segments: [segment] };
		const { services, state } = harness(project, [still]);
		const result = await aiEditClip({
			assets: state.assets,
			projectId: project.id,
			prompt: "Brighter",
			segment,
			services,
			swap: async () => false,
		});
		expect(result.swappedClipId).toBeUndefined();
		expect(state.assets.some((asset) => asset.id === result.asset.id)).toBe(
			true
		);
	});

	test("refuses video clips, blank directions, and too many references", async () => {
		const clip = media("video", "clip.mp4");
		const still = media("image", "still.png");
		const refs = Array.from({ length: 5 }, (_, index) =>
			media("image", `${index}.png`)
		);
		const project = newProject("Refusals");
		const { services, swap } = harness(project, [clip, still, ...refs]);
		const base = {
			assets: [clip, still, ...refs],
			projectId: project.id,
			services,
			swap,
		};
		await expect(
			aiEditClip({ ...base, prompt: "x", segment: newSegment(clip, 0) })
		).rejects.toThrow("still image clips");
		await expect(
			aiEditClip({ ...base, prompt: "  ", segment: newSegment(still, 0) })
		).rejects.toThrow("Describe the change");
		await expect(
			aiEditClip({
				...base,
				prompt: "x",
				referenceIds: refs.map((asset) => asset.id),
				segment: newSegment(still, 0),
			})
		).rejects.toThrow("at most 4");
	});
});

describe("regenerateClip", () => {
	test("re-requests the recorded generation and swaps the new media in", async () => {
		const generated = media("video", "Generated video — Waves.mp4", 4);
		const segment = { ...newSegment(generated, 0), sourceOut: 4 };
		const project = { ...newProject("Regenerate"), segments: [segment] };
		const job = completedJob(
			{
				id: crypto.randomUUID(),
				kind: "video",
				model: "veo",
				projectId: project.id,
				prompt: "Waves",
				provider: "cloud",
			},
			[generated.id]
		);
		const { hostInputs, services, state, swap } = harness(project, [generated]);
		const result = await regenerateClip({
			assets: state.assets,
			jobs: [job],
			projectId: project.id,
			segment,
			services,
			swap,
		});
		expect(hostInputs[0]).toMatchObject({
			model: "veo",
			prompt: "Waves",
			provider: "cloud",
		});
		expect(result.asset.name).toBe("Regenerated — Waves.mp4");
		expect(state.project.segments[0]?.assetId).toBe(result.asset.id);
	});

	test("regenerating a long still keeps its length", async () => {
		const generated = media("image", "Generated image — Fox.png");
		const segment = { ...newSegment(generated, 0), sourceOut: 9 };
		const project = { ...newProject("Regenerate still"), segments: [segment] };
		const job = completedJob(
			{
				id: crypto.randomUUID(),
				kind: "image",
				projectId: project.id,
				prompt: "Fox",
			},
			[generated.id]
		);
		const { services, state, swap } = harness(project, [generated]);
		const result = await regenerateClip({
			assets: state.assets,
			jobs: [job],
			projectId: project.id,
			segment,
			services,
			swap,
		});
		expect(state.project.segments[0]).toMatchObject({
			assetId: result.asset.id,
			sourceIn: 0,
			sourceOut: 9,
		});
	});

	test("refuses media with no recorded generation", async () => {
		const plain = media("image", "plain.png");
		const project = newProject("Plain");
		const { services, swap } = harness(project, [plain]);
		await expect(
			regenerateClip({
				assets: [plain],
				jobs: [],
				projectId: project.id,
				segment: newSegment(plain, 0),
				services,
				swap,
			})
		).rejects.toThrow("no generation request");
	});
});

describe("editFrameAsStill", () => {
	test("freezes the frame at the playhead, edits it, and swaps it into the freeze", async () => {
		const clip = media("video", "interview.mp4", 10);
		const segment = { ...newSegment(clip, 0), sourceOut: 10 };
		const project = { ...newProject("Frame"), segments: [segment] };
		const { hostInputs, services, state, swap } = harness(project, [clip]);
		let frozenStill: Asset | undefined;
		const freeze = async () => {
			const before = state.project;
			frozenStill = media("image", "Frame at 4.00s");
			state.assets.push(frozenStill);
			state.project = freezeFrame(
				before,
				state.assets,
				{
					at: 4,
					clipId: segment.id,
					duration: EDIT_FRAME_HOLD_SECONDS,
					mode: "insert",
					revision: before.revision,
				},
				frozenStill
			);
			const inserted = insertedStillSegment(before, state.project);
			return inserted
				? { assets: [...state.assets], segment: inserted }
				: undefined;
		};
		const result = await editFrameAsStill({
			assets: state.assets,
			freeze,
			projectId: project.id,
			prompt: "Add a halo",
			segment,
			services,
			swap,
		});
		expect(frozenStill).toBeDefined();
		expect(hostInputs[0]).toMatchObject({
			input_images: [`data:image/png;base64,${btoa(frozenStill?.id ?? "")}`],
		});
		const edited = state.project.segments.find(
			(candidate) => candidate.assetId === result.asset.id
		);
		expect(edited?.start).toBe(4);
		expect(edited?.id).toBe(result.swappedClipId);
		expect(result.asset.name).toBe("Edited frame — Add a halo.png");
		// The two halves of the original clip still use the source video.
		expect(
			state.project.segments.filter(
				(candidate) => candidate.assetId === clip.id
			)
		).toHaveLength(2);
	});

	test("does not freeze when references are invalid", async () => {
		const clip = media("video", "clip.mp4", 10);
		const project = newProject("Invalid");
		const { services, swap } = harness(project, [clip]);
		let froze = false;
		await expect(
			editFrameAsStill({
				assets: [clip],
				freeze: async () => {
					froze = true;
					return undefined;
				},
				projectId: project.id,
				prompt: "x",
				referenceIds: [clip.id],
				segment: newSegment(clip, 0),
				services,
				swap,
			})
		).rejects.toThrow("still images");
		expect(froze).toBe(false);
	});

	test("a budget refusal stops before the freeze changes the timeline", async () => {
		const clip = media("video", "clip.mp4", 10);
		const project = newProject("Budget");
		const { services, swap } = harness(project, [clip]);
		let froze = false;
		let recorded = false;
		await expect(
			editFrameAsStill({
				assets: [clip],
				freeze: async () => {
					froze = true;
					return undefined;
				},
				projectId: project.id,
				prompt: "x",
				segment: newSegment(clip, 0),
				services: {
					...services,
					admit: async () => {
						throw new Error("budget cannot admit");
					},
					record: async () => {
						recorded = true;
					},
				},
				swap,
			})
		).rejects.toThrow("budget cannot admit");
		expect(froze).toBe(false);
		expect(recorded).toBe(false);
	});

	test("a failure after the freeze says the freeze stays and can be undone", async () => {
		const clip = media("video", "clip.mp4", 10);
		const still = media("image", "Frame");
		const segment = newSegment(clip, 0);
		const project = newProject("Late refusal");
		const { services, swap } = harness(project, [clip, still]);
		await expect(
			editFrameAsStill({
				assets: [clip],
				freeze: async () => ({
					assets: [clip, still],
					segment: newSegment(still, 0),
				}),
				projectId: project.id,
				prompt: "x",
				segment,
				services: {
					...services,
					record: async () => {
						throw new Error("refused");
					},
				},
				swap,
			})
		).rejects.toThrow(
			`refused The ${EDIT_FRAME_HOLD_SECONDS}s freeze frame stays on the timeline as a plain still; undo to remove it.`
		);
	});

	test("reports a freeze that could not be added", async () => {
		const clip = media("video", "clip.mp4", 10);
		const project = newProject("No freeze");
		const { services, swap } = harness(project, [clip]);
		await expect(
			editFrameAsStill({
				assets: [clip],
				freeze: async () => undefined,
				projectId: project.id,
				prompt: "x",
				segment: newSegment(clip, 0),
				services,
				swap,
			})
		).rejects.toThrow("could not be added");
	});
});

describe("swapStillMedia", () => {
	test("refuses locked tracks, multicam clips, video media, and missing clips", () => {
		const still = media("image", "a.png");
		const next = media("image", "b.png");
		const clip = media("video", "c.mp4", 10);
		const segment = { ...newSegment(still, 0), sourceOut: 8 };
		const project = { ...newProject("Refuse"), segments: [segment] };
		const assets = [still, next, clip];
		expect(() =>
			swapStillMedia(
				{
					...project,
					trackSettings: [
						{ locked: true, muted: false, name: "V1", solo: false, track: 0 },
					],
				},
				assets,
				segment.id,
				next
			)
		).toThrow("Unlock");
		expect(() => swapStillMedia(project, assets, segment.id, clip)).toThrow(
			"Only still images"
		);
		expect(() =>
			swapStillMedia(project, assets, crypto.randomUUID(), next)
		).toThrow("Clip not found");
		const videoClip = { ...newSegment(clip, 0), sourceOut: 8 };
		expect(() =>
			swapStillMedia(
				{ ...project, segments: [videoClip] },
				assets,
				videoClip.id,
				next
			)
		).toThrow("still image clips");
		expect(
			swapStillMedia(project, [still, clip], segment.id, next).segments[0]
		).toMatchObject({ assetId: next.id, sourceOut: 8 });
	});

	test("video replacements go through the shared swap and keep the slot", () => {
		const clip = media("video", "a.mp4", 10);
		const replacement = media("video", "b.mp4", 6);
		const segment = { ...newSegment(clip, 0), sourceIn: 1, sourceOut: 5 };
		const project = { ...newProject("Video"), segments: [segment] };
		const swapped = swapGeneratedMedia(project, [clip], segment.id, replacement)
			.segments[0];
		expect(swapped).toMatchObject({
			assetId: replacement.id,
			sourceIn: 1,
			sourceOut: 5,
		});
	});
});

describe("insertedStillSegment", () => {
	test("ignores split pieces of existing media and ambiguous results", () => {
		const clip = media("video", "clip.mp4", 10);
		const stillA = media("image", "a");
		const stillB = media("image", "b");
		const original = newSegment(clip, 0);
		const before = { segments: [original] };
		const splitPiece = { ...original, id: crypto.randomUUID(), start: 6 };
		const freeze = newSegment(stillA, 4);
		expect(
			insertedStillSegment(before, {
				segments: [original, splitPiece, freeze],
			})?.id
		).toBe(freeze.id);
		expect(
			insertedStillSegment(before, {
				segments: [original, freeze, newSegment(stillB, 8)],
			})
		).toBeUndefined();
		expect(insertedStillSegment(before, before)).toBeUndefined();
	});
});

describe("reference picker", () => {
	test("toggles in order and never exceeds four", () => {
		const ids = ["a", "b", "c", "d"];
		let selected: string[] = [];
		for (const id of ids) {
			selected = toggleReference(selected, id, true);
		}
		expect(toggleReference(selected, "e", true)).toEqual(ids);
		expect(toggleReference(selected, "b", false)).toEqual(["a", "c", "d"]);
		expect(toggleReference(["a"], "a", true)).toEqual(["a"]);
	});

	test("offers library stills other than the edited one", () => {
		const still = media("image", "still");
		const other = media("image", "other");
		const clip = media("video", "clip");
		expect(referenceCandidates([still, other, clip], still.id)).toEqual([
			other,
		]);
	});
});
