import { describe, expect, test } from "bun:test";
import {
	AUTO_CUT_STYLES,
	type AutoCutMoment,
	autoCutMedia,
	autoCutTransition,
	autoEditRequestSchema,
	beatSlots,
	buildAutoCutProject,
	buildShortProject,
	canvasForAspect,
	captionsForClips,
	centreReframe,
	defaultPublishPreset,
	fillSlots,
	MAX_AUTO_EDIT_SLOTS,
	rankMoments,
	recordReframes,
	shortsRequestSchema,
	shotMotion,
	subjectReframe,
	visibleSpans,
	windowLoudness,
} from "./auto-edit.ts";
import {
	type Asset,
	activeCaptions,
	newProject,
	newSegment,
	type Project,
	projectDuration,
	segmentDuration,
	validateProject,
} from "./project.ts";
import { reframeToSubjects, type SubjectTrack } from "./reframe.ts";
import { clipHeard } from "./sync-lock.ts";

function asset(
	kind: Asset["kind"],
	duration: number,
	size: { height: number; width: number } = { height: 1080, width: 1920 }
): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : size.height,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}-${duration}`,
		width: kind === "audio" ? 0 : size.width,
	};
}

function counter() {
	let next = 0;
	return () => {
		next += 1;
		return `00000000-0000-4000-8000-${next.toString(16).padStart(12, "0")}`;
	};
}

const beatsEvery = (step: number, until: number) =>
	Array.from({ length: Math.floor(until / step) }, (_, index) =>
		Number(((index + 1) * step).toFixed(3))
	);

describe("requests", () => {
	test("AutoCut defaults and bounds", () => {
		const id = crypto.randomUUID();
		const parsed = autoEditRequestSchema.parse({
			assetIds: [id],
			duration: 30,
		});
		expect(parsed.style).toBe("energetic");
		expect(parsed.aspect).toBe("16:9");
		expect(parsed.captions).toBe(false);
		expect(() =>
			autoEditRequestSchema.parse({ assetIds: [id, id], duration: 30 })
		).toThrow("List each source once.");
		expect(() =>
			autoEditRequestSchema.parse({ assetIds: [id], duration: 2 })
		).toThrow();
		expect(() =>
			autoEditRequestSchema.parse({ assetIds: [id], duration: 30, extra: 1 })
		).toThrow();
	});

	test("shorts defaults and min/max order", () => {
		const parsed = shortsRequestSchema.parse({ revision: 0 });
		expect(parsed).toMatchObject({
			aspect: "9:16",
			captions: true,
			count: 3,
			export: false,
			maxSeconds: 60,
			minSeconds: 15,
		});
		expect(() =>
			shortsRequestSchema.parse({ maxSeconds: 5, minSeconds: 10, revision: 0 })
		).toThrow("The longest short must be at least the shortest.");
	});

	test("canvas and default publish preset follow the aspect", () => {
		expect(canvasForAspect("9:16")).toEqual({ height: 1920, width: 1080 });
		expect(canvasForAspect("4:5")).toEqual({ height: 1350, width: 1080 });
		expect(canvasForAspect("1:1")).toEqual({ height: 1080, width: 1080 });
		expect(canvasForAspect("16:9")).toEqual({ height: 1080, width: 1920 });
		expect(defaultPublishPreset("9:16")).toBe("youtube-shorts");
		expect(defaultPublishPreset("16:9")).toBe("youtube-1080p");
		expect(defaultPublishPreset("1:1")).toBeUndefined();
	});

	test("media checks name the problem", () => {
		const video = asset("video", 10);
		const music = asset("audio", 30);
		expect(
			autoCutMedia({ assetIds: [video.id], musicAssetId: music.id }, [
				video,
				music,
			]).music?.id
		).toBe(music.id);
		expect(() => autoCutMedia({ assetIds: [music.id] }, [music])).toThrow(
			"AutoCut sources must be video or image media."
		);
		expect(() =>
			autoCutMedia({ assetIds: [video.id], musicAssetId: video.id }, [video])
		).toThrow("Choose an audio file");
		expect(() => autoCutMedia({ assetIds: [crypto.randomUUID()] }, [])).toThrow(
			"not in the media library"
		);
	});
});

describe("beat slots", () => {
	test("energetic slots start on beats and merge below the minimum", () => {
		const slots = beatSlots(
			{ detected: true, downbeats: [], times: beatsEvery(0.5, 10) },
			10,
			"energetic"
		);
		expect(slots[0]?.start).toBe(0);
		expect(slots.at(-1)?.end).toBe(10);
		for (const slot of slots) {
			expect(slot.end - slot.start).toBeGreaterThanOrEqual(
				AUTO_CUT_STYLES.energetic.minSlot - 1e-6
			);
			// Every cut lands on a beat (0.5 s grid).
			expect((slot.start * 2) % 1).toBeCloseTo(0, 6);
		}
		for (const [index, slot] of slots.entries()) {
			if (index > 0) {
				expect(slot.start).toBe(slots[index - 1]?.end ?? -1);
			}
		}
	});

	test("smooth slots use detected downbeats", () => {
		const slots = beatSlots(
			{
				detected: true,
				downbeats: [0.5, 2.5, 4.5, 6.5, 8.5],
				times: beatsEvery(0.5, 10),
			},
			10,
			"smooth"
		);
		expect(slots.map((slot) => slot.start)).toEqual([0, 2.5, 4.5, 6.5]);
		expect(slots.at(-1)?.end).toBe(10);
	});

	test("estimated beats fall back to every fourth beat for bars", () => {
		const slots = beatSlots(
			{ detected: false, times: beatsEvery(0.5, 12) },
			12,
			"minimal"
		);
		// Bars start on the first beat (0.5 s); the intro before it is slot 0.
		expect(slots.map((slot) => slot.start)).toEqual([
			0, 2.5, 4.5, 6.5, 8.5, 10.5,
		]);
	});

	test("no beats use the style's fixed grid and long gaps split", () => {
		const slots = beatSlots(undefined, 9, "smooth");
		expect(slots.map((slot) => slot.start)).toEqual([0, 3, 6]);
		const sparse = beatSlots(
			{ detected: false, times: [20, 40] },
			60,
			"energetic"
		);
		for (const slot of sparse) {
			expect(slot.end - slot.start).toBeLessThanOrEqual(
				AUTO_CUT_STYLES.energetic.maxSlot + 1e-6
			);
		}
		expect(sparse.at(-1)?.end).toBe(60);
	});

	test("slot count is bounded", () => {
		const slots = beatSlots(
			{ detected: true, times: beatsEvery(0.25, 600) },
			600,
			"energetic"
		);
		expect(slots.length).toBeLessThanOrEqual(MAX_AUTO_EDIT_SLOTS);
		expect(slots.at(-1)?.end).toBe(600);
	});
});

describe("ranking", () => {
	test("motion and loudness raise a moment's score", () => {
		const video = asset("video", 40);
		const waveform = {
			bins: Array.from({ length: 40 }, (_, index) =>
				index >= 20 && index < 30 ? 0.9 : 0.2
			),
			duration: 40,
		};
		const shots = [
			{ end: 20, motion: 0, start: 0 },
			{ end: 40, motion: 0.1, start: 20 },
		];
		const moments = rankMoments(
			{ asset: video, shots, waveform },
			{ maxLength: 10, minLength: 5 }
		);
		expect(moments.length).toBeGreaterThan(0);
		const best = moments[0];
		// The best window overlaps the loud, moving half.
		expect(best?.end).toBeGreaterThan(25);
		expect(best?.reasons).toContain("Motion");
		expect(shotMotion(shots, 20, 30)).toBe(1);
		expect(shotMotion(shots, 0, 10)).toBe(0);
		expect(windowLoudness(waveform, 20, 30)).toBe(1);
		expect(windowLoudness(undefined, 0, 1)).toBe(0);
	});

	test("unanalysed video gets evenly spaced windows and stills one moment", () => {
		const video = asset("video", 30);
		const moments = rankMoments(
			{ asset: video },
			{ maxLength: 6, minLength: 2 }
		);
		expect(moments.map((moment) => moment.start)).toEqual([0, 6, 12, 18, 24]);
		expect(moments.every((moment) => moment.end - moment.start === 6)).toBe(
			true
		);
		const still = rankMoments(
			{ asset: asset("image", 0) },
			{ maxLength: 6, minLength: 2 }
		);
		expect(still).toHaveLength(1);
		expect(still[0]?.still).toBe(true);
	});
});

describe("slot filling", () => {
	const moment = (
		assetId: string,
		start: number,
		end: number,
		score: number
	): AutoCutMoment => ({
		assetId,
		end,
		reasons: [],
		score,
		start,
		still: false,
	});

	test("alternates sources, strongest first, and consumes moments in order", () => {
		const a = asset("video", 20);
		const b = asset("video", 20);
		const slots = [
			{ end: 2, start: 0 },
			{ end: 4, start: 2 },
			{ end: 6, start: 4 },
			{ end: 8, start: 6 },
		];
		const placements = fillSlots(
			slots,
			[[moment(a.id, 0, 4, 0.4)], [moment(b.id, 10, 14, 0.9)]],
			[a, b]
		);
		expect(placements.map((placement) => placement.assetId)).toEqual([
			b.id,
			a.id,
			b.id,
			a.id,
		]);
		expect(placements.map((placement) => placement.sourceIn)).toEqual([
			10, 0, 12, 2,
		]);
		expect(
			placements.every(
				(placement) =>
					placement.sourceOut - placement.sourceIn === placement.duration
			)
		).toBe(true);
	});

	test("repeats the ranking when every moment is used", () => {
		const a = asset("video", 2);
		const placements = fillSlots(
			[
				{ end: 2, start: 0 },
				{ end: 4, start: 2 },
			],
			[[moment(a.id, 0, 2, 0.5)]],
			[a]
		);
		expect(placements.map((placement) => placement.sourceIn)).toEqual([0, 0]);
	});

	test("stretches a short source and refuses when it cannot", () => {
		const a = asset("video", 1.5);
		const [placement] = fillSlots(
			[{ end: 3, start: 0 }],
			[[moment(a.id, 0, 1.5, 0.5)]],
			[a]
		);
		expect(placement?.speed).toBe(0.5);
		expect(placement?.sourceOut).toBeCloseTo(1.5, 3);
		const tiny = asset("video", 0.2);
		expect(() =>
			fillSlots(
				[{ end: 3, start: 0 }],
				[[moment(tiny.id, 0, 0.2, 0.5)]],
				[tiny]
			)
		).toThrow("too short");
		expect(() => fillSlots([{ end: 3, start: 0 }], [[]], [])).toThrow(
			"usable media"
		);
	});

	test("plays a short moment in a long source at normal speed", () => {
		const long = asset("video", 100);
		const [placement] = fillSlots(
			[{ end: 4, start: 0 }],
			[[moment(long.id, 10, 11, 1)]],
			[long]
		);
		expect(placement?.speed).toBe(1);
		expect(placement?.sourceIn).toBe(10);
		expect(placement?.sourceOut).toBe(14);
		expect(placement?.duration).toBe(4);
	});
});

describe("transitions and reframe", () => {
	test("styles alternate their transitions on the chosen cuts", () => {
		expect(autoCutTransition("smooth", 0)).toBeUndefined();
		expect(autoCutTransition("smooth", 1)?.type).toBe("dissolve");
		expect(autoCutTransition("smooth", 2)?.type).toBe("blur");
		expect(autoCutTransition("smooth", 3)?.type).toBe("dissolve");
		expect(autoCutTransition("energetic", 3)).toBeUndefined();
		expect(autoCutTransition("energetic", 4)?.type).toBe("zoom");
		expect(autoCutTransition("energetic", 8)?.type).toBe("push-left");
		expect(autoCutTransition("minimal", 4)).toBeUndefined();
	});

	test("centre reframe fills mismatched aspects; subject reframe clamps its window", () => {
		const wide = asset("video", 10);
		const segment = newSegment(wide);
		const vertical = canvasForAspect("9:16");
		expect(centreReframe({ asset: wide, canvas: vertical, segment })).toEqual({
			fit: "fill",
		});
		expect(
			centreReframe({
				asset: wide,
				canvas: canvasForAspect("16:9"),
				segment,
			})
		).toEqual({});
		const right = subjectReframe({ x: 0.95, y: 0.5 })({
			asset: wide,
			canvas: vertical,
			segment,
		});
		const kept = (9 / 16) ** 2;
		expect(right.fit).toBe("fill");
		expect(right.crop?.right).toBe(0);
		expect(right.crop?.left).toBeCloseTo(1 - kept, 3);
		const centred = subjectReframe({ x: 0.5, y: 0.5 })({
			asset: wide,
			canvas: vertical,
			segment,
		});
		expect(centred.crop?.left).toBeCloseTo(centred.crop?.right ?? -1, 3);
	});

	test("recorded reframes list only the clips the centre crop changed", () => {
		const wide = asset("video", 10);
		const square = { ...asset("video", 10), height: 1080, width: 1080 };
		const recorded = recordReframes();
		const vertical = canvasForAspect("9:16");
		const first = newSegment(wide);
		const second = newSegment(square);
		expect(
			recorded.adapter({ asset: wide, canvas: vertical, segment: first })
		).toEqual({ fit: "fill" });
		expect(
			recorded.adapter({
				asset: square,
				canvas: canvasForAspect("1:1"),
				segment: second,
			})
		).toEqual({});
		expect(recorded.clipIds).toEqual([first.id]);
	});
});

describe("captions", () => {
	test("clip words map to the timeline and chunk", () => {
		const captions = captionsForClips(
			[
				{
					assetId: crypto.randomUUID(),
					sourceIn: 10,
					sourceOut: 12,
					speed: 1,
					start: 4,
					words: [
						{ end: 9.8, start: 9.5, text: "before" },
						{ end: 10.5, start: 10.1, text: "hello" },
						{ end: 11.2, start: 10.6, text: "there" },
						{ end: 12.5, start: 11.5, text: "friend" },
					],
				},
			],
			{ mode: "single-word" },
			counter()
		);
		expect(captions.map((caption) => caption.text)).toEqual([
			"hello",
			"there",
			"friend",
		]);
		expect(captions[0]?.start).toBeCloseTo(4.1, 3);
		expect(captions.at(-1)?.end).toBeCloseTo(6, 3);
	});
});

describe("AutoCut project", () => {
	test("fills beat slots, mutes sources under the music and reframes", () => {
		const a = asset("video", 30);
		const b = asset("video", 30);
		const still = asset("image", 0, { height: 1000, width: 1000 });
		const music = asset("audio", 12);
		const assets = [a, b, still, music];
		const beats = { detected: true, downbeats: [], times: beatsEvery(0.5, 12) };
		const result = buildAutoCutProject(
			newProject("AutoCut"),
			assets,
			{
				aspect: "9:16",
				assetIds: [a.id, b.id, still.id],
				duration: 20,
				musicAssetId: music.id,
				style: "energetic",
			},
			{ music: { asset: music, beats }, sources: [{ asset: a }, { asset: b }] },
			{ newId: counter() }
		);
		const { project } = result;
		expect(result.duration).toBe(12);
		expect(result.beatSource).toBe("detected");
		expect(project.width).toBe(1080);
		expect(project.height).toBe(1920);
		const visuals = project.segments.filter((segment) => segment.track === 0);
		expect(visuals).toHaveLength(result.slots.length);
		expect(projectDuration(project)).toBeCloseTo(12, 3);
		const musicClip = project.segments.find(
			(segment) => segment.assetId === music.id
		);
		expect(musicClip?.track).toBe(1);
		expect(musicClip?.sourceOut).toBe(12);
		for (const segment of visuals) {
			if (segment.assetId !== still.id) {
				expect(segment.muted).toBe(true);
			}
			expect(segment.fit).toBe("fill");
		}
		// Cuts land on slot starts (transitions only overlap backwards).
		for (const placement of result.placements) {
			const clip = project.segments.find(
				(segment) => segment.id === placement.clipId
			);
			expect(clip).toBeDefined();
			const end = (clip?.start ?? 0) + segmentDuration(clip ?? visuals[0]!);
			expect(end).toBeCloseTo(placement.start + placement.duration, 3);
		}
		expect(new Set(visuals.map((segment) => segment.assetId)).size).toBe(3);
		expect(() => validateProject(project, assets)).not.toThrow();
	});

	test("smooth style adds dissolves and captions come from the transcripts", () => {
		const a = asset("video", 40);
		const b = asset("video", 40);
		const words = Array.from({ length: 60 }, (_, index) => ({
			end: index * 0.6 + 0.5,
			start: index * 0.6,
			text: `word${index}${index % 6 === 5 ? "." : ""}`,
		}));
		const result = buildAutoCutProject(
			newProject("Smooth"),
			[a, b],
			{
				assetIds: [a.id, b.id],
				captions: true,
				duration: 18,
				style: "smooth",
			},
			{
				sources: [
					{ asset: a, words },
					{ asset: b, words },
				],
			},
			{ newId: counter() }
		);
		expect(result.slots.map((slot) => slot.start)).toEqual([
			0, 3, 6, 9, 12, 15,
		]);
		expect(result.transitions).toBe(5);
		const types = result.project.segments
			.map((segment) => segment.transitionIn?.type)
			.filter(Boolean);
		expect(types).toEqual(["dissolve", "blur", "dissolve", "blur", "dissolve"]);
		expect(result.captions).toBeGreaterThan(0);
		const captions = activeCaptions(result.project);
		expect(captions.every((caption) => caption.end <= 18 + 1e-6)).toBe(true);
		expect(result.project.captionChunking).toEqual({ mode: "words" });
		expect(projectDuration(result.project)).toBeCloseTo(18, 3);
	});

	test("captions never overlap when transitions overlap the clips", () => {
		const a = asset("video", 60);
		const b = asset("video", 60);
		const dense = (prefix: string) =>
			Array.from({ length: 200 }, (_, index) => ({
				end: Number((index * 0.3 + 0.3).toFixed(3)),
				start: Number((index * 0.3).toFixed(3)),
				text: `${prefix}${index}${index % 8 === 7 ? "." : ""}`,
			}));
		const result = buildAutoCutProject(
			newProject("Cinematic"),
			[a, b],
			{
				assetIds: [a.id, b.id],
				captions: true,
				duration: 12,
				style: "cinematic",
			},
			{
				sources: [
					{ asset: a, words: dense("a") },
					{ asset: b, words: dense("b") },
				],
			},
			{ newId: counter() }
		);
		expect(result.transitions).toBeGreaterThan(0);
		const captions = activeCaptions(result.project).toSorted(
			(left, right) => left.start - right.start
		);
		expect(captions.length).toBeGreaterThan(0);
		for (const [index, caption] of captions.entries()) {
			const previous = captions[index - 1];
			if (previous) {
				expect(caption.start).toBeGreaterThanOrEqual(previous.end - 1e-6);
			}
		}
	});

	test("visible spans end each clip where the next one starts", () => {
		const a = asset("video", 30);
		const first = {
			...newSegment(a, 0, 0),
			sourceIn: 0,
			sourceOut: 10,
			speed: 2,
		};
		const second = { ...newSegment(a, 4, 0), sourceIn: 20, sourceOut: 24 };
		const spans = visibleSpans([second, first]);
		expect(
			spans.map((span) => [span.start, span.sourceIn, span.sourceOut])
		).toEqual([
			[0, 0, 8],
			[4, 20, 24],
		]);
	});

	test("is deterministic for the same input", () => {
		const a = asset("video", 25);
		const run = () =>
			buildAutoCutProject(
				{ ...newProject("Same"), id: "00000000-0000-4000-8000-0000000000ff" },
				[a],
				{ assetIds: [a.id], duration: 10, style: "cinematic" },
				{ sources: [{ asset: a }] },
				{ newId: counter() }
			).project;
		const first = run();
		const second = run();
		expect({ ...second, updatedAt: first.updatedAt }).toEqual(first);
	});
});

describe("AutoCut captions", () => {
	test("source speech muted under the music bed does not become captions", () => {
		const video = asset("video", 20);
		const music = asset("audio", 30);
		const words = Array.from({ length: 40 }, (_, index) => ({
			end: index * 0.5 + 0.4,
			start: index * 0.5,
			text: `word${index}${index % 5 === 4 ? "." : ""}`,
		}));
		const build = (musicAssetId?: string) =>
			buildAutoCutProject(
				newProject("Muted speech"),
				[video, music],
				{
					assetIds: [video.id],
					captions: true,
					duration: 8,
					...(musicAssetId ? { musicAssetId } : {}),
				},
				{
					...(musicAssetId ? { music: { asset: music } } : {}),
					sources: [{ asset: video, words }],
				},
				{ newId: counter() }
			);
		const withMusic = build(music.id);
		const visuals = withMusic.project.segments.filter(
			(segment) => segment.track === 0
		);
		expect(
			visuals.every((segment) => !clipHeard(withMusic.project, segment))
		).toBe(true);
		expect(withMusic.captions).toBe(0);
		expect(activeCaptions(withMusic.project)).toEqual([]);
		// Without a music bed the sources are heard and captioned.
		expect(build().captions).toBeGreaterThan(0);
	});
});

describe("shorts", () => {
	function sourceProject(assets: Asset[]): Project {
		const [camera, music] = assets as [Asset, Asset];
		const base = newProject("Talk");
		const video = { ...newSegment(camera, 0, 0), sourceOut: 60 };
		const bed = { ...newSegment(music, 0, 1), sourceOut: 60 };
		return validateProject(
			{
				...base,
				captions: [
					{
						end: 12,
						id: crypto.randomUUID(),
						start: 10,
						text: "this is the best part",
					},
					{ end: 40, id: crypto.randomUUID(), start: 38, text: "later" },
				],
				segments: [video, bed],
				titles: [],
				trackSettings: [
					{ locked: true, muted: false, name: "Music", solo: false, track: 1 },
					{
						locked: false,
						muted: false,
						name: "Camera",
						solo: false,
						syncLocked: false,
						track: 0,
					},
				],
			},
			assets
		);
	}

	test("a short keeps only the window, reframes, captions one word at a time", () => {
		const camera = asset("video", 60);
		const music = asset("audio", 60);
		const assets = [camera, music];
		const source = sourceProject(assets);
		const short = buildShortProject(
			source,
			assets,
			{ end: 25, start: 8, title: "Best part" },
			2,
			{ aspect: "9:16", captions: true, newId: counter() }
		);
		expect(short.title).toBe("Talk · short 2");
		expect(short.width).toBe(1080);
		expect(short.height).toBe(1920);
		expect(projectDuration(short)).toBeCloseTo(17, 3);
		const video = short.segments.find((segment) => segment.track === 0);
		expect(video?.sourceIn).toBeCloseTo(8, 3);
		expect(video?.fit).toBe("fill");
		const bed = short.segments.find((segment) => segment.track === 1);
		expect(bed?.sourceIn).toBeCloseTo(8, 3);
		expect(bed?.fit).toBeUndefined();
		const captions = activeCaptions(short);
		expect(captions.map((caption) => caption.text)).toEqual([
			"this",
			"is",
			"the",
			"best",
			"part",
		]);
		expect(captions[0]?.start).toBeCloseTo(2, 3);
		expect(short.captionChunking).toEqual({ mode: "single-word" });
		expect(short.captionStyle?.presetId).toBe("punch");
		expect(short.exportSettings).toEqual({
			container: "mp4",
			platformPreset: "youtube-shorts",
		});
		// Track locks survive the cut.
		expect(short.trackSettings.find((s) => s.track === 1)?.locked).toBe(true);
		expect(() => validateProject(short, assets)).not.toThrow();
	});

	test("captions come from transcript words when the window has none", () => {
		const camera = asset("video", 60);
		const music = asset("audio", 60);
		const assets = [camera, music];
		const source = { ...sourceProject(assets), captions: [] };
		const short = buildShortProject(
			source,
			assets,
			{ end: 50, start: 30, title: "Later" },
			1,
			{
				aspect: "1:1",
				captions: true,
				newId: counter(),
				words: [
					{ end: 30.5, start: 30.1, text: "one" },
					{ end: 31.2, start: 30.6, text: "two" },
					{ end: 55, start: 54, text: "outside" },
				],
			}
		);
		expect(activeCaptions(short).map((caption) => caption.text)).toEqual([
			"one",
			"two",
		]);
		expect(short.width).toBe(1080);
		expect(short.height).toBe(1080);
		expect(short.exportSettings).toBeUndefined();
	});

	test("captions off and explicit preset; refuses windows outside the edit", () => {
		const camera = asset("video", 60);
		const music = asset("audio", 60);
		const assets = [camera, music];
		const source = sourceProject(assets);
		const short = buildShortProject(
			source,
			assets,
			{ end: 60, start: 0, title: "All" },
			1,
			{ aspect: "9:16", captions: false, publishPreset: "tiktok" }
		);
		expect(projectDuration(short)).toBeCloseTo(60, 3);
		expect(short.captionChunking).toBeUndefined();
		expect(short.exportSettings?.platformPreset).toBe("tiktok");
		expect(() =>
			buildShortProject(
				source,
				assets,
				{ end: 90, start: 70, title: "Nope" },
				1,
				{ aspect: "9:16", captions: false }
			)
		).toThrow("outside the timeline");
	});

	test("subject tracking keeps a clip's own crop and zoom keyframes", () => {
		const camera = asset("video", 60);
		const plain = asset("video", 60);
		const assets = [camera, plain];
		const framed = {
			...newSegment(camera),
			crop: { bottom: 0.1, left: 0, right: 0, top: 0.1 },
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "scale" as const,
					time: 0,
					value: 1,
				},
				{
					id: crypto.randomUUID(),
					property: "scale" as const,
					time: 20,
					value: 1.4,
				},
			],
			sourceOut: 20,
		};
		const open = { ...newSegment(plain, 20), sourceOut: 20 };
		const source = validateProject(
			{ ...newProject("Talk"), segments: [framed, open] },
			assets
		);
		const recorded = recordReframes();
		const short = buildShortProject(
			source,
			assets,
			{ end: 30, start: 5, title: "Mixed" },
			1,
			{ aspect: "9:16", captions: false, reframe: recorded.adapter }
		);
		const track: SubjectTrack = {
			cuts: [],
			points: Array.from({ length: 80 }, (_, index) => ({
				weight: 1,
				x: 0.2 + (index % 10) * 0.05,
				y: 0.5,
			})),
			sampleRate: 4,
		};
		const tracks = new Map(recorded.clipIds.map((id) => [id, track]));
		const centred = short.segments.find((s) => s.assetId === camera.id);
		const result = reframeToSubjects(short, assets, recorded.clipIds, tracks, {
			smoothing: 0,
		});
		const kept = result.project.segments.find((s) => s.assetId === camera.id);
		expect(kept).toEqual(centred);
		expect(kept?.crop).toEqual({ bottom: 0.1, left: 0, right: 0, top: 0.1 });
		expect(kept?.keyframes.map((frame) => frame.property)).toEqual([
			"scale",
			"scale",
		]);
		const notes = new Map(result.clips.map((clip) => [clip.clipId, clip]));
		expect(notes.get(kept?.id ?? "")?.mode).toBe("center");
		expect(notes.get(kept?.id ?? "")?.note).toContain("own crop");
		const followed = result.project.segments.find(
			(s) => s.assetId === plain.id
		);
		expect(notes.get(followed?.id ?? "")?.mode).toBe("track");
		expect(followed?.keyframes.some((frame) => frame.property === "x")).toBe(
			true
		);
	});
});
