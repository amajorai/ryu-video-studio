import { describe, expect, test } from "bun:test";
import { MAX_SEGMENTS } from "./limits.ts";
import { segmentPlacement } from "./preview-geometry.ts";
import {
	type Asset,
	activeCaptions,
	newProject,
	newSegment,
	type Project,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";
import {
	alignNarrationWords,
	assembleScriptVideo,
	heuristicScriptScenes,
	KEN_BURNS_MIN_SCALE,
	KEN_BURNS_ZOOM,
	kenBurnsKeyframes,
	MAX_SCRIPT_SCENES,
	narrationTimingFromTranscript,
	parseScriptPlan,
	parseWrittenScript,
	type ScriptAssembleInput,
	sceneKeywords,
	scriptSceneTimes,
	scriptSplitRequest,
	scriptWriterRequest,
	similarTokens,
	storyboardScript,
} from "./script-to-video.ts";
import { clipAudible } from "./sync-lock.ts";

function asset(
	kind: Asset["kind"],
	duration: number,
	name = `${kind}.bin`
): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 1280,
	};
}

function counter() {
	let next = 0;
	return () => {
		next += 1;
		return `00000000-0000-4000-8000-${next.toString(16).padStart(12, "0")}`;
	};
}

describe("scene planning", () => {
	test("split request carries the script and the scene bound", () => {
		const request = scriptSplitRequest("  Hello world.  ", { maxScenes: 99 });
		expect(request.prompt).toBe("Hello world.");
		expect(request.system).toContain(`1 to ${MAX_SCRIPT_SCENES} scenes`);
		expect(() => scriptSplitRequest("   ")).toThrow("Write a script first.");
	});

	test("parses fenced JSON, bare arrays and prose-wrapped replies", () => {
		const fenced = parseScriptPlan(
			'```json\n{"scenes":[{"narration":"The sun rises.","visualQuery":"sunrise sky","imagePrompt":"A sunrise."}]}\n```'
		);
		expect(fenced).toEqual([
			{
				imagePrompt: "A sunrise.",
				narration: "The sun rises.",
				visualQuery: "sunrise sky",
			},
		]);
		const bare = parseScriptPlan(
			'Here you go: [{"narration":"Mountains glow at dawn over mountains."},{"narration":"  "}] done'
		);
		expect(bare).toHaveLength(1);
		expect(bare[0]?.visualQuery).toBe("mountains glow dawn");
		expect(bare[0]?.imagePrompt).toContain("Mountains glow at dawn");
	});

	test("rejects replies without usable scenes", () => {
		expect(() => parseScriptPlan("no json here")).toThrow(
			"did not return JSON"
		);
		expect(() => parseScriptPlan('{"scenes":[]}')).toThrow();
		expect(() => parseScriptPlan('{"scenes":[{"visualQuery":"x"}]}')).toThrow(
			"missing its narration"
		);
	});

	test("keywords skip stop words and rank by frequency", () => {
		expect(
			sceneKeywords("The ocean and the ocean's waves meet the rocky coast")
		).toEqual(["ocean", "waves", "meet", "rocky"]);
	});

	test("heuristic split groups sentences and respects the scene cap", () => {
		const script = [
			"One two three four. Five six seven eight.",
			"",
			"Nine ten eleven twelve. Thirteen fourteen.",
		].join("\n");
		const scenes = heuristicScriptScenes(script, { targetWords: 5 });
		expect(scenes.map((scene) => scene.narration)).toEqual([
			"One two three four.",
			"Five six seven eight.",
			"Nine ten eleven twelve.",
			"Thirteen fourteen.",
		]);
		const capped = heuristicScriptScenes(script, {
			maxScenes: 2,
			targetWords: 5,
		});
		expect(capped).toHaveLength(2);
		expect(capped.map((scene) => scene.narration).join(" ")).toBe(
			"One two three four. Five six seven eight. Nine ten eleven twelve. Thirteen fourteen."
		);
	});
});

