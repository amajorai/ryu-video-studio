import { describe, expect, test } from "bun:test";
import { type Asset, newProject, newSegment } from "./project.ts";
import { reframeRequestSchema } from "./reframe.ts";
import {
	reframeStabilizeSkip,
	reframeStabilizeSources,
	swapToStabilized,
} from "./reframe-stabilize.ts";

function asset(patch: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 4,
		hasAudio: false,
		height: 720,
		id: crypto.randomUUID(),
		kind: "video",
		name: "clip.mp4",
		width: 1280,
		...patch,
	};
}

describe("reframe stabilize", () => {
	test("the request takes a stabilize level", () => {
		const base = { aspect: "9:16", mode: "track", revision: 0 } as const;
		expect(
			reframeRequestSchema.parse({ ...base, stabilize: "high" }).stabilize
		).toBe("high");
		expect(
			reframeRequestSchema.safeParse({ ...base, stabilize: "max" }).success
		).toBe(false);
	});

	test("only plain video up to ten minutes is stabilized", () => {
		const clip = { multicamGroupId: undefined };
		expect(reframeStabilizeSkip(clip, asset())).toBeUndefined();
		expect(reframeStabilizeSkip(clip, asset({ kind: "image" }))).toBe(
			"Only video is stabilized."
		);
		expect(reframeStabilizeSkip(clip, undefined)).toBe(
			"Only video is stabilized."
		);
		expect(reframeStabilizeSkip(clip, asset({ derivation: "stabilize" }))).toBe(
			"Already stabilized."
		);
		expect(reframeStabilizeSkip(clip, asset({ derivation: "proxy" }))).toBe(
			"Preview proxies are not stabilized."
		);
		expect(
			reframeStabilizeSkip(
				clip,
				asset({ sequenceProjectId: crypto.randomUUID() })
			)
		).toBe("Nested sequences are not stabilized.");
		expect(reframeStabilizeSkip(clip, asset({ duration: 601 }))).toBe(
			"Only media up to 10 minutes is stabilized."
		);
		expect(
			reframeStabilizeSkip({ multicamGroupId: crypto.randomUUID() }, asset())
		).toBe("Multicam clips keep their media.");
	});

	test("each source is stabilized once and every clip on it is swapped", () => {
		const source = asset();
		const still = asset({ duration: 0, kind: "image" });
		const first = { ...newSegment(source, 0), sourceIn: 1, sourceOut: 3 };
		const second = newSegment(source, 2, 1);
		const image = { ...newSegment(still, 4), sourceOut: 2 };
		const project = {
			...newProject("Swap"),
			segments: [first, second, image],
		};
		const assets = [source, still];
		const targets = project.segments;
		expect(
			reframeStabilizeSources(targets, assets).map((item) => item.id)
		).toEqual([source.id]);
		const derivative = asset({
			derivation: "stabilize",
			derivedFromAssetId: source.id,
		});
		const result = swapToStabilized(
			project,
			assets,
			targets,
			new Map([[source.id, derivative]])
		);
		expect(result.clips).toEqual([
			{ assetId: derivative.id, clipId: first.id },
			{ assetId: derivative.id, clipId: second.id },
			{ clipId: image.id, skipped: "Only video is stabilized." },
		]);
		const swapped = result.project.segments.find(
			(segment) => segment.id === first.id
		);
		// The clip keeps its trim and timeline slot.
		expect(swapped).toMatchObject({
			assetId: derivative.id,
			sourceIn: 1,
			sourceOut: 3,
			start: 0,
		});
	});

	test("a clip whose derivative is missing keeps its media", () => {
		const source = asset();
		const clip = newSegment(source);
		const project = { ...newProject("Missing"), segments: [clip] };
		const result = swapToStabilized(project, [source], [clip], new Map());
		expect(result.clips).toEqual([
			{ clipId: clip.id, skipped: "No stabilized media was made." },
		]);
		expect(result.project.segments[0]?.assetId).toBe(source.id);
	});
});
