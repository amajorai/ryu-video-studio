import { describe, expect, test } from "bun:test";
import { avatarPoseAtTime, avatarRigExpression } from "./avatar.ts";
import {
	applyAvatarLipSync,
	avatarLipSyncRequestSchema,
	decimateLipSync,
	envelopeFromDb,
	envelopeFromWaveform,
	envelopeLevelAt,
	isLipSyncClipAudible,
	LIP_SYNC_FRAME_SECONDS,
	type LipSyncEnvelope,
	lipSyncCurve,
	lipSyncKeyframeBudget,
	lipSyncSampleTimes,
	lipSyncSourceKey,
	lipSyncSourceOptions,
	lipSyncSourceTime,
	MAX_AVATAR_RIG_KEYFRAMES,
	pruneDanglingLipSync,
	type ResolvedLipSyncSource,
	resolveLipSyncSource,
	smoothOpenness,
	wordShape,
} from "./avatar-lipsync.ts";
import {
	type Asset,
	type Avatar,
	newProject,
	newSegment,
	type Project,
	trackSettingSchema,
	validateProject,
} from "./project.ts";

const created = "2026-01-01T00:00:00.000Z";
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function asset(id: number, kind: Asset["kind"], extra: Partial<Asset> = {}) {
	return {
		createdAt: created,
		duration: 20,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 1080,
		id: uuid(id),
		kind,
		name: `Media ${id}`,
		width: kind === "audio" ? 0 : 1920,
		...extra,
	} satisfies Asset;
}

function avatar(extra: Partial<Avatar> = {}): Avatar {
	return {
		accent: "#f97316",
		animation: "none",
		depth: 0.45,
		end: 4,
		entryDuration: 0,
		height: 0.6,
		id: uuid(900),
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		start: 0,
		width: 0.3,
		x: 0.5,
		y: 0.2,
		...extra,
	};
}

function project(avatars: Avatar[], extra: Partial<Project> = {}): Project {
	return { ...newProject("Lip-sync"), avatars, ...extra };
}

/** A 50 Hz envelope that is `level` inside `spans` (source seconds) and silent elsewhere. */
function envelope(
	duration: number,
	spans: [number, number][],
	level = 0.3
): LipSyncEnvelope {
	const count = Math.round(duration / LIP_SYNC_FRAME_SECONDS);
	const values = Array.from({ length: count }, (_, index) => {
		const time = (index + 0.5) * LIP_SYNC_FRAME_SECONDS;
		return spans.some(([start, end]) => time >= start && time < end)
			? level * (0.6 + 0.4 * Math.abs(Math.sin(time * Math.PI * 4)))
			: 0;
	});
	return { frameSeconds: LIP_SYNC_FRAME_SECONDS, values };
}

const counter = () => {
	let next = 1000;
	return () => uuid(next++);
};

const assetSource = (media: Asset): ResolvedLipSyncSource => ({
	asset: media,
	map: { kind: "asset", duration: media.duration },
});

describe("envelopes", () => {
	test("dB frames convert to linear amplitude and silence to zero", () => {
		const env = envelopeFromDb([-20, -100, Number.NEGATIVE_INFINITY], 0.02);
		expect(env.values[0]).toBeCloseTo(0.1, 5);
		expect(env.values[1]).toBeCloseTo(1e-5, 8);
		expect(env.values[2]).toBe(0);
	});

	test("levels interpolate between frame centers and are silent outside", () => {
		const env = { frameSeconds: 1, values: [0, 1] };
		expect(envelopeLevelAt(env, 0.5)).toBe(0);
		expect(envelopeLevelAt(env, 1)).toBeCloseTo(0.5, 6);
		expect(envelopeLevelAt(env, 1.5)).toBe(1);
		expect(envelopeLevelAt(env, 2.5)).toBe(0);
		expect(envelopeLevelAt(env, -0.1)).toBe(0);
	});

	test("analysis waveforms spread their bins over the source", () => {
		const env = envelopeFromWaveform([0.1, 0.2, 0.3, 0.4], 2);
		expect(env.frameSeconds).toBe(0.5);
	});
});