describe("narration alignment", () => {
	test("matched tokens take measured timing and keep script spelling", () => {
		const words = alignNarrationWords(
			"Hello, wonderful world!",
			[
				{ end: 0.4, start: 0.1, text: "hello" },
				{ end: 1.0, start: 0.5, text: "wonderfull" },
				{ end: 1.5, start: 1.1, text: "world" },
			],
			2
		);
		expect(words).toEqual([
			{ end: 0.4, start: 0.1, text: "Hello," },
			{ end: 1.0, start: 0.5, text: "wonderful" },
			{ end: 1.5, start: 1.1, text: "world!" },
		]);
	});

	test("script words missing from the transcript are spread between neighbours", () => {
		const words = alignNarrationWords(
			"a big red dog",
			[
				{ end: 0.2, start: 0, text: "a" },
				{ end: 2, start: 1.6, text: "dog" },
			],
			2
		);
		expect(words.map((word) => word.text)).toEqual(["a", "big", "red", "dog"]);
		expect(words[1]?.start ?? -1).toBeCloseTo(0.2, 6);
		expect(words[2]?.end ?? -1).toBeCloseTo(1.6, 6);
		for (const [index, word] of words.entries()) {
			expect(word.end).toBeGreaterThan(word.start);
			expect(word.start).toBeGreaterThanOrEqual(words[index - 1]?.end ?? 0);
		}
	});

	test("unrelated transcribed words never lend their timing", () => {
		expect(similarTokens("colour", "color")).toBe(true);
		expect(similarTokens("again", "world")).toBe(false);
		expect(similarTokens("a", "i")).toBe(false);
		const words = alignNarrationWords(
			"hello again",
			[
				{ end: 0.5, start: 0.1, text: "hello" },
				{ end: 2.9, start: 2, text: "world" },
			],
			3
		);
		expect(words[0]).toEqual({ end: 0.5, start: 0.1, text: "hello" });
		expect(words[1]).toEqual({ end: 3, start: 0.5, text: "again" });
	});

	test("without measured words the clip is spread by token length", () => {
		const words = alignNarrationWords("aa bbbb", [], 3);
		// Weights are length + 1: 3 and 5 of 8.
		expect(words[0]?.end ?? -1).toBeCloseTo(1.125, 6);
		expect(words[1]?.end ?? -1).toBeCloseTo(3, 6);
	});

	test("extra transcribed words and out-of-range words are ignored", () => {
		const words = alignNarrationWords(
			"go now",
			[
				{ end: 0.3, start: 0, text: "um" },
				{ end: 0.6, start: 0.4, text: "go" },
				{ end: 1, start: 0.7, text: "now" },
				{ end: 9, start: 8, text: "later" },
			],
			1
		);
		expect(words).toEqual([
			{ end: 0.6, start: 0.4, text: "go" },
			{ end: 1, start: 0.7, text: "now" },
		]);
	});

	test("degenerate timings become strictly increasing words", () => {
		const words = alignNarrationWords(
			"x y z",
			[
				{ end: 0.5, start: 0.49, text: "x" },
				{ end: 0.5, start: 0.495, text: "y" },
				{ end: 0.5, start: 0.499, text: "z" },
			],
			0.5
		);
		for (const [index, word] of words.entries()) {
			expect(word.end).toBeGreaterThan(word.start);
			expect(word.end).toBeLessThanOrEqual(0.5);
			expect(word.start).toBeGreaterThanOrEqual(words[index - 1]?.end ?? 0);
		}
	});

	test("transcript timing prefers words, then estimated cues", () => {
		const id = crypto.randomUUID();
		expect(narrationTimingFromTranscript(null)).toBeUndefined();
		expect(
			narrationTimingFromTranscript({
				cues: [{ end: 2, id, start: 0, text: "a bb" }],
				words: [],
			})
		).toEqual({
			measured: false,
			words: [
				{ end: 0.8, start: 0, text: "a" },
				{ end: 2, start: 0.8, text: "bb" },
			],
		});
		expect(
			narrationTimingFromTranscript({
				cues: [],
				words: [{ end: 1, id, start: 0.5, text: "hi" }],
			})?.measured
		).toBe(true);
	});
});

