import { describe, expect, test } from "bun:test";
import {
	clampClipSpeed,
	clipAudioMutedOf,
	clipTempoFilters,
	HIGH_SPEED_MUTE_ABOVE,
	highSpeedMutedOf,
	MIN_CLIP_DURATION,
	maxClipSpeedFor,
	maxGroupSpeedFor,
	minimumClipDuration,
	SPEED_PRESETS,
	tapeSpeedFilters,
	withClipSpeed,
} from "./clip-speed.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentDuration,
	validateProject,
} from "./project.ts";

const asset = (kind: "audio" | "video", duration = 10): Asset => ({
	createdAt: new Date(0).toISOString(),
	duration,
	hasAudio: true,
	height: kind === "video" ? 360 : 0,
	id: crypto.randomUUID(),
	kind,
	name: `${kind}.media`,
	width: kind === "video" ? 640 : 0,
});

describe("clip speed", () => {
	test("default 1x clips keep the legacy anull chain", () => {
		expect(clipTempoFilters({ speed: 1 })).toEqual(["anull"]);
		expect(clipTempoFilters({ preservePitch: false, speed: 1 })).toEqual([
			"anull",
		]);
	});

	test("pitch is preserved through chained atempo by default", () => {
		expect(clipTempoFilters({ speed: 2 })).toEqual(["atempo=2"]);
		expect(clipTempoFilters({ preservePitch: true, speed: 0.1 })).toEqual([
			"atempo=0.5",
			"atempo=0.5",
			"atempo=0.5",
			"atempo=0.8",
		]);
	});

	test("tape-style speed resamples at a scaled rate", () => {
		expect(clipTempoFilters({ preservePitch: false, speed: 2 })).toEqual([
			"aresample=48000",
			"asetrate=96000",
			"aresample=48000",
		]);
		expect(tapeSpeedFilters(0.5)).toEqual([
			"aresample=48000",
			"asetrate=24000",
			"aresample=48000",
		]);
		expect(tapeSpeedFilters(0.1)[1]).toBe("asetrate=4800");
		expect(() => tapeSpeedFilters(0)).toThrow("Invalid audio speed.");
		expect(() => tapeSpeedFilters(Number.NaN)).toThrow();
	});

	test("clips above 16x are muted unless they opt back in", () => {
		expect(highSpeedMutedOf({ speed: HIGH_SPEED_MUTE_ABOVE })).toBe(false);
		expect(highSpeedMutedOf({ speed: 17 })).toBe(true);
		expect(highSpeedMutedOf({ muted: true, speed: 17 })).toBe(true);
		expect(highSpeedMutedOf({ muted: false, speed: 17 })).toBe(false);
		expect(clipTempoFilters({ speed: 32 })).toEqual([
			"atempo=2",
			"atempo=2",
			"atempo=2",
			"atempo=2",
			"atempo=2",
			"volume=0",
		]);
		expect(clipTempoFilters({ muted: false, speed: 32 }).at(-1)).toBe(
			"atempo=2"
		);
		expect(clipTempoFilters({ preservePitch: false, speed: 100 }).at(-1)).toBe(
			"volume=0"
		);
	});

	test("speed requests clamp to 0.1..100", () => {
		expect(clampClipSpeed(0.01)).toBe(0.1);
		expect(clampClipSpeed(250)).toBe(100);
		expect(clampClipSpeed(1.234)).toBe(1.23);
		expect(clampClipSpeed(Number.NaN)).toBe(1);
		expect(
			SPEED_PRESETS.every((speed) => clampClipSpeed(speed) === speed)
		).toBe(true);
	});
});

describe("clip mute", () => {
	test("an explicit clip mute silences the render at any speed", () => {
		expect(clipAudioMutedOf({ muted: true, speed: 1 })).toBe(true);
		expect(clipAudioMutedOf({ speed: 1 })).toBe(false);
		expect(clipAudioMutedOf({ muted: false, speed: 1 })).toBe(false);
		expect(clipAudioMutedOf({ speed: 20 })).toBe(true);
		expect(clipTempoFilters({ muted: true, speed: 2 })).toEqual([
			"atempo=2",
			"volume=0",
		]);
		expect(clipTempoFilters({ muted: true, speed: 1 })).toEqual([
			"anull",
			"volume=0",
		]);
	});
});