describe("source mapping", () => {
	test("a clip maps project time through its trim and speed", () => {
		const map = {
			kind: "segment" as const,
			sourceIn: 3,
			sourceOut: 7,
			speed: 2,
			start: 1,
		};
		expect(lipSyncSourceTime(map, 0, 0.5)).toBeUndefined();
		expect(lipSyncSourceTime(map, 0, 1)).toBe(3);
		expect(lipSyncSourceTime(map, 0, 2)).toBe(5);
		expect(lipSyncSourceTime(map, 0, 3)).toBeUndefined();
		expect(lipSyncSourceTime(map, 2, 0.5)).toBe(6);
	});

	test("media aligns with the avatar start and ends with the media", () => {
		const map = { kind: "asset" as const, duration: 2 };
		expect(lipSyncSourceTime(map, 5, 1.5)).toBe(1.5);
		expect(lipSyncSourceTime(map, 5, 2.5)).toBeUndefined();
	});

	test("resolves a clip or media and refuses silent sources", () => {
		const audio = asset(1, "audio");
		const image = asset(2, "image");
		const clip = { ...newSegment(audio, 1), id: uuid(10) };
		const still = { ...newSegment(image, 0, 1), id: uuid(11) };
		const p = project([avatar()], { segments: [clip, still] });
		const assets = [audio, image];
		const fromClip = resolveLipSyncSource(p, assets, { segmentId: clip.id });
		expect(fromClip.asset.id).toBe(audio.id);
		expect(fromClip.segmentId).toBe(clip.id);
		expect(fromClip.map).toMatchObject({ kind: "segment", start: 1 });
		expect(
			resolveLipSyncSource(p, assets, { assetId: audio.id }).map.kind
		).toBe("asset");
		expect(() =>
			resolveLipSyncSource(p, assets, { segmentId: still.id })
		).toThrow("no audio");
		expect(() =>
			resolveLipSyncSource(p, assets, {
				assetId: image.id,
				segmentId: clip.id,
			})
		).toThrow("does not use");
		expect(() => resolveLipSyncSource(p, assets, {})).toThrow("Choose");
		expect(() =>
			resolveLipSyncSource(p, assets, { segmentId: uuid(99) })
		).toThrow("not on the timeline");
	});

	test("refuses clips the viewer cannot hear", () => {
		const audio = asset(1, "audio");
		const muted = { ...newSegment(audio, 0), id: uuid(30), muted: true };
		const zero = { ...newSegment(audio, 0), id: uuid(31), volume: 0 };
		const onMutedTrack = { ...newSegment(audio, 0, 2), id: uuid(32) };
		const offSolo = { ...newSegment(audio, 0, 3), id: uuid(33) };
		const soloed = { ...newSegment(audio, 0, 4), id: uuid(34) };
		const rising = {
			...newSegment(audio, 0, 5),
			id: uuid(35),
			keyframes: [
				{ id: uuid(36), property: "volume" as const, time: 1, value: 0.8 },
			],
			volume: 0,
		};
		const p = project([avatar()], {
			segments: [muted, zero, onMutedTrack, offSolo, soloed, rising],
			trackSettings: [
				trackSettingSchema.parse({ muted: true, name: "Muted", track: 2 }),
				trackSettingSchema.parse({ name: "Solo A", solo: true, track: 4 }),
				trackSettingSchema.parse({ name: "Solo B", solo: true, track: 5 }),
			],
		});
		for (const clip of [muted, zero, onMutedTrack, offSolo]) {
			expect(isLipSyncClipAudible(p, clip)).toBe(false);
			expect(() =>
				resolveLipSyncSource(p, [audio], { segmentId: clip.id })
			).toThrow("muted or silent");
		}
		expect(isLipSyncClipAudible(p, soloed)).toBe(true);
		expect(isLipSyncClipAudible(p, rising)).toBe(true);
		expect(
			lipSyncSourceOptions(p, [audio], avatar()).map(lipSyncSourceKey)
		).toEqual([
			`segment:${soloed.id}`,
			`segment:${rising.id}`,
			`asset:${audio.id}`,
		]);
	});

	test("refuses hidden, hidden-track and high-speed-muted clips, which the export silences", () => {
		const audio = asset(1, "audio");
		const hidden = { ...newSegment(audio, 0), hidden: true, id: uuid(40) };
		const onHiddenTrack = { ...newSegment(audio, 0, 2), id: uuid(41) };
		const fast = { ...newSegment(audio, 0, 3), id: uuid(42), speed: 20 };
		const fastKept = {
			...newSegment(audio, 0, 4),
			id: uuid(43),
			muted: false,
			speed: 20,
		};
		const p = project([avatar()], {
			segments: [hidden, onHiddenTrack, fast, fastKept],
			trackSettings: [
				trackSettingSchema.parse({ hidden: true, name: "Hidden", track: 2 }),
			],
		});
		for (const clip of [hidden, onHiddenTrack, fast]) {
			expect(isLipSyncClipAudible(p, clip)).toBe(false);
			expect(() =>
				resolveLipSyncSource(p, [audio], { segmentId: clip.id })
			).toThrow("muted or silent");
		}
		expect(isLipSyncClipAudible(p, fastKept)).toBe(true);
		expect(
			lipSyncSourceOptions(p, [audio], avatar()).map(lipSyncSourceKey)
		).toEqual([`segment:${fastKept.id}`, `asset:${audio.id}`]);
	});

	test("offers overlapping audible clips before library media", () => {
		const audio = asset(1, "audio");
		const video = asset(2, "video", { hasAudio: false });
		const late = { ...newSegment(audio, 10), id: uuid(12) };
		const early = { ...newSegment(audio, 2), id: uuid(13) };
		const silent = { ...newSegment(video, 0, 1), id: uuid(14) };
		const base = avatar({ end: 6 });
		const options = lipSyncSourceOptions(
			project([base], { segments: [late, early, silent] }),
			[audio, video],
			base
		);
		expect(options.map(lipSyncSourceKey)).toEqual([
			`segment:${uuid(13)}`,
			`asset:${audio.id}`,
		]);
	});
});

