import { describe, expect, test } from "bun:test";
import { panGains, panMatrix } from "../../shared/audio.ts";
import {
	type Asset,
	newProject,
	newSegment,
	segmentDuration,
} from "../../shared/project.ts";
import { previewPanMatrix } from "./audio-preview/pan.ts";
import { createTestRuntime, testVideo } from "./editor/test-runtime.ts";
import {
	framePointAt,
	movedRegion,
	regionBetween,
} from "./preview/overlays/tracking-region.ts";
import { transitionBlurCss } from "./preview/preview-style.ts";
import { cropInsetCss } from "./preview/stages/crop.ts";
import { selectPreviewMedia, wantedProxyVariant } from "./preview-sources.ts";
import { dropTransitionOnCut } from "./timeline/useTimelineDrop.ts";

describe("track pan in the preview audio graph", () => {
	test("centre track pan leaves the clip matrix alone", () => {
		const segment = { channelMode: "stereo" as const, pan: 0.3 };
		expect(previewPanMatrix(segment, 0)).toEqual(
			panMatrix("stereo", 0.3).map((row) => [...row])
		);
	});

	test("a hard-left track silences the right output row", () => {
		const matrix = previewPanMatrix({ channelMode: "stereo", pan: 0 }, -1);
		expect(matrix[1]).toEqual([0, 0]);
		expect(matrix[0]?.[0]).toBeCloseTo(panGains(-1).left);
	});
});

describe("preview geometry parity", () => {
	const media = {
		canvas: { height: 1080, width: 1920 },
		media: { height: 1080, width: 1080 },
	};

	test("a keyframed crop edge is measured on the contained picture", () => {
		const base = newSegment(testVideo(), 0);
		const segment = {
			...base,
			keyframes: [
				{ id: "k1", property: "cropLeft" as const, time: 0, value: 0.5 },
				{ id: "k2", property: "cropLeft" as const, time: 1, value: 0.5 },
			],
		};
		// The square picture spans 56.25% of the width, centred.
		const left = Number(
			cropInsetCss(segment, 0.5, media).split(" ")[3]?.replace("%", "")
		);
		expect(left).toBeCloseTo(21.875 + 0.5 * 56.25, 3);
	});

	test("an uncropped clip keeps the element-wide inset", () => {
		expect(cropInsetCss(newSegment(testVideo(), 0), 0, media)).toBe(
			"0% 0% 0% 0%"
		);
	});

	test("transition blur scales with the drawn frame", () => {
		expect(transitionBlurCss(0)).toBe("");
		expect(transitionBlurCss(108, { height: 1080, width: 1920 })).toBe(
			" blur(calc(var(--studio-preview-width, 100cqw) * 0.05625))"
		);
	});
});

describe("tracking region drawing", () => {
	test("a drag in either direction spans a clamped region", () => {
		expect(regionBetween({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.4 })).toMatchObject(
			{ x: 0.2, y: 0.4 }
		);
		expect(
			movedRegion({ height: 0.2, width: 0.2, x: 0.7, y: 0.7 }, 0.5, 0.5)
		).toEqual({ height: 0.2, width: 0.2, x: 0.8, y: 0.8 });
		expect(
			framePointAt({ height: 100, left: 10, top: 20, width: 200 }, 110, 70)
		).toEqual({ x: 0.5, y: 0.5 });
	});
});

describe("lottie preview media", () => {
	const master: Asset = {
		...testVideo("anim.mov"),
		derivation: "lottie",
		width: 1920,
	};
	const preview: Asset = {
		...testVideo("anim (preview).webm"),
		derivation: "proxy",
		derivedFromAssetId: master.id,
		width: 1920,
	};

	test("always plays the VP9 alpha copy and never asks for H.264 proxies", () => {
		const library = [master, preview];
		for (const quality of ["full", "half", "quarter"] as const) {
			expect(
				selectPreviewMedia(master, library, { quality, useProxies: false }).id
			).toBe(preview.id);
			expect(wantedProxyVariant(master, library, quality)).toBeNull();
		}
	});
});

describe("transition drop on a cut", () => {
	test("sets the reveal on the incoming clip as one edit", () => {
		const asset = testVideo();
		const first = newSegment(asset, 0);
		// The incoming clip has 2 s of media before its in point to overlap with.
		const second = {
			...newSegment(asset, segmentDuration(first)),
			sourceIn: 2,
		};
		const runtime = createTestRuntime(
			{ ...newProject("Drop"), segments: [first, second] },
			[asset]
		);
		expect(
			dropTransitionOnCut(
				runtime,
				"wipe-left",
				{ time: second.start + 0.05, track: second.track },
				70
			)
		).toBe(true);
		const incoming = runtime.project?.segments.find(
			(segment) => segment.id === second.id
		);
		expect(incoming?.transitionIn?.type).toBe("wipe-left");
	});

	test("a drop away from any cut is reported, not applied", () => {
		const asset = testVideo();
		const runtime = createTestRuntime(
			{ ...newProject("Drop"), segments: [newSegment(asset, 0)] },
			[asset]
		);
		expect(
			dropTransitionOnCut(runtime, "dissolve", { time: 3, track: 0 }, 70)
		).toBe(false);
		expect(runtime.calls.at(-1)).toEqual([
			"setStatus",
			"Drop a transition on the cut between two clips on the same track.",
		]);
	});
});
