import { expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	speedCurveSetpts,
} from "../../shared/speed-curve.ts";
import { applySpeedCurve } from "../../shared/speed-ramp.ts";
import { buildRender } from "./render.ts";
import { CHUNK_SEEK_PREROLL, windowSeek } from "./render-chunks.ts";

const video: Asset = {
	createdAt: new Date().toISOString(),
	duration: 10,
	frameRate: 30,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Shot",
	width: 640,
};

function curvedProject(): Project {
	const clip = { ...newSegment(video, 0, 0), sourceOut: 6 };
	const project: Project = { ...newProject("Curve"), segments: [clip] };
	return applySpeedCurve(project, [video], {
		clipId: clip.id,
		preset: "hero",
		revision: project.revision,
	});
}

const graphOf = (args: string[]) =>
	args[args.indexOf("-filter_complex") + 1] ?? "";

test("an export remaps a curved clip's video and audio as one clip", () => {
	const project = curvedProject();
	const clip = project.segments[0];
	expect(clip?.speedCurve).toBeDefined();
	const graph = graphOf(buildRender(project, [video], () => "/media/shot.mp4"));
	expect(graph).toContain(
		`[1:v]${speedCurveSetpts(clip ?? newSegment(video))}`
	);
	expect(graph).toContain("[curveMix1]");
	expect(graph).toMatch(/concat=n=\d+:v=0:a=1\[curveMix1\]/);
});

test("a single frame of a curved clip seeks to the curve's source moment", () => {
	const project = curvedProject();
	const args = buildRender(
		project,
		[video],
		() => "/media/shot.mp4",
		undefined,
		[],
		1
	);
	const seek = Number(args[args.indexOf("-ss") + 1]);
	// Hero runs 2x for its first 38% of source, so one second in is past 2 s.
	expect(seek).toBeCloseTo(2, 1);
});

test("chunked renders seek curved clips to the curve-mapped window start", () => {
	const clip = curvedProject().segments[0];
	if (!clip) {
		throw new Error("missing clip");
	}
	// Window frames 60..89 at 30 fps start 2 s into the clip.
	const window = { frames: 30, index: 1, spanningIds: [], startFrame: 60 };
	const seek = windowSeek(clip, video, window, 30);
	if (!seek) {
		throw new Error("expected the curved clip to skip ahead");
	}
	const target = clipSourceOffset(clip, 2) - CHUNK_SEEK_PREROLL;
	const frame = Math.floor((clip.sourceIn + target) * 30);
	expect(seek.seek).toBeCloseTo((frame - 0.5) / 30, 6);
	expect(seek.ticks).toBe(`round(${frame}*1/(30*TB))-round(0*1/(30*TB))`);
	// The first decoded frame lands at the clip time the curve gives it.
	expect(seek.skip).toBeCloseTo(clipTimeAtSourceOffset(clip, frame / 30), 9);
	expect(seek.skip).toBeLessThanOrEqual(2);
	// The window graph adds the skipped frames to the remap's clock.
	const graph = graphOf(
		buildRender(
			curvedProject(),
			[video],
			() => "/media/shot.mp4",
			undefined,
			[],
			undefined,
			{ plan: undefined, window }
		)
	);
	expect(graph).toContain(
		`[1:v]setpts='st(0,(PTS-STARTPTS+${seek.ticks})*TB);`
	);
	// A clip that starts inside the preroll is not skipped.
	expect(
		windowSeek(clip, video, { ...window, startFrame: 15 }, 30)
	).toBeUndefined();
});

test("curve audio rendered ahead replaces the atempo pieces", () => {
	const project = curvedProject();
	const clip = project.segments[0];
	if (!clip) {
		throw new Error("missing clip");
	}
	const args = buildRender(
		project,
		[video],
		() => "/media/shot.mp4",
		undefined,
		[],
		undefined,
		{ curveAudio: new Map([[clip.id, "/work/curve.wav"]]) }
	);
	const graph = graphOf(args);
	const input = args.filter((arg) => arg === "-i").length - 1;
	expect(args.at(args.lastIndexOf("-i") + 1)).toBe("/work/curve.wav");
	expect(graph).not.toContain("[curveMix1]");
	expect(graph).not.toContain("atempo");
	expect(graph).toContain(`[${input}:a]asetpts=PTS-STARTPTS,anull,`);
});

test("a tape-style curve refuses to export without its rendered audio", () => {
	const project = curvedProject();
	const clip = project.segments[0];
	if (!clip?.speedCurve) {
		throw new Error("missing clip");
	}
	const tape: Project = {
		...project,
		segments: [
			{ ...clip, speedCurve: { ...clip.speedCurve, preservePitch: false } },
		],
	};
	expect(() => buildRender(tape, [video], () => "/media/shot.mp4")).toThrow(
		"Tape-style speed-curve audio"
	);
	// Frame renders carry no audio and still work.
	expect(
		buildRender(tape, [video], () => "/media/shot.mp4", undefined, [], 1)
	).toContain("-ss");
});