describe("curve", () => {
	const audio = asset(1, "audio");
	const map = { kind: "asset" as const, duration: audio.duration };

	test("silence keeps the mouth closed", () => {
		const curve = lipSyncCurve({
			avatarDuration: 3,
			avatarStart: 0,
			envelope: envelope(3, []),
			map,
			sensitivity: 1,
			smoothing: 0.5,
			words: [{ end: 2, start: 0.5, text: "aaah" }],
		});
		expect(curve.values.every((value) => value === 0)).toBe(true);
		expect(curve.voicedRatio).toBe(0);
	});

	test("noise under the gate stays closed", () => {
		const quiet = {
			frameSeconds: LIP_SYNC_FRAME_SECONDS,
			values: Array.from({ length: 150 }, () => 0.0005),
		};
		const curve = lipSyncCurve({
			avatarDuration: 3,
			avatarStart: 0,
			envelope: quiet,
			map,
			sensitivity: 0.5,
			smoothing: 0,
		});
		expect(Math.max(...curve.values)).toBe(0);
	});

	test("speech opens the mouth and pauses close it", () => {
		const curve = lipSyncCurve({
			avatarDuration: 4,
			avatarStart: 0,
			envelope: envelope(4, [
				[0.5, 1.5],
				[2.5, 3.5],
			]),
			map,
			sensitivity: 0.5,
			smoothing: 0.2,
		});
		const at = (time: number) =>
			curve.values[Math.round(time / LIP_SYNC_FRAME_SECONDS)] ?? -1;
		expect(at(1)).toBeGreaterThan(0.5);
		expect(at(3)).toBeGreaterThan(0.5);
		expect(at(2)).toBe(0);
		expect(at(0.1)).toBe(0);
		expect(curve.voicedRatio).toBeGreaterThan(0.4);
		expect(curve.voicedRatio).toBeLessThan(0.65);
	});

	test("openness follows level^0.6 once normalized", () => {
		const flat = {
			frameSeconds: LIP_SYNC_FRAME_SECONDS,
			values: Array.from({ length: 100 }, (_, index) =>
				index < 50 ? 0.4 : 0.1
			),
		};
		const curve = lipSyncCurve({
			avatarDuration: 2,
			avatarStart: 0,
			envelope: flat,
			map,
			sensitivity: 0.5,
			smoothing: 0,
		});
		const gate = 10 ** (-45 / 20);
		const expected = ((0.1 - gate) / (0.4 - gate)) ** 0.6;
		expect(curve.values[10]).toBe(1);
		expect(curve.values[80]).toBeCloseTo(expected, 2);
	});

	test("bilabials close and vowel words widen", () => {
		const env = {
			frameSeconds: LIP_SYNC_FRAME_SECONDS,
			values: Array.from({ length: 200 }, (_, index) =>
				index < 100 ? 0.2 : 0.4
			),
		};
		const input = {
			avatarDuration: 4,
			avatarStart: 0,
			envelope: env,
			map,
			sensitivity: 0.5,
			smoothing: 0,
		};
		const plain = lipSyncCurve(input);
		const shaped = lipSyncCurve({
			...input,
			words: [
				{ end: 1.5, start: 0.5, text: "Ohio" },
				{ end: 3.4, start: 2.6, text: "map" },
			],
		});
		const index = (time: number) => Math.round(time / LIP_SYNC_FRAME_SECONDS);
		expect(shaped.values[index(1)] ?? 0).toBeGreaterThan(
			plain.values[index(1)] ?? 0
		);
		// "map": closure centered at 2.6 + (0.5/3)*0.8.
		expect(shaped.values[index(2.74)]).toBeLessThan(0.1);
		expect(shaped.values[index(3)]).toBe(plain.values[index(3)]);
	});

	test("word shapes merge doubled bilabials and ignore punctuation", () => {
		const shape = wordShape({ end: 1, start: 0, text: "Happy!" });
		expect(shape?.closures).toHaveLength(1);
		expect(shape?.widen).toBe(1);
		expect(wordShape({ end: 1, start: 0, text: "Aiee" })?.widen).toBe(1.25);
		expect(wordShape({ end: 1, start: 0, text: "—" })).toBeUndefined();
	});

	test("smoothing is zero-phase and bounded", () => {
		const impulse = [0, 0, 0, 1, 0, 0, 0];
		const smooth = smoothOpenness(impulse, 0.8);
		// The peak stays on the impulse: no lag from the two passes.
		expect(smooth.indexOf(Math.max(...smooth))).toBe(3);
		expect(Math.abs((smooth[2] ?? 0) - (smooth[4] ?? 0))).toBeLessThan(0.02);
		expect(Math.max(...smooth)).toBeLessThan(1);
		expect(smoothOpenness(impulse, 0)).toEqual(impulse);
	});

	test("sample times are 50 Hz and end exactly at the duration", () => {
		const times = lipSyncSampleTimes(0.1005);
		expect(times).toEqual([0, 0.02, 0.04, 0.06, 0.08, 0.1005]);
		expect(lipSyncSampleTimes(0)).toEqual([0]);
	});
});