describe("assembly", () => {
	test("scene windows follow the narration with gaps", () => {
		expect(scriptSceneTimes([2, 3, 1], 5, 0.5)).toEqual([
			{ end: 7, start: 5 },
			{ end: 10.5, start: 7.5 },
			{ end: 12, start: 11 },
		]);
	});

	function library() {
		const voiceA = asset("audio", 2.5, "voice-1.wav");
		const voiceB = asset("audio", 4, "voice-2.wav");
		const still = asset("image", 0, "still.png");
		const longVideo = asset("video", 10, "long.mp4");
		const shortVideo = asset("video", 3, "short.mp4");
		const tinyVideo = asset("video", 1.3, "tiny.mp4");
		return { longVideo, shortVideo, still, tinyVideo, voiceA, voiceB };
	}

	test("narration is sequential and visuals match each narration", () => {
		const media = library();
		const assets = Object.values(media);
		const project = newProject("Script");
		const input: ScriptAssembleInput = {
			gap: 0.5,
			revision: 0,
			scenes: [
				{
					narrationAssetId: media.voiceA.id,
					text: "First scene words.",
					visualAssetId: media.still.id,
				},
				{
					narrationAssetId: media.voiceB.id,
					text: "Second scene words.",
					visualAssetId: media.longVideo.id,
				},
				{
					narrationAssetId: media.voiceB.id,
					text: "Third.",
					visualAssetId: media.shortVideo.id,
				},
			],
		};
		const result = assembleScriptVideo(project, assets, input, {
			newId: counter(),
		});
		expect(result.visualTrack).toBe(0);
		expect(result.narrationTrack).toBe(1);
		expect(result.duration).toBeCloseTo(2.5 + 0.5 + 4 + 0.5 + 4, 6);
		expect(
			result.scenes.map(({ end, start }) => [start, end] as const)
		).toEqual([
			[0, 2.5],
			[3, 7],
			[7.5, 11.5],
		]);
		const byId = new Map(
			result.project.segments.map((segment) => [segment.id, segment])
		);
		for (const scene of result.scenes) {
			const narration = byId.get(scene.narrationClipId);
			expect(narration?.track).toBe(1);
			expect(narration?.start).toBeCloseTo(scene.start, 9);
			const clips = scene.visualClipIds.map((id) => byId.get(id));
			const covered = clips.reduce(
				(sum, clip) => sum + (clip ? segmentDuration(clip) : 0),
				0
			);
			expect(covered).toBeCloseTo(scene.end - scene.start, 6);
			for (const clip of clips) {
				expect(clip?.volume).toBe(0);
				expect(clip?.fit).toBe("fill");
			}
		}
		const still = byId.get(result.scenes[0]?.visualClipIds[0] ?? "");
		expect(
			still?.keyframes.filter((frame) => frame.property === "scale")
		).toMatchObject([
			{ time: 0, value: KEN_BURNS_MIN_SCALE },
			{ time: 2.5, value: KEN_BURNS_ZOOM },
		]);
		// The long video is trimmed; the short one is slowed to fill 4 s.
		const trimmed = byId.get(result.scenes[1]?.visualClipIds[0] ?? "");
		expect([trimmed?.sourceOut, trimmed?.speed]).toEqual([4, 1]);
		const stretched = byId.get(result.scenes[2]?.visualClipIds[0] ?? "");
		expect(stretched?.speed).toBeCloseTo(3 / 4, 9);
		expect(stretched?.sourceOut).toBeCloseTo(3, 9);
		expect(stretched?.keyframes).toEqual([]);
	});

	test("a much shorter video is tiled to the narration length", () => {
		const media = library();
		const result = assembleScriptVideo(
			newProject("Tiles"),
			Object.values(media),
			{
				kenBurns: false,
				revision: 0,
				scenes: [
					{
						narrationAssetId: media.voiceB.id,
						text: "Tiled.",
						visualAssetId: media.tinyVideo.id,
					},
				],
			}
		);
		const clips = result.project.segments.filter(
			(segment) => segment.assetId === media.tinyVideo.id
		);
		const starts = clips.map((clip) => clip.start);
		expect(starts).toHaveLength(4);
		for (const [index, start] of starts.entries()) {
			expect(start).toBeCloseTo(index * 1.3, 9);
		}
		expect(
			clips.reduce((sum, clip) => sum + segmentDuration(clip), 0)
		).toBeCloseTo(4, 9);
		expect(clips.at(-1)?.sourceOut).toBeCloseTo(0.1, 9);
	});

	test("a sub-frame remainder stretches the last tile instead", () => {
		const media = library();
		const voice = asset("audio", 3.92, "voice-3.wav");
		const result = assembleScriptVideo(
			newProject("Stretch"),
			[...Object.values(media), voice],
			{
				revision: 0,
				scenes: [
					{
						narrationAssetId: voice.id,
						text: "Stretched.",
						visualAssetId: media.tinyVideo.id,
					},
				],
			}
		);
		const clips = result.project.segments.filter(
			(segment) => segment.assetId === media.tinyVideo.id
		);
		expect(clips).toHaveLength(3);
		expect(clips.at(-1)?.speed).toBeCloseTo(1.3 / 1.32, 9);
		expect(clips.at(-1)?.sourceOut).toBeCloseTo(1.3, 9);
		expect(
			clips.reduce((sum, clip) => sum + segmentDuration(clip), 0)
		).toBeCloseTo(3.92, 9);
	});

	test("appends after the current edit on free tracks", () => {
		const media = library();
		const existing = asset("video", 6, "existing.mp4");
		const project: Project = {
			...newProject("Append"),
			segments: [newSegment(existing, 0, 0)],
		};
		const result = assembleScriptVideo(
			project,
			[...Object.values(media), existing],
			{
				revision: 0,
				scenes: [
					{
						narrationAssetId: media.voiceA.id,
						text: "After.",
						visualAssetId: media.still.id,
					},
				],
			}
		);
		expect(result.scenes[0]?.start).toBe(6);
		expect(result.visualTrack).toBe(0);
		// Track 0 already holds video, so narration takes the next free track.
		expect(result.narrationTrack).toBe(1);
	});

	test("captions follow measured narration timing and chunking", () => {
		const media = library();
		const result = assembleScriptVideo(
			newProject("Captions"),
			Object.values(media),
			{
				at: 10,
				captionChunking: { maxWords: 2, mode: "words" },
				revision: 0,
				scenes: [
					{
						narrationAssetId: media.voiceA.id,
						text: "Alpha beta gamma.",
						visualAssetId: media.still.id,
					},
					{
						narrationAssetId: media.voiceB.id,
						text: "Delta epsilon.",
						visualAssetId: media.longVideo.id,
					},
				],
			},
			{
				narrationTiming: (id) =>
					id === media.voiceA.id
						? {
								measured: true,
								words: [
									{ end: 0.5, start: 0.2, text: "alpha" },
									{ end: 1.1, start: 0.6, text: "beta" },
									{ end: 2, start: 1.5, text: "gamma" },
								],
							}
						: undefined,
			}
		);
		const captions = activeCaptions(result.project);
		expect(result.captions).toBe(captions.length);
		expect(result.project.captionChunking).toEqual({
			maxWords: 2,
			mode: "words",
		});
		expect(
			captions.map(({ end, start, text }) => ({ end, start, text }))
		).toEqual([
			{ end: 11.1, start: 10.2, text: "Alpha beta" },
			{ end: 12, start: 11.5, text: "gamma." },
			{ end: expect.any(Number), start: 12.5, text: "Delta epsilon." },
		]);
		// Measured scenes carry word timing; estimated scenes do not.
		expect(captions[0]?.words?.map((word) => word.start)).toEqual([10.2, 10.6]);
		expect(captions[2]?.words).toBeUndefined();
		expect(captions[2]?.end).toBeCloseTo(16.5, 9);
		for (const caption of captions) {
			expect(caption.sourceAssetId).toBeDefined();
		}
	});

	test("overlapping captions are replaced and captions can be skipped", () => {
		const media = library();
		const keep = {
			end: 1,
			id: crypto.randomUUID(),
			start: 0,
			text: "Keep me",
		};
		const drop = {
			end: 3,
			id: crypto.randomUUID(),
			start: 1.5,
			text: "Replace me",
		};
		const project: Project = { ...newProject("Mixed"), captions: [keep, drop] };
		const scenes = [
			{
				narrationAssetId: media.voiceA.id,
				text: "New words here.",
				visualAssetId: media.still.id,
			},
		];
		const result = assembleScriptVideo(project, Object.values(media), {
			at: 1,
			revision: 0,
			scenes,
		});
		expect(result.replacedCaptions).toBe(1);
		expect(result.project.captions[0]?.text).toBe("Keep me");
		expect(result.project.captions.some((c) => c.text === "Replace me")).toBe(
			false
		);
		const silent = assembleScriptVideo(project, Object.values(media), {
			at: 1,
			captions: false,
			revision: 0,
			scenes,
		});
		expect(silent.captions).toBe(0);
		expect(silent.project.captions).toEqual([keep, drop]);
	});

	test("Ken Burns stills cover the whole frame throughout", () => {
		const still = asset("image", 0, "still.png");
		const frame = { height: 1080, width: 1920 };
		const content = { height: 1080, width: 1920 };
		for (const index of [0, 1, 2, 3]) {
			const clip = {
				...newSegment(still, 0, 0),
				fit: "fill" as const,
				keyframes: kenBurnsKeyframes(4, index, counter()),
				sourceIn: 0,
				sourceOut: 4,
			};
			for (const time of [0, 1, 2, 3, 4]) {
				const { visible } = segmentPlacement(clip, content, frame, time);
				expect(visible.cx - visible.width / 2).toBeLessThanOrEqual(0);
				expect(visible.cx + visible.width / 2).toBeGreaterThanOrEqual(1);
				expect(visible.cy - visible.height / 2).toBeLessThanOrEqual(0);
				expect(visible.cy + visible.height / 2).toBeGreaterThanOrEqual(1);
			}
		}
	});

	test("very short videos fail fast instead of tiling without bound", () => {
		const voice = asset("audio", 7200, "long-voice.wav");
		const scene = {
			narrationAssetId: voice.id,
			text: "Long narration.",
		};
		const blip = asset("video", 0.0001, "blip.mp4");
		const began = performance.now();
		expect(() =>
			assembleScriptVideo(newProject("Blip"), [voice, blip], {
				revision: 0,
				scenes: [{ ...scene, visualAssetId: blip.id }],
			})
		).toThrow("Scene 1 video is too short to fill the narration");
		const short = asset("video", 0.5, "short.mp4");
		expect(() =>
			assembleScriptVideo(newProject("Short"), [voice, short], {
				revision: 0,
				scenes: [{ ...scene, visualAssetId: short.id }],
			})
		).toThrow("Scene 1 video would need 14400 repeats");
		expect(performance.now() - began).toBeLessThan(1000);
		// Tiles within the clip budget still assemble.
		const fits = asset("video", 7200 / (MAX_SEGMENTS - 1), "fits.mp4");
		const result = assembleScriptVideo(newProject("Fits"), [voice, fits], {
			captions: false,
			revision: 0,
			scenes: [{ ...scene, visualAssetId: fits.id }],
		});
		expect(result.project.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
	});

	test("too many captions fail with a readable message", () => {
		const voice = asset("audio", 120, "voice.wav");
		const still = asset("image", 0, "still.png");
		const text = Array.from({ length: 300 }, () => "word").join(" ");
		expect(() =>
			assembleScriptVideo(newProject("Wordy"), [voice, still], {
				captionChunking: { mode: "single-word" },
				revision: 0,
				scenes: Array.from({ length: MAX_SCRIPT_SCENES }, () => ({
					narrationAssetId: voice.id,
					text,
					visualAssetId: still.id,
				})),
			})
		).toThrow("Captions would exceed 5000; choose phrase captions");
	});

	test("rejects missing or mismatched media", () => {
		const media = library();
		const assets = Object.values(media);
		const project = newProject("Bad");
		const scene = {
			narrationAssetId: media.voiceA.id,
			text: "Words.",
			visualAssetId: media.still.id,
		};
		expect(() =>
			assembleScriptVideo(project, assets, {
				revision: 0,
				scenes: [{ ...scene, narrationAssetId: media.still.id }],
			})
		).toThrow("Scene 1 narration must be audio media.");
		expect(() =>
			assembleScriptVideo(project, assets, {
				revision: 0,
				scenes: [{ ...scene, visualAssetId: media.voiceB.id }],
			})
		).toThrow("Scene 1 visual must be a video or image.");
		expect(() =>
			assembleScriptVideo(project, assets, {
				revision: 0,
				scenes: [{ ...scene, visualAssetId: crypto.randomUUID() }],
			})
		).toThrow("not in the library");
		expect(() =>
			assembleScriptVideo(project, assets, { revision: 0, scenes: [] })
		).toThrow();
	});

	test("narration lands only on an audible track", () => {
		const media = library();
		const assets = Object.values(media);
		const input: ScriptAssembleInput = {
			at: 0,
			revision: 0,
			scenes: [
				{
					narrationAssetId: media.voiceA.id,
					text: "Heard words.",
					visualAssetId: media.still.id,
				},
			],
		};
		const narrationOf = (result: ReturnType<typeof assembleScriptVideo>) =>
			result.project.segments.find(
				(segment) => segment.id === result.scenes[0]?.narrationClipId
			)!;
		const muted = updateTrackSetting(newProject("Muted"), 1, { muted: true });
		const skipped = assembleScriptVideo(muted, assets, input, {
			newId: counter(),
		});
		expect(skipped.narrationTrack).toBe(2);
		expect(skipped.captions).toBe(1);
		expect(clipAudible(skipped.project, narrationOf(skipped))).toBe(true);
		const music = { ...newSegment(media.voiceB, 20, 5), sourceOut: 4 };
		const soloed = updateTrackSetting(
			{ ...newProject("Solo"), segments: [music] },
			5,
			{ solo: true }
		);
		const onSolo = assembleScriptVideo(soloed, assets, input, {
			newId: counter(),
		});
		expect(onSolo.narrationTrack).toBe(5);
		expect(clipAudible(onSolo.project, narrationOf(onSolo))).toBe(true);
		const blocked = updateTrackSetting(
			{
				...newProject("Blocked"),
				segments: [{ ...music, start: 0 }],
			},
			5,
			{ solo: true }
		);
		expect(() =>
			assembleScriptVideo(blocked, assets, input, { newId: counter() })
		).toThrow("No free, audible audio track");
	});
});

describe("script writer", () => {
	test("the request asks for spoken text of the target length", () => {
		const request = scriptWriterRequest("How tides work", {
			brief: "For kids",
			seconds: 40,
		});
		expect(request.system).toContain("about 100 words");
		expect(JSON.parse(request.prompt)).toEqual({
			brief: "For kids",
			topic: "How tides work",
		});
		expect(() => scriptWriterRequest("   ")).toThrow("Describe");
	});

	test("written scripts lose markdown, labels and stage directions", () => {
		expect(
			parseWrittenScript(
				"```\n# Tides\n\nNarrator: The sea rises **twice** a day. [music swells]\n\n\n\n- The moon pulls the water.\n```"
			)
		).toBe("The sea rises twice a day.\n\nThe moon pulls the water.");
		expect(() => parseWrittenScript("```\n```")).toThrow("did not write");
	});

	test("storyboard scripts join in scene order", () => {
		expect(
			storyboardScript([
				{ script: " One. " },
				{ script: "" },
				{ script: "Two." },
			])
		).toBe("One.\n\nTwo.");
	});
});
