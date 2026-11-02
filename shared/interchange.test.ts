import { expect, test } from "bun:test";
import { z } from "zod";
import {
	interchangeFilename,
	interchangeText,
	OTIO_SPEED_CURVE_EFFECT,
	readOtioSpeedCurves,
} from "./interchange.ts";
import { newProject, newSegment, segmentDuration } from "./project.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	naturalCurveSpeed,
} from "./speed-curve.ts";

function asset(
	kind: "audio" | "image" | "video",
	name: string,
	id = crypto.randomUUID()
) {
	return {
		createdAt: new Date().toISOString(),
		duration: 4,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id,
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

test("FCPXML includes referenced sources, lanes, and escaped project names", () => {
	const video = asset("video", "Hero & take");
	const audio = asset("audio", "Voice <clean>");
	const unused = asset("image", "Unused");
	const project = newProject("Launch <cut>");
	project.segments = [newSegment(video, 0, 0), newSegment(audio, 0, 1)];
	project.segments[0]!.sourceOut = 2;
	project.segments[1]!.sourceOut = 2;
	const text = interchangeText(project, [video, audio, unused], "fcpxml");
	expect(text).toContain("Launch &lt;cut&gt;");
	expect(text).toContain("Hero &amp; take");
	expect(text).toContain("Voice &lt;clean&gt;");
	// Connected audio sits below the primary storyline (negative lane).
	expect(text).toContain('lane="-1"');
	expect(text).not.toContain("Unused");
	expect(text).toContain('frameDuration="1/30s"');
});

test("XMEML separates visual and audio tracks and preserves source frames", () => {
	const video = asset("video", "Picture");
	const audio = asset("audio", "Dialogue");
	const project = newProject("Premiere export");
	const picture = newSegment(video, 1, 0);
	picture.sourceOut = 3;
	const dialogue = newSegment(audio, 1, 1);
	dialogue.sourceOut = 3;
	project.segments = [picture, dialogue];
	const text = interchangeText(project, [video, audio], "xmeml");
	const videoSection = text.match(/<video>([\s\S]*?)<\/video>/)?.[1] ?? "";
	const audioSection = text.match(/<audio>([\s\S]*?)<\/audio>/)?.[1] ?? "";
	expect(videoSection).toContain("Picture");
	expect(videoSection).not.toContain("Dialogue");
	expect(audioSection).toContain("Dialogue");
	expect(audioSection).not.toContain("Picture");
	expect(text).toContain("<start>30</start>");
	expect(text).toContain("<in>0</in>");
	expect(text).toContain("<out>90</out>");
});

test("interchange filenames stay bounded and safe for downloads", () => {
	const project = newProject("  A launch: final / take?  ");
	expect(interchangeFilename(project, "fcpxml")).toBe(
		"A-launch-final-take.fcpxml"
	);
	expect(interchangeFilename({ title: "" }, "xmeml")).toBe(
		"video-studio-project.xml"
	);
});

test("XMEML marks NTSC timebases and counts frames on the 1000/1001 grid", () => {
	const video = asset("video", "Picture");
	const project = { ...newProject("NTSC"), fps: 29.97 as const };
	const picture = newSegment(video, 1.001, 0);
	picture.sourceOut = 2.002;
	project.segments = [picture];
	const text = interchangeText(project, [video], "xmeml");
	expect(text).toContain(
		"<rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>"
	);
	expect(text).not.toContain("<ntsc>FALSE</ntsc>");
	expect(text).toContain("<start>30</start>");
	expect(text).toContain("<out>60</out>");
	const film = interchangeText(
		{ ...project, fps: 23.976 as const },
		[video],
		"xmeml"
	);
	expect(film).toContain("<timebase>24</timebase><ntsc>TRUE</ntsc>");
	const integer = interchangeText(
		{ ...project, fps: 25 as const },
		[video],
		"xmeml"
	);
	expect(integer).toContain("<timebase>25</timebase><ntsc>FALSE</ntsc>");
});

test("FCPXML uses rational frame durations and frame-aligned times for NTSC", () => {
	const video = asset("video", "Picture");
	const project = { ...newProject("NTSC"), fps: 29.97 as const };
	const picture = newSegment(video, 1.001, 1);
	picture.sourceIn = 0.5;
	picture.sourceOut = 2.002;
	project.segments = [picture];
	const text = interchangeText(project, [video], "fcpxml");
	expect(text).toContain('frameDuration="1001/30000s"');
	expect(text).toContain('offset="30030/30000s"');
	// 0.5 s is 14.985 frames: it snaps to frame 15.
	expect(text).toContain('start="15015/30000s"');
	expect(text).toContain('duration="45045/30000s"');
	expect(text).toContain(`duration="120120/30000s"`);
	expect(
		interchangeText({ ...project, fps: 59.94 as const }, [video], "fcpxml")
	).toContain('frameDuration="1001/60000s"');
	const integer = interchangeText(
		{ ...project, fps: 25 as const },
		[video],
		"fcpxml"
	);
	expect(integer).toContain('frameDuration="1/25s"');
	// Integer rates are frame-aligned too: 1.001 s is frame 25 at 25 fps.
	expect(integer).toContain('offset="1s"');
});

const NTSC_FRAME = 1001 / 30_000;
const attribute = (text: string, tag: string, name: string): string[] =>
	[
		...text.matchAll(
			new RegExp(`<${tag} [^>]*${name}="(\\d+)(?:/30000)?s"`, "g")
		),
	].map((match) => match[1] ?? "");
const frames = (value: string) => Number(value) / 1001;

test("FCPXML keeps an NTSC clip ending at the media end inside the asset", () => {
	const video = { ...asset("video", "Short"), duration: 30.3 * NTSC_FRAME };
	const project = { ...newProject("NTSC"), fps: 29.97 as const };
	const clip = newSegment(video, 0, 0);
	clip.sourceIn = 0.65 * NTSC_FRAME;
	clip.sourceOut = video.duration;
	project.segments = [clip];
	const text = interchangeText(project, [video], "fcpxml");
	const [assetDuration] = attribute(text, "asset", "duration").map(frames);
	const [start] = attribute(text, "asset-clip", "start").map(frames);
	const [duration] = attribute(text, "asset-clip", "duration").map(frames);
	expect(assetDuration).toBe(31);
	expect((start ?? 0) + (duration ?? 0)).toBeLessThanOrEqual(
		assetDuration ?? 0
	);
	const xmeml = interchangeText(project, [video], "xmeml");
	const out = Number(/<out>(\d+)<\/out>/.exec(xmeml)?.[1]);
	const sourceIn = Number(/<in>(\d+)<\/in>/.exec(xmeml)?.[1]);
	const clipDuration = Number(/<duration>(\d+)<\/duration>/.exec(xmeml)?.[1]);
	expect(out).toBeLessThanOrEqual(31);
	expect(out - sourceIn).toBe(clipDuration);
});

test("NTSC clips snap boundaries so adjacent spine clips never gap or overlap", () => {
	const video = { ...asset("video", "Picture"), duration: 10 };
	const project = { ...newProject("NTSC"), fps: 29.97 as const };
	const lengths = [0.4, 0.73, 1.1, 0.517];
	let start = 0;
	project.segments = lengths.map((length) => {
		const clip = newSegment(video, start, 0);
		clip.sourceIn = 0.2;
		clip.sourceOut = 0.2 + length;
		start += length;
		return clip;
	});
	const text = interchangeText(project, [video], "fcpxml");
	const offsets = attribute(text, "asset-clip", "offset").map(frames);
	const durations = attribute(text, "asset-clip", "duration").map(frames);
	expect(offsets).toHaveLength(lengths.length);
	for (let index = 1; index < offsets.length; index += 1) {
		expect((offsets[index - 1] ?? 0) + (durations[index - 1] ?? 0)).toBe(
			offsets[index] ?? -1
		);
	}
	const xmeml = interchangeText(project, [video], "xmeml");
	const starts = [...xmeml.matchAll(/<start>(\d+)<\/start>/g)].map((m) =>
		Number(m[1])
	);
	const endFrames = [...xmeml.matchAll(/<end>(\d+)<\/end>/g)].map((m) =>
		Number(m[1])
	);
	expect(endFrames).toHaveLength(lengths.length);
	for (let index = 1; index < starts.length; index += 1) {
		expect(endFrames[index - 1]).toBe(starts[index] ?? -1);
	}
	const ins = [...xmeml.matchAll(/<in>(\d+)<\/in>/g)].map((m) => Number(m[1]));
	const outs = [...xmeml.matchAll(/<out>(\d+)<\/out>/g)].map((m) =>
		Number(m[1])
	);
	const clipDurations = [
		...xmeml.matchAll(
			/<clipitem[^>]*>\s*<name>[^<]*<\/name>\s*<duration>(\d+)/g
		),
	].map((m) => Number(m[1]));
	expect(clipDurations).toHaveLength(lengths.length);
	for (const [index, duration] of clipDurations.entries()) {
		expect((outs[index] ?? 0) - (ins[index] ?? 0)).toBe(duration);
	}
});

/** Tag balance check: every opened element closes, in order. */
function wellFormed(text: string): boolean {
	const stack: string[] = [];
	for (const match of text.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
		const [, closing, name, selfClosing] = match;
		if (selfClosing) {
			continue;
		}
		if (closing) {
			if (stack.pop() !== name) {
				return false;
			}
		} else {
			stack.push(name ?? "");
		}
	}
	return stack.length === 0;
}

function editedProject() {
	const video = { ...asset("video", "Picture"), duration: 10 };
	const music = { ...asset("audio", "Music"), duration: 10 };
	const project = newProject("Finishing");
	const first = { ...newSegment(video, 0, 0), fadeIn: 0.5, sourceOut: 4 };
	// The second clip reveals over the first with a 1 s dissolve (overlap 3..4).
	const second = {
		...newSegment(video, 3, 0),
		fadeOut: 1,
		sourceIn: 5,
		sourceOut: 8,
		transitionIn: { duration: 1, softness: 0, type: "dissolve" as const },
	};
	const fast = {
		...newSegment(video, 2, 1),
		speed: 2,
		sourceIn: 0,
		sourceOut: 2,
	};
	const bed = {
		...newSegment(music, 0, 2),
		fadeIn: 1,
		fadeOut: 1,
		keyframes: [
			{
				id: crypto.randomUUID(),
				property: "volume" as const,
				time: 0,
				value: 0.5,
			},
			{
				id: crypto.randomUUID(),
				property: "volume" as const,
				time: 2,
				value: 1,
			},
		],
		sourceOut: 6,
		volume: 0.5,
	};
	project.segments = [first, second, fast, bed];
	return { first, music, project, second, video };
}

test("XMEML carries fades, reveal dissolves, speed and audio levels", () => {
	const { music, project, video } = editedProject();
	const text = interchangeText(project, [video, music], "xmeml");
	expect(wellFormed(text)).toBe(true);
	const videoSection = text.match(/<video>([\s\S]*?)<\/video>/)?.[1] ?? "";
	const audioSection = text.match(/<audio>([\s\S]*?)<\/audio>/)?.[1] ?? "";
	// Fade in from black over 15 frames at the first clip's start.
	expect(videoSection).toMatch(
		/<transitionitem>[\s\S]*?<start>0<\/start>\s*<end>15<\/end>\s*<alignment>start-black<\/alignment>[\s\S]*?Cross Dissolve/
	);
	// The reveal becomes a centred dissolve at the middle of the overlap (3.5 s).
	expect(videoSection).toMatch(
		/<start>90<\/start>\s*<end>120<\/end>\s*<alignment>center<\/alignment>/
	);
	// Butted at the cut: first ends at 105, second starts there with its in point moved.
	expect(videoSection).toContain("<end>105</end>");
	expect(videoSection).toMatch(
		/<start>105<\/start>\s*<end>180<\/end>\s*<in>165<\/in>/
	);
	// Fade out to black at the second clip's end (6 s).
	expect(videoSection).toMatch(
		/<start>150<\/start>\s*<end>180<\/end>\s*<alignment>end-black<\/alignment>/
	);
	expect(videoSection).toContain("<effectid>timeremap</effectid>");
	expect(videoSection).toMatch(
		/<parameterid>speed<\/parameterid>[\s\S]*?<value>200<\/value>/
	);
	// Music: cross fades from and to silence, a level, and level keyframes.
	expect(audioSection).toContain("KGAudioTransCrossFade3dB");
	expect(audioSection).toContain("<alignment>start-black</alignment>");
	expect(audioSection).toContain("<alignment>end-black</alignment>");
	expect(audioSection).toMatch(
		/<parameterid>level<\/parameterid>[\s\S]*?<value>0.5<\/value>/
	);
	expect(audioSection).toMatch(/<when>60<\/when>\s*<value>1<\/value>/);
});

test("FCPXML nests connected clips, adds dissolves, retimes and audio fades", () => {
	const { music, project, video } = editedProject();
	const text = interchangeText(project, [video, music], "fcpxml");
	expect(wellFormed(text)).toBe(true);
	expect(text).toContain(
		'<effect id="effect-dissolve" name="Cross Dissolve" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265" />'
	);
	// Fade in, reveal at the cut (3..4 s), fade out at the end (5..6 s).
	expect(text).toContain(
		'<transition name="Cross Dissolve" offset="0s" duration="0.5s">'
	);
	expect(text).toContain(
		'<transition name="Cross Dissolve" offset="3s" duration="1s">'
	);
	expect(text).toContain(
		'<transition name="Cross Dissolve" offset="5s" duration="1s">'
	);
	// Butted primary clips: 0..3.5 s and 3.5..6 s.
	expect(text).toMatch(
		/<asset-clip ref="asset-1" name="Picture" offset="0s" start="0s" duration="3.5s">/
	);
	expect(text).toMatch(
		/<asset-clip ref="asset-1" name="Picture" offset="3.5s" start="5.5s" duration="2.5s"/
	);
	// The 2x clip on track 1 is connected inside the first spine clip and retimed.
	const spine = text.match(/<spine>([\s\S]*)<\/spine>/)?.[1] ?? "";
	expect(spine).toMatch(
		/<asset-clip ref="asset-1" name="Picture" offset="0s"[^>]*>[\s\S]*<asset-clip ref="asset-1" name="Picture" offset="2s" start="0s" duration="1s" lane="1">\s*<timeMap>/
	);
	expect(text).toContain('<timept time="1s" value="2s" interp="linear" />');
	// Music: -6 dB, fades, and keyframes in dB.
	expect(text).toContain('<adjust-volume amount="-6.0206dB">');
	expect(text).toContain('<fadeIn type="easeIn" duration="1s" />');
	expect(text).toContain('<keyframe time="2s" value="0dB" />');
	expect(text).toContain('lane="-2"');
});

test("FCPXML fills primary-storyline gaps and hosts later clips on a gap", () => {
	const video = asset("video", "Picture");
	const project = newProject("Gaps");
	project.segments = [
		{ ...newSegment(video, 1, 0), sourceOut: 1 },
		{ ...newSegment(video, 3, 1), sourceOut: 1 },
	];
	const text = interchangeText(project, [video], "fcpxml");
	expect(wellFormed(text)).toBe(true);
	expect(text).toContain(
		'<gap name="Gap" offset="0s" start="0s" duration="1s" />'
	);
	expect(text).toMatch(
		/<gap name="Gap" offset="2s" start="2s" duration="2s">\s*<asset-clip ref="asset-1" name="Picture" offset="3s" start="0s" duration="1s" lane="1" \/>\s*<\/gap>/
	);
});

/** A 4 s source played on a 0.5x → 3x → 1x curve over 2.4 s of timeline. */
function curvedProject() {
	const video = asset("video", "Ramp", "00000000-0000-4000-8000-0000000000c1");
	const project = {
		...newProject("Curve"),
		id: "00000000-0000-4000-8000-0000000000c2",
	};
	const points = [
		{ speed: 0.5, t: 0 },
		{ speed: 3, t: 0.5 },
		{ speed: 1, t: 1 },
	];
	const segment = {
		...newSegment(video, 0, 0),
		id: "00000000-0000-4000-8000-0000000000c3",
		sourceOut: 4,
		speed: naturalCurveSpeed(points),
		speedCurve: { points },
	};
	project.segments = [segment];
	return { project, segment, video };
}

test("FCPXML writes a speed curve as timepts at every knot and sample", () => {
	const { project, segment, video } = curvedProject();
	const text = interchangeText(project, [video], "fcpxml");
	expect(wellFormed(text)).toBe(true);
	const timeMap = text.match(/<timeMap>([\s\S]*?)<\/timeMap>/)?.[1] ?? "";
	const points = [
		...timeMap.matchAll(
			/<timept time="([\d.]+)s" value="([\d.]+)s" interp="(\w+)" \/>/g
		),
	].map((match) => ({
		interp: match[3],
		time: Number(match[1]),
		value: Number(match[2]),
	}));
	const duration = segmentDuration(segment);
	expect(points.length).toBeGreaterThan(10);
	expect(points[0]).toEqual({ interp: "smooth2", time: 0, value: 0 });
	expect(points.at(-1)?.interp).toBe("linear");
	expect(points.at(-1)?.value).toBeCloseTo(4, 6);
	// The middle knot (source 2 s) sits on its frame.
	const knot = Math.round(clipTimeAtSourceOffset(segment, 2) * 30) / 30;
	expect(points.some((point) => Math.abs(point.time - knot) < 1e-6)).toBe(true);
	// Every point follows the exact curve mapping, in order.
	for (const [index, point] of points.entries()) {
		if (point.time < duration - 1 / 30) {
			// Within a millisecond: the exported clip snaps to whole frames.
			expect(
				Math.abs(point.value - clipSourceOffset(segment, point.time))
			).toBeLessThan(0.001);
		}
		if (index > 0) {
			expect(point.time).toBeGreaterThan(points[index - 1]?.time ?? 0);
			expect(point.value).toBeGreaterThan(points[index - 1]?.value ?? 0);
		}
	}
	expect(timeMap).toMatchSnapshot();
});

test("XMEML writes a speed curve as a variable-speed Time Remap graphdict", () => {
	const { project, segment, video } = curvedProject();
	const text = interchangeText(project, [video], "xmeml");
	expect(wellFormed(text)).toBe(true);
	const remap =
		text.match(/<name>Time Remap<\/name>([\s\S]*?)<\/effect>/)?.[1] ?? "";
	expect(remap).toMatch(
		/<parameterid>variablespeed<\/parameterid>\s*<name>variablespeed<\/name>\s*<value>1<\/value>/
	);
	const graph =
		remap.match(
			/<parameterid>graphdict<\/parameterid>([\s\S]*?)<\/parameter>/
		)?.[1] ?? "";
	const keys = [
		...graph.matchAll(
			/<keyframe>\s*<when>(\d+)<\/when>\s*<value>([\d.]+)<\/value>\s*<\/keyframe>/g
		),
	].map((match) => ({ source: Number(match[2]), when: Number(match[1]) }));
	expect(keys.length).toBeGreaterThan(10);
	expect(keys[0]).toEqual({ source: 0, when: 0 });
	expect(keys.at(-1)).toEqual({
		source: 120,
		when: Math.round(segmentDuration(segment) * 30),
	});
	for (const key of keys.slice(0, -1)) {
		expect(
			Math.abs(key.source - clipSourceOffset(segment, key.when / 30) * 30)
		).toBeLessThan(0.01);
	}
	expect(remap).toMatchSnapshot();
});

/**
 * A curved clip that reveals over its predecessor with a 1 s dissolve: the
 * export butts it at the cut, trimming half a second off its head.
 */
function curvedRevealProject() {
	const video = {
		...asset("video", "Ramp", "00000000-0000-4000-8000-0000000000d1"),
		duration: 20,
	};
	const project = {
		...newProject("Curve cut"),
		id: "00000000-0000-4000-8000-0000000000d2",
	};
	const points = [
		{ speed: 0.5, t: 0 },
		{ speed: 3, t: 0.5 },
		{ speed: 1, t: 1 },
	];
	const before = {
		...newSegment(video, 0, 0),
		id: "00000000-0000-4000-8000-0000000000d3",
		sourceIn: 10,
		sourceOut: 14,
	};
	const curved = {
		...newSegment(video, 3, 0),
		id: "00000000-0000-4000-8000-0000000000d4",
		sourceIn: 0,
		sourceOut: 4,
		speed: naturalCurveSpeed(points),
		speedCurve: { points },
		transitionIn: { duration: 1, softness: 0, type: "dissolve" as const },
	};
	project.segments = [before, curved];
	// Cut at 3.5 s: the curved clip starts 0.5 s into its own curve.
	return { curved, headShift: 0.5, project, video };
}

test("FCPXML replays a curved clip from its butted head at a reveal cut", () => {
	const { curved, headShift, project, video } = curvedRevealProject();
	const text = interchangeText(project, [video], "fcpxml");
	expect(wellFormed(text)).toBe(true);
	const clip =
		text.match(
			/<asset-clip[^>]*offset="3.5s"[^>]*>[\s\S]*?<\/asset-clip>/
		)?.[0] ?? "";
	const head = clipSourceOffset(curved, headShift);
	expect(Number(clip.match(/ start="([\d.]+)s"/)?.[1])).toBeCloseTo(
		Math.round(head * 30) / 30,
		6
	);
	const points = [
		...clip.matchAll(
			/<timept time="([\d.]+)s" value="([\d.]+)s" interp="\w+" \/>/g
		),
	].map((match) => ({ time: Number(match[1]), value: Number(match[2]) }));
	expect(points.length).toBeGreaterThan(5);
	expect(points[0]?.value).toBeCloseTo(head, 3);
	expect(points.at(-1)?.value).toBeCloseTo(4, 6);
	// The source-2 s knot keeps its source moment, shifted onto the cut clip.
	const knot =
		Math.round((clipTimeAtSourceOffset(curved, 2) - headShift) * 30) / 30;
	const atKnot = points.find((point) => Math.abs(point.time - knot) < 1e-6);
	expect(atKnot?.value).toBeCloseTo(
		clipSourceOffset(curved, knot + headShift),
		3
	);
	for (const [index, point] of points.entries()) {
		if (index < points.length - 1) {
			expect(
				Math.abs(point.value - clipSourceOffset(curved, point.time + headShift))
			).toBeLessThan(0.001);
		}
		if (index > 0) {
			// No frozen tail: the source keeps advancing to the out point.
			expect(point.value).toBeGreaterThan(points[index - 1]?.value ?? 0);
		}
	}
	expect(clip.match(/<timeMap>[\s\S]*<\/timeMap>/)?.[0]).toMatchSnapshot();
});

test("XMEML replays a curved clip from its butted head at a reveal cut", () => {
	const { curved, headShift, project, video } = curvedRevealProject();
	const text = interchangeText(project, [video], "xmeml");
	expect(wellFormed(text)).toBe(true);
	const remap =
		text.match(/<name>Time Remap<\/name>([\s\S]*?)<\/effect>/)?.[1] ?? "";
	const graph =
		remap.match(
			/<parameterid>graphdict<\/parameterid>([\s\S]*?)<\/parameter>/
		)?.[1] ?? "";
	const keys = [
		...graph.matchAll(
			/<keyframe>\s*<when>(\d+)<\/when>\s*<value>([\d.]+)<\/value>\s*<\/keyframe>/g
		),
	].map((match) => ({ source: Number(match[2]), when: Number(match[1]) }));
	expect(keys.length).toBeGreaterThan(5);
	expect(keys[0]?.when).toBe(0);
	expect(keys[0]?.source).toBeCloseTo(
		clipSourceOffset(curved, headShift) * 30,
		2
	);
	expect(keys.at(-1)?.source).toBe(120);
	for (const [index, key] of keys.entries()) {
		if (index < keys.length - 1) {
			expect(
				Math.abs(
					key.source - clipSourceOffset(curved, key.when / 30 + headShift) * 30
				)
			).toBeLessThan(0.01);
		}
		if (index > 0) {
			expect(key.source).toBeGreaterThan(keys[index - 1]?.source ?? 0);
		}
	}
	expect(remap).toMatchSnapshot();
});

const rationalTime = z
	.object({
		OTIO_SCHEMA: z.literal("RationalTime.1"),
		rate: z.number().positive(),
		value: z.number().nonnegative(),
	})
	.strict();
const timeRange = z
	.object({
		OTIO_SCHEMA: z.literal("TimeRange.1"),
		duration: rationalTime,
		start_time: rationalTime,
	})
	.strict();
const metadata = z.record(z.string(), z.unknown());
const otioEffect = z.discriminatedUnion("OTIO_SCHEMA", [
	z
		.object({
			OTIO_SCHEMA: z.literal("LinearTimeWarp.1"),
			effect_name: z.string(),
			metadata,
			name: z.string(),
			time_scalar: z.number(),
		})
		.strict(),
	// OTIO's generic effect: the only way to add an effect that typed readers
	// keep without registering a schema.
	z
		.object({
			OTIO_SCHEMA: z.literal("Effect.1"),
			effect_name: z.string(),
			metadata,
			name: z.string(),
		})
		.strict(),
]);
const otioItem = z.discriminatedUnion("OTIO_SCHEMA", [
	z
		.object({
			OTIO_SCHEMA: z.literal("Clip.1"),
			effects: z.array(otioEffect),
			markers: z.array(z.unknown()),
			media_reference: z
				.object({
					OTIO_SCHEMA: z.literal("ExternalReference.1"),
					available_range: timeRange.nullable(),
					metadata,
					name: z.string(),
					target_url: z.string(),
				})
				.strict(),
			metadata,
			name: z.string(),
			source_range: timeRange,
		})
		.strict(),
	z
		.object({
			OTIO_SCHEMA: z.literal("Gap.1"),
			effects: z.array(z.unknown()),
			markers: z.array(z.unknown()),
			metadata,
			name: z.string(),
			source_range: timeRange,
		})
		.strict(),
	z
		.object({
			OTIO_SCHEMA: z.literal("Transition.1"),
			in_offset: rationalTime,
			metadata,
			name: z.string(),
			out_offset: rationalTime,
			transition_type: z.string(),
		})
		.strict(),
]);
/** The OTIO core schema subset the exporter writes (Timeline.1 and children). */
const otioTimelineSchema = z
	.object({
		OTIO_SCHEMA: z.literal("Timeline.1"),
		global_start_time: rationalTime,
		metadata,
		name: z.string(),
		tracks: z
			.object({
				OTIO_SCHEMA: z.literal("Stack.1"),
				children: z.array(
					z
						.object({
							OTIO_SCHEMA: z.literal("Track.1"),
							children: z.array(otioItem),
							effects: z.array(z.unknown()),
							kind: z.enum(["Audio", "Video"]),
							markers: z.array(z.unknown()),
							metadata,
							name: z.string(),
							source_range: z.null(),
						})
						.strict()
				),
				effects: z.array(z.unknown()),
				markers: z.array(z.unknown()),
				metadata,
				name: z.string(),
				source_range: z.null(),
			})
			.strict(),
	})
	.strict();

test("OTIO export validates against the core schema and keeps the curve as metadata", () => {
	const { project, segment, video } = curvedProject();
	const music = asset("audio", "Music", "00000000-0000-4000-8000-0000000000c4");
	project.segments = [
		segment,
		{
			...newSegment(music, 1, 1),
			id: "00000000-0000-4000-8000-0000000000c5",
			sourceOut: 2,
		},
	];
	const text = interchangeText(project, [video, music], "otio");
	const timeline = otioTimelineSchema.parse(JSON.parse(text));
	expect(interchangeFilename(project, "otio")).toBe("Curve.otio");
	const [videoTrack, audioTrack] = timeline.tracks.children;
	expect(videoTrack?.kind).toBe("Video");
	expect(audioTrack?.kind).toBe("Audio");
	const clip = videoTrack?.children[0];
	expect(clip?.OTIO_SCHEMA).toBe("Clip.1");
	if (clip?.OTIO_SCHEMA !== "Clip.1") {
		throw new Error("expected a clip");
	}
	// The average speed is the only time effect OTIO's core schema has, so it
	// is what other tools play; the curve's keyframes follow as a generic
	// effect that they keep but ignore.
	const sourceFrames = (segment.sourceOut - segment.sourceIn) * 30;
	expect(clip.effects).toEqual([
		{
			OTIO_SCHEMA: "LinearTimeWarp.1",
			effect_name: "LinearTimeWarp",
			metadata: {},
			name: "Speed curve (average)",
			time_scalar: Number(segment.speed.toFixed(6)),
		},
		{
			OTIO_SCHEMA: "Effect.1",
			effect_name: OTIO_SPEED_CURVE_EFFECT,
			metadata: {
				ryu: {
					keyframes: segment.speedCurve.points.map((point) => ({
						source_time: {
							OTIO_SCHEMA: "RationalTime.1",
							rate: 30,
							value: Number(
								(segment.sourceIn * 30 + point.t * sourceFrames).toFixed(6)
							),
						},
						speed: point.speed,
						t: point.t,
					})),
					preservePitch: true,
				},
			},
			name: "Speed curve",
		},
	]);
	expect(clip.source_range.duration.value).toBe(
		Math.round(segmentDuration(segment) * 30)
	);
	expect(clip.metadata).toEqual({
		ryu: {
			clipId: segment.id,
			speedCurve: { points: segment.speedCurve.points, preservePitch: true },
		},
	});
	// The music starts after a one-second gap.
	expect(audioTrack?.children.map((item) => item.OTIO_SCHEMA)).toEqual([
		"Gap.1",
		"Clip.1",
	]);
	expect(timeline).toMatchSnapshot();
});

test("OTIO speed-curve effects read back as the exported curves", () => {
	const { project, segment, video } = curvedProject();
	const plain = {
		...segment,
		id: "00000000-0000-4000-8000-0000000000c6",
		speedCurve: undefined,
		start: segment.start + segmentDuration(segment) + 1,
	};
	const tape = {
		...segment,
		id: "00000000-0000-4000-8000-0000000000c7",
		speedCurve: { ...segment.speedCurve, preservePitch: false },
		start: plain.start + segmentDuration(plain) + 1,
	};
	project.segments = [segment, plain, tape];
	const curves = readOtioSpeedCurves(interchangeText(project, [video], "otio"));
	expect([...curves.keys()]).toEqual([segment.id, tape.id]);
	expect(curves.get(segment.id)).toEqual({
		points: segment.speedCurve.points,
		preservePitch: true,
	});
	expect(curves.get(tape.id)).toEqual(tape.speedCurve);
});

test("OTIO speed-curve reader skips keyframes outside the curve schema", () => {
	const clip = (clipId: string, speed: number) => ({
		OTIO_SCHEMA: "Clip.1",
		effects: [
			{
				OTIO_SCHEMA: "Effect.1",
				effect_name: OTIO_SPEED_CURVE_EFFECT,
				metadata: {
					ryu: {
						keyframes: [
							{ speed, t: 0 },
							{ speed: 1, t: 1 },
						],
					},
				},
				name: "Speed curve",
			},
		],
		metadata: { ryu: { clipId } },
	});
	const curves = readOtioSpeedCurves(
		JSON.stringify({ children: [clip("kept", 2), clip("too-fast", 50)] })
	);
	expect([...curves.keys()]).toEqual(["kept"]);
	expect(() => readOtioSpeedCurves("not json")).toThrow();
});

test("OTIO speed-curve reader accepts clips re-saved by OpenTimelineIO as Clip.2", () => {
	const { project, segment, video } = curvedProject();
	// The OpenTimelineIO library writes `Clip.2` when it saves a file it loaded
	// (`sidecar/src/verify-otio.ts`); the curve must survive that re-save.
	const resaved = interchangeText(project, [video], "otio").replaceAll(
		'"OTIO_SCHEMA": "Clip.1"',
		'"OTIO_SCHEMA": "Clip.2"'
	);
	expect(resaved).toContain('"Clip.2"');
	expect(readOtioSpeedCurves(resaved).get(segment.id)).toEqual({
		points: segment.speedCurve.points,
		preservePitch: true,
	});
	const other = resaved.replaceAll('"Clip.2"', '"Clip.3"');
	expect(readOtioSpeedCurves(other).size).toBe(0);
});