describe("decimation", () => {
	test("keeps endpoints and never exceeds the budget", () => {
		const times = Array.from({ length: 5000 }, (_, index) => index * 0.02);
		const values = times.map((time) => (Math.sin(time * 9) + 1) / 2);
		for (const budget of [2, 7, 50, 100]) {
			const points = decimateLipSync(times, values, budget);
			expect(points.length).toBe(budget);
			expect(points[0]?.time).toBe(0);
			expect(points.at(-1)?.time).toBe(times.at(-1));
		}
	});

	test("a flat curve needs only its endpoints", () => {
		const times = [0, 1, 2, 3];
		expect(decimateLipSync(times, [0, 0, 0, 0], 100)).toEqual([
			{ time: 0, value: 0 },
			{ time: 3, value: 0 },
		]);
	});

	test("keeps the corners of a pulse exactly", () => {
		const times = [0, 1, 2, 3, 4, 5];
		const values = [0, 0, 1, 1, 0, 0];
		expect(
			decimateLipSync(times, values, 100).map((point) => point.time)
		).toEqual([0, 1, 2, 3, 4, 5]);
	});
});

describe("applyAvatarLipSync", () => {
	const audio = asset(1, "audio");

	test("writes at most 100 mouth keyframes alongside other rig keyframes", () => {
		const others = Array.from({ length: 30 }, (_, index) => ({
			id: uuid(500 + index),
			property: "head" as const,
			time: index * 0.1,
			value: index,
		}));
		const oldMouth = {
			id: uuid(600),
			property: "mouth" as const,
			time: 1,
			value: 0.9,
		};
		const base = avatar({ end: 60, rigKeyframes: [...others, oldMouth] });
		const p = project([base]);
		const busy = {
			frameSeconds: LIP_SYNC_FRAME_SECONDS,
			values: Array.from({ length: 3000 }, (_, index) =>
				index % 13 < 6 ? 0.3 + (index % 7) * 0.02 : 0
			),
		};
		const result = applyAvatarLipSync(p, {
			avatarId: base.id,
			envelope: busy,
			newId: counter(),
			sensitivity: 0.7,
			smoothing: 0.1,
			source: assetSource(audio),
		});
		const keyframes = result.avatar.rigKeyframes ?? [];
		expect(keyframes.length).toBe(MAX_AVATAR_RIG_KEYFRAMES);
		expect(result.keyframes).toBe(70);
		expect(keyframes.filter((item) => item.property === "head")).toHaveLength(
			30
		);
		expect(keyframes.some((item) => item.id === oldMouth.id)).toBe(false);
		expect(result.avatar.lipSync).toBeUndefined();
		// The result is a valid project (bounds, unique property:time and ids).
		expect(() => validateProject(result.project, [audio])).not.toThrow();
	});

	test("a silent source writes a closed mouth", () => {
		const base = avatar({ end: 5, start: 2 });
		const result = applyAvatarLipSync(project([base]), {
			avatarId: base.id,
			envelope: envelope(10, []),
			newId: counter(),
			source: assetSource(audio),
		});
		const mouth = result.avatar.rigKeyframes ?? [];
		expect(mouth.map((item) => [item.time, item.value])).toEqual([
			[0, 0],
			[3, 0],
		]);
		expect(avatarPoseAtTime(result.avatar, 3.5).mouth).toBe(0);
		expect("lipSync" in result.avatar).toBe(false);
	});

	test("clip timing drives the mouth only while the clip plays", () => {
		const clip = { ...newSegment(audio, 2), id: uuid(20), sourceOut: 1 };
		const base = avatar({ end: 4 });
		const p = project([base], { segments: [clip] });
		const source = resolveLipSyncSource(p, [audio], { segmentId: clip.id });
		const result = applyAvatarLipSync(p, {
			avatarId: base.id,
			envelope: envelope(20, [[0, 20]]),
			newId: counter(),
			smoothing: 0,
			source,
		});
		expect(avatarPoseAtTime(result.avatar, 1).mouth).toBe(0);
		expect(avatarPoseAtTime(result.avatar, 2.5).mouth).toBeGreaterThan(0.3);
		expect(avatarPoseAtTime(result.avatar, 3.5).mouth).toBe(0);
		expect(result.avatar.lipSync).toBeUndefined();
		expect(avatarRigExpression(result.avatar, "mouth")).toContain("if(lt(");
		expect(() => validateProject(result.project, [audio])).not.toThrow();
		// Regression: removing the source clip (or deleting the media) keeps
		// the project valid and the mouth keyframes intact.
		const withoutClip = { ...result.project, segments: [] };
		expect(() => validateProject(withoutClip, [audio])).not.toThrow();
		expect(() => validateProject(withoutClip, [])).not.toThrow();
		expect(
			validateProject(withoutClip, []).avatars[0]?.rigKeyframes?.length
		).toBe(result.keyframes);
	});

	test("clears a legacy lipSync reference on the next run", () => {
		const clip = { ...newSegment(audio, 0), id: uuid(21) };
		const legacy = avatar({
			lipSync: {
				assetId: audio.id,
				segmentId: clip.id,
				sensitivity: 0.2,
				smoothing: 0.9,
			},
		});
		const result = applyAvatarLipSync(project([legacy], { segments: [clip] }), {
			avatarId: legacy.id,
			envelope: envelope(20, [[0, 2]]),
			newId: counter(),
			source: assetSource(audio),
		});
		expect("lipSync" in result.avatar).toBe(false);
	});

	test("prunes lipSync references to removed clips or media", () => {
		const clip = { ...newSegment(audio, 0), id: uuid(22) };
		const link = { assetId: audio.id, sensitivity: 0.5, smoothing: 0.4 };
		const keyframe = {
			id: uuid(23),
			property: "mouth" as const,
			time: 1,
			value: 0.5,
		};
		const kept = avatar({ id: uuid(901), lipSync: link });
		const clipGone = avatar({
			id: uuid(902),
			lipSync: { ...link, segmentId: uuid(98) },
			rigKeyframes: [keyframe],
		});
		const p = project([kept, clipGone], { segments: [clip] });
		expect(() => validateProject(p, [audio])).toThrow("missing audio");
		const pruned = pruneDanglingLipSync(p, [audio]);
		expect(pruned.avatars[0]).toBe(kept);
		expect("lipSync" in (pruned.avatars[1] ?? {})).toBe(false);
		expect(pruned.avatars[1]?.rigKeyframes).toEqual([keyframe]);
		expect(() => validateProject(pruned, [audio])).not.toThrow();
		const mediaGone = pruneDanglingLipSync(p, []);
		expect(mediaGone.avatars.every((item) => !item.lipSync)).toBe(true);
		const clean = project([avatar()]);
		expect(pruneDanglingLipSync(clean, [audio])).toBe(clean);
	});

	test("refuses when the rig has no free keyframes or the avatar is missing", () => {
		const full = avatar({
			rigKeyframes: Array.from({ length: 99 }, (_, index) => ({
				id: uuid(700 + index),
				property: "leftArm" as const,
				time: index * 0.01,
				value: 0,
			})),
		});
		expect(lipSyncKeyframeBudget(full)).toBe(1);
		const p = project([full]);
		const input = {
			envelope: envelope(4, []),
			source: assetSource(audio),
		};
		expect(() =>
			applyAvatarLipSync(p, { ...input, avatarId: full.id })
		).toThrow("two free rig keyframes");
		expect(() =>
			applyAvatarLipSync(p, { ...input, avatarId: uuid(1) })
		).toThrow("not in this project");
	});
});

describe("request schema", () => {
	test("is strict and bounds its settings", () => {
		const base = { avatarId: uuid(1), revision: 0 };
		expect(avatarLipSyncRequestSchema.parse(base)).toEqual(base);
		expect(() =>
			avatarLipSyncRequestSchema.parse({ ...base, sensitivity: 2 })
		).toThrow();
		expect(() =>
			avatarLipSyncRequestSchema.parse({ ...base, extra: true })
		).toThrow();
		expect(
			avatarLipSyncRequestSchema.parse({ ...base, envelope: "analysis" })
				.envelope
		).toBe("analysis");
	});
});
