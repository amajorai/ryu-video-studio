import { describe, expect, test } from "bun:test";
import { applyGapFill } from "../../../shared/gap-fill.ts";
import type { GenerationRequest } from "../../../shared/generation.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import {
	gapFillFrameName,
	MAX_CAPTURE_NAME_LENGTH,
	runGapFill,
} from "./gap-fill-run.ts";
import type { GenerationServices, MediaBridge } from "./media-bridge.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function media(kind: Asset["kind"], name: string, duration = 10): Asset {
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

function setup(
	options: { image?: boolean; admit?: () => Promise<void>; title?: string } = {}
) {
	const video = media("video", "clip.mp4");
	const a = { ...newSegment(video, 0), sourceOut: 4 };
	const b = { ...newSegment(video, 6), sourceIn: 4, sourceOut: 8 };
	const state = {
		assets: [video],
		captures: [] as [number, string][],
		hostInputs: [] as unknown[],
		project: {
			...newProject(options.title ?? "Bridge"),
			segments: [a, b],
		} as Project,
		records: [] as GenerationRequest[],
	};
	const bridge: MediaBridge =
		options.image === false
			? {}
			: {
					image: async (input) => {
						state.hostInputs.push(input);
						return [PNG];
					},
				};
	const services: GenerationServices = {
		admit: options.admit ?? (async () => undefined),
		bridge,
		finish: async () => undefined,
		readImage: async (asset) => `data:image/png;base64,${btoa(asset.id)}`,
		record: async (generation) => {
			state.records.push(generation);
		},
		upload: async (file) => {
			const asset = media("image", file.name, 5);
			state.assets.push(asset);
			return asset;
		},
	};
	const capture = async (time: number, name: string) => {
		state.captures.push([time, name]);
		const still = media("image", name, 0);
		state.assets.push(still);
		return still;
	};
	const place = async (placement: { afterClipId: string; assetId: string }) => {
		const result = applyGapFill(state.project, state.assets, {
			...placement,
			revision: state.project.revision,
		});
		state.project = result.project;
		return result.clipId;
	};
	return { a, b, capture, place, services, state };
}

describe("runGapFill", () => {
	test("captures both frames, sends them in order, and places the bridge", async () => {
		const { a, b, capture, place, services, state } = setup();
		const result = await runGapFill({
			assets: state.assets,
			capture,
			clipId: a.id,
			direction: "fog rolls in",
			place,
			project: state.project,
			services,
		});
		expect(state.captures.map(([time]) => time)).toEqual([
			3.966_667, 6.016_667,
		]);
		const [request] = state.records;
		expect(request?.inputAssetIds).toEqual(result.frames.map((f) => f.id));
		expect(request?.prompt).toContain("fog rolls in");
		expect(state.hostInputs).toHaveLength(1);
		expect(
			(state.hostInputs[0] as { input_images: string[] }).input_images
		).toEqual(
			result.frames.map((frame) => `data:image/png;base64,${btoa(frame.id)}`)
		);
		expect(result.placedClipId).toBeDefined();
		const bridge = state.project.segments.find(
			(segment) => segment.id === result.placedClipId
		);
		expect(bridge?.assetId).toBe(result.asset.id);
		expect(bridge?.transitionIn?.type).toBe("dissolve");
		expect(
			state.project.segments.find((segment) => segment.id === b.id)
				?.transitionIn?.type
		).toBe("dissolve");
	});

	test("keeps capture names within the route limit for a 200-character title", async () => {
		const title = "T".repeat(200);
		const { a, capture, place, services, state } = setup({ title });
		await runGapFill({
			assets: state.assets,
			capture,
			clipId: a.id,
			place,
			project: state.project,
			services,
		});
		const names = state.captures.map(([, name]) => name);
		expect(names).toHaveLength(2);
		for (const name of names) {
			expect(name.length).toBeLessThanOrEqual(MAX_CAPTURE_NAME_LENGTH);
		}
		expect(names[0]?.endsWith(" gap fill outgoing frame")).toBe(true);
		expect(names[1]?.endsWith(" gap fill incoming frame")).toBe(true);
		expect(gapFillFrameName("Bridge", "outgoing")).toBe(
			"Bridge gap fill outgoing frame"
		);
	});

	test("refuses before capturing when there is nothing to bridge or no image model", async () => {
		const noImage = setup({ image: false });
		await expect(
			runGapFill({
				assets: noImage.state.assets,
				capture: noImage.capture,
				clipId: noImage.a.id,
				place: noImage.place,
				project: noImage.state.project,
				services: noImage.services,
			})
		).rejects.toThrow("unavailable");
		expect(noImage.state.captures).toEqual([]);
		const last = setup();
		await expect(
			runGapFill({
				assets: last.state.assets,
				capture: last.capture,
				clipId: last.b.id,
				place: last.place,
				project: last.state.project,
				services: last.services,
			})
		).rejects.toThrow("following clip");
		const overBudget = setup({
			admit: async () => {
				throw new Error("budget");
			},
		});
		await expect(
			runGapFill({
				assets: overBudget.state.assets,
				capture: overBudget.capture,
				clipId: overBudget.a.id,
				place: overBudget.place,
				project: overBudget.state.project,
				services: overBudget.services,
			})
		).rejects.toThrow("budget");
		expect(overBudget.state.captures).toEqual([]);
	});

	test("keeps the saved still when placement is refused", async () => {
		const { a, capture, services, state } = setup();
		const result = await runGapFill({
			assets: state.assets,
			capture,
			clipId: a.id,
			place: async () => undefined,
			project: state.project,
			services,
		});
		expect(result.placedClipId).toBeUndefined();
		expect(state.assets.some((asset) => asset.id === result.asset.id)).toBe(
			true
		);
	});
});