describe("speed limits", () => {
	const audio = asset("audio");
	const video = asset("video");
	const project = (segments: Project["segments"]): Project => ({
		...newProject("Speed test"),
		segments,
	});

	test("the shortest clip covers fades, exit transition and keyframes", () => {
		const clip = newSegment(audio);
		expect(minimumClipDuration(clip)).toBe(MIN_CLIP_DURATION);
		expect(minimumClipDuration({ ...clip, fadeIn: 0.5, fadeOut: 1 })).toBe(1.5);
		expect(minimumClipDuration({ ...clip, exitDuration: 2 })).toBe(2);
		expect(
			minimumClipDuration({
				...clip,
				keyframes: [
					{ id: crypto.randomUUID(), property: "volume", time: 3, value: 1 },
				],
			})
		).toBe(3);
	});

	test("a 2 s clip cannot reach 100x (it would be 0.02 s long)", () => {
		const clip = { ...newSegment(audio), sourceOut: 2 };
		expect(maxClipSpeedFor(clip)).toBe(50);
		const fast = withClipSpeed(project([clip]), clip.id, 100);
		expect(fast?.speed).toBe(50);
		expect(fast?.limited).toBe(true);
		const next = fast?.project.segments[0];
		expect(next && segmentDuration(next)).toBeGreaterThanOrEqual(
			MIN_CLIP_DURATION
		);
	});

	test("review repro: a faded 10 s clip at 100x stays valid", () => {
		const clip = { ...newSegment(audio), fadeOut: 1, sourceOut: 10 };
		const change = withClipSpeed(project([clip]), clip.id, 100);
		expect(change?.speed).toBe(10);
		expect(change?.limited).toBe(true);
		if (!change) {
			throw new Error("speed was not changed");
		}
		expect(() => validateProject(change.project, [audio])).not.toThrow();
	});

	test("keyframes cap the speed so they stay inside the clip", () => {
		const clip = {
			...newSegment(audio),
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "volume" as const,
					time: 4,
					value: 1,
				},
			],
			sourceOut: 10,
		};
		const change = withClipSpeed(project([clip]), clip.id, 16);
		expect(change?.speed).toBe(2.5);
		if (!change) {
			throw new Error("speed was not changed");
		}
		expect(() => validateProject(change.project, [audio])).not.toThrow();
	});

	test("every preset either applies or clamps to a valid project", () => {
		const clip = { ...newSegment(audio), fadeIn: 0.2, sourceOut: 3 };
		for (const speed of SPEED_PRESETS) {
			const change = withClipSpeed(project([clip]), clip.id, speed);
			const next = change?.project ?? project([clip]);
			expect(() => validateProject(next, [audio])).not.toThrow();
		}
	});

	test("link-group partners follow the speed and share the limit", () => {
		const group = crypto.randomUUID();
		const picture = { ...newSegment(video), linkGroupId: group, sourceOut: 10 };
		const sound = {
			...newSegment(audio, 0, 1),
			fadeOut: 2,
			linkGroupId: group,
			sourceOut: 10,
		};
		const other = newSegment(video, 20);
		const base = project([picture, sound, other]);
		expect(maxGroupSpeedFor(base, picture.id)).toBe(5);
		const change = withClipSpeed(base, picture.id, 4);
		expect(change?.partners).toBe(1);
		expect(change?.project.segments.map((segment) => segment.speed)).toEqual([
			4, 4, 1,
		]);
		const limited = withClipSpeed(base, picture.id, 50);
		expect(limited?.speed).toBe(5);
		if (!limited) {
			throw new Error("speed was not changed");
		}
		expect(() =>
			validateProject(limited.project, [video, audio])
		).not.toThrow();
	});

	test("unchanged or unknown clips return null", () => {
		const clip = newSegment(audio);
		expect(withClipSpeed(project([clip]), clip.id, 1)).toBeNull();
		expect(withClipSpeed(project([clip]), "missing", 2)).toBeNull();
	});

	test("a stale unmute never opts a clip out of the high-speed mute", () => {
		const clip = { ...newSegment(audio), muted: false };
		const fast = withClipSpeed(project([clip]), clip.id, 20)?.project
			.segments[0];
		expect(fast && "muted" in fast).toBe(false);
		expect(fast && highSpeedMutedOf(fast)).toBe(true);
		expect(fast && clipTempoFilters(fast).at(-1)).toBe("volume=0");
	});

	test("the keep-audio opt-in survives changes above 16x only", () => {
		const clip = { ...newSegment(audio), muted: false, speed: 20 };
		const faster = withClipSpeed(project([clip]), clip.id, 40)?.project
			.segments[0];
		expect(faster?.muted).toBe(false);
		const slower = withClipSpeed(project([clip]), clip.id, 8)?.project
			.segments[0];
		expect(slower && "muted" in slower).toBe(false);
	});

	test("an explicit clip mute is kept across speed changes", () => {
		const clip = { ...newSegment(audio), muted: true };
		const fast = withClipSpeed(project([clip]), clip.id, 20)?.project
			.segments[0];
		expect(fast?.muted).toBe(true);
	});
});
