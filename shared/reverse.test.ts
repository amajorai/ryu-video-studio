import { describe, expect, test } from "bun:test";
import { newProject, newSegment } from "./project.ts";
import { reverseClips, reversedSegment } from "./reverse.ts";

function asset(
	kind: "video" | "audio" = "video",
	extra: { derivedFromAssetId?: string; derivation?: "audio" | "reverse" } = {}
) {
	return {
		id: crypto.randomUUID(),
		name: kind,
		kind,
		duration: 10,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
		...extra,
	};
}

function reversedOf(original: ReturnType<typeof asset>) {
	return asset(original.kind, {
		derivedFromAssetId: original.id,
		derivation: "reverse",
	});
}

describe("reverse clip", () => {
	test("maps the source range onto the reversed media and swaps fades", () => {
		const original = asset();
		const reversed = reversedOf(original);
		const clip = { ...newSegment(original, 2, 0), fadeIn: 0.5, fadeOut: 1 };
		clip.sourceIn = 1;
		clip.sourceOut = 4;
		const next = reversedSegment(clip, original, reversed);
		expect(next.assetId).toBe(reversed.id);
		expect([next.start, next.sourceIn, next.sourceOut]).toEqual([2, 6, 9]);
		expect([next.fadeIn, next.fadeOut]).toEqual([1, 0.5]);
	});

	test("mirrors keyframes inside the clip", () => {
		const original = asset();
		const reversed = reversedOf(original);
		const clip = newSegment(original, 0, 0);
		clip.sourceOut = 4;
		clip.opacity = 0.2;
		const frameId = crypto.randomUUID();
		clip.keyframes = [{ id: frameId, property: "opacity", time: 1, value: 1 }];
		const next = reversedSegment(clip, original, reversed);
		expect(next.opacity).toBe(1);
		expect(
			next.keyframes.map((f) => [f.id === frameId, f.time, f.value])
		).toEqual([
			[true, 3, 1],
			[false, 4, 0.2],
		]);
	});

	test("reversing twice restores the original clip", () => {
		const original = asset();
		const reversed = reversedOf(original);
		const clip = { ...newSegment(original, 1, 0), fadeIn: 0.25, fadeOut: 0 };
		clip.sourceIn = 2;
		clip.sourceOut = 6;
		clip.scale = 1.5;
		clip.keyframes = [
			{ id: crypto.randomUUID(), property: "scale", time: 1, value: 2 },
			{ id: crypto.randomUUID(), property: "scale", time: 3, value: 1 },
		];
		const project = { ...newProject("Reverse"), segments: [clip] };
		const lookup = (id: string) => (id === original.id ? reversed : undefined);
		const once = reverseClips(
			project,
			[original],
			{ clipIds: [clip.id], revision: project.revision },
			lookup
		);
		expect(once.segments[0]?.assetId).toBe(reversed.id);
		const twice = reverseClips(
			once,
			[original, reversed],
			{ clipIds: [clip.id], revision: once.revision },
			() => undefined
		);
		expect(twice.segments[0]).toEqual(clip);
	});

	test("reverses linked audio partners together and keeps them in sync", () => {
		const video = asset();
		const audio = asset("audio", {
			derivedFromAssetId: video.id,
			derivation: "audio",
		});
		const reversedVideo = reversedOf(video);
		const reversedAudio = reversedOf(audio);
		const groupId = crypto.randomUUID();
		const videoClip = { ...newSegment(video, 0, 0), linkGroupId: groupId };
		videoClip.sourceIn = 0;
		videoClip.sourceOut = 4;
		// L-cut: the audio runs one second past the picture.
		const audioClip = { ...newSegment(audio, 0, 1), linkGroupId: groupId };
		audioClip.sourceIn = 0;
		audioClip.sourceOut = 5;
		const project = {
			...newProject("Linked reverse"),
			segments: [videoClip, audioClip],
		};
		const next = reverseClips(
			project,
			[video, audio],
			{ clipIds: [videoClip.id], revision: project.revision },
			(id) => ({ [video.id]: reversedVideo, [audio.id]: reversedAudio })[id]
		);
		const [nextVideo, nextAudio] = next.segments;
		expect(nextVideo?.assetId).toBe(reversedVideo.id);
		expect(nextAudio?.assetId).toBe(reversedAudio.id);
		expect(nextAudio?.linkGroupId).toBe(groupId);
		// Mirrored around [0, 5]: the L-cut becomes a J-cut.
		expect([
			nextVideo?.start,
			nextVideo?.sourceIn,
			nextVideo?.sourceOut,
		]).toEqual([1, 6, 10]);
		expect([
			nextAudio?.start,
			nextAudio?.sourceIn,
			nextAudio?.sourceOut,
		]).toEqual([0, 5, 10]);
		// Timeline 2 plays reversed source 7 on both, i.e. original source 3.
		for (const segment of [nextVideo, nextAudio]) {
			if (!segment) {
				throw new Error("missing segment");
			}
			expect(segment.sourceIn + (2 - segment.start) * segment.speed).toBe(7);
		}
	});

	test("rejects missing renders, locked tracks and wrong derivatives", () => {
		const original = asset();
		const clip = newSegment(original, 0, 0);
		const project = { ...newProject("Reject"), segments: [clip] };
		const request = { clipIds: [clip.id], revision: project.revision };
		expect(() =>
			reverseClips(project, [original], request, () => undefined)
		).toThrow("Render the reversed media");
		expect(() =>
			reverseClips(project, [original], request, () => asset())
		).toThrow("Render the reversed media");
		const locked = {
			...project,
			trackSettings: [
				{ locked: true, muted: false, name: "V1", solo: false, track: 0 },
			],
		};
		expect(() =>
			reverseClips(locked, [original], request, () => reversedOf(original))
		).toThrow("Unlock");
		expect(() =>
			reverseClips(
				project,
				[original],
				{ clipIds: [clip.id, clip.id], revision: 0 },
				() => undefined
			)
		).toThrow("each clip once");
	});

	test("keyframed clips at repeating-decimal durations reverse", () => {
		const original = asset();
		const clip = { ...newSegment(original, 0, 0), speed: 3 };
		clip.sourceIn = 0;
		clip.sourceOut = 2;
		clip.keyframes = [
			{ id: crypto.randomUUID(), property: "opacity", time: 0.3, value: 0.5 },
		];
		const project = { ...newProject("Speed"), segments: [clip] };
		const next = reverseClips(
			project,
			[original],
			{ clipIds: [clip.id], revision: project.revision },
			() => reversedOf(original)
		);
		const segment = next.segments[0];
		const limit = ((segment?.sourceOut ?? 0) - (segment?.sourceIn ?? 0)) / 3;
		expect(segment?.keyframes.length).toBeGreaterThan(0);
		for (const frame of segment?.keyframes ?? []) {
			expect(frame.time).toBeLessThanOrEqual(limit);
		}
	});

	test("a clip overrunning its media keeps its length when reversed", () => {
		const original = asset();
		const clip = newSegment(original, 0, 0);
		clip.sourceIn = 9;
		clip.sourceOut = 10.04;
		clip.keyframes = [
			{ id: crypto.randomUUID(), property: "opacity", time: 0.5, value: 0.5 },
		];
		const project = { ...newProject("Overrun"), segments: [clip] };
		const next = reverseClips(
			project,
			[original],
			{ clipIds: [clip.id], revision: project.revision },
			() => reversedOf(original)
		);
		const segment = next.segments[0];
		expect(segment?.sourceIn).toBe(0);
		expect(segment?.sourceOut).toBeCloseTo(1.04, 9);
	});

	test("refuses when mirroring a linked member would overlap the next clip", () => {
		const video = asset();
		const audio = asset("audio", {
			derivedFromAssetId: video.id,
			derivation: "audio",
		});
		const groupId = crypto.randomUUID();
		const videoClip = { ...newSegment(video, 0, 0), linkGroupId: groupId };
		const audioClip = { ...newSegment(audio, 2, 1), linkGroupId: groupId };
		const nextClip = newSegment(video, 10, 0);
		nextClip.sourceOut = 4;
		const project = {
			...newProject("Overlap"),
			segments: [videoClip, audioClip, nextClip],
		};
		expect(() =>
			reverseClips(
				project,
				[video, audio],
				{ clipIds: [videoClip.id], revision: project.revision },
				(id) => (id === video.id ? reversedOf(video) : reversedOf(audio))
			)
		).toThrow("overlap");
	});
});
