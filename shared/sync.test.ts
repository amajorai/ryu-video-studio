import { expect, test } from "bun:test";
import type { MediaAnalysis } from "./analysis.ts";
import { newProject, newSegment } from "./project.ts";
import { correlateAudio, syncClips, timecodeSeconds } from "./sync.ts";

function analysis(assetId: string, waveform: number[]): MediaAnalysis {
	return {
		assetId,
		createdAt: new Date().toISOString(),
		duration: 8,
		sceneCuts: [],
		status: "completed",
		waveform,
	};
}

function source(id = crypto.randomUUID()) {
	return {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 360,
		id,
		kind: "video" as const,
		name: "Camera",
		width: 640,
	};
}

test("timecodeSeconds handles regular and drop-frame timecode", () => {
	expect(timecodeSeconds("01:00:00:00", 30)).toBe(3600);
	expect(timecodeSeconds("00:01:00;00", 29.97)).toBeCloseTo(59.993, 2);
});

test("audio correlation finds a delayed target source", () => {
	const reference = source();
	const values = Array.from(
		{ length: 80 },
		(_, index) => 0.1 + ((index * 29) % 17) / 22
	);
	const targetValues = Array.from(
		{ length: 80 },
		(_, index) => values[index - 8] ?? 0
	);
	const match = correlateAudio(
		analysis(reference.id, values),
		analysis(crypto.randomUUID(), targetValues),
		2,
		0.8
	);
	expect(match.lagSeconds).toBeCloseTo(0.8, 1);
	expect(match.confidence).toBeGreaterThan(0.8);
});

test("syncClips aligns targets and shifts a negative group into the timeline", () => {
	const reference = source();
	const target = source();
	target.name = "Recorder";
	const project = newProject("Sync");
	const referenceClip = newSegment(reference, 0, 0);
	const targetClip = newSegment(target, 2, 1);
	project.segments = [referenceClip, targetClip];
	const values = Array.from(
		{ length: 80 },
		(_, index) => 0.1 + ((index * 29) % 17) / 22
	);
	const delayed = Array.from(
		{ length: 80 },
		(_, index) => values[index - 8] ?? 0
	);
	const result = syncClips(
		project,
		[reference, target],
		new Map([
			[reference.id, analysis(reference.id, values)],
			[target.id, analysis(target.id, delayed)],
		]),
		{
			mode: "audio",
			referenceClipId: referenceClip.id,
			revision: project.revision,
			searchWindowSeconds: 2,
			targetClipIds: [targetClip.id],
		}
	);
	const alignedReference = result.project.segments.find(
		(segment) => segment.id === referenceClip.id
	);
	const alignedTarget = result.project.segments.find(
		(segment) => segment.id === targetClip.id
	);
	expect(result.shiftedFrames).toBe(24);
	expect(alignedReference?.start).toBeCloseTo(0.8, 2);
	expect(alignedTarget?.start).toBe(0);
	expect(result.matches[0]).toMatchObject({
		confidence: expect.any(Number),
		method: "audio",
		offsetFrames: -60,
	});
});

test("manual sync applies a bounded target offset without source analysis", () => {
	const reference = source();
	const target = source();
	const project = newProject("Manual sync");
	const referenceClip = newSegment(reference, 1, 0);
	const targetClip = newSegment(target, 2, 1);
	project.segments = [referenceClip, targetClip];
	const result = syncClips(project, [reference, target], new Map(), {
		offsetSeconds: -0.5,
		mode: "manual",
		referenceClipId: referenceClip.id,
		revision: project.revision,
		targetClipIds: [targetClip.id],
	});
	expect(
		result.project.segments.find((segment) => segment.id === targetClip.id)
			?.start
	).toBe(1.5);
	expect(result.matches[0]).toMatchObject({
		alignmentOffsetSeconds: -0.5,
		method: "manual",
		offsetFrames: -15,
	});
});

test("timecode sync aligns clips from embedded source starts", () => {
	const reference = {
		...source(),
		timecodeFrameRate: 30,
		timecodeStart: "01:00:00:00",
	};
	const target = {
		...source(),
		name: "Recorder",
		timecodeFrameRate: 30,
		timecodeStart: "01:00:05:00",
	};
	const project = newProject("Timecode sync");
	const referenceClip = newSegment(reference, 0, 0);
	const targetClip = newSegment(target, 0, 1);
	project.segments = [referenceClip, targetClip];
	const result = syncClips(project, [reference, target], new Map(), {
		mode: "timecode",
		referenceClipId: referenceClip.id,
		revision: project.revision,
		targetClipIds: [targetClip.id],
	});
	expect(
		result.project.segments.find((segment) => segment.id === targetClip.id)
			?.start
	).toBe(5);
	expect(result.matches[0]).toMatchObject({
		alignmentOffsetSeconds: -5,
		method: "timecode",
		offsetFrames: 150,
	});
});
