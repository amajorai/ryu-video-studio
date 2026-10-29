import { z } from "zod";
import { animationPoints } from "./animation.ts";
import {
	fpsRational,
	nominalFrameRate,
	rationalFrameTime,
	timeToFrames,
} from "./frame-rate.ts";
import {
	type Asset,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
} from "./project.ts";
import { speedCurveSchema } from "./schema/speed-curve.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	hasSpeedCurve,
	normalizedCurvePoints,
} from "./speed-curve.ts";

export const interchangeFormatSchema = z.enum(["fcpxml", "xmeml", "otio"]);
export type InterchangeFormat = z.infer<typeof interchangeFormatSchema>;

const xml = (value: string | number | undefined): string =>
	String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const decimal = (value: number) => Number(value.toFixed(6)).toString();
const frameCount = (seconds: number, fps: number) => timeToFrames(seconds, fps);

/** Frames the media covers; a partial last frame still counts as a frame. */
const assetFrames = (asset: Asset, fps: number) =>
	timeToFrames(asset.duration, fps, "ceil");

interface ClipFrames {
	/** Timeline frames: `end - start`, so adjacent clips never gap or overlap. */
	duration: number;
	/** Timeline frame the clip ends on (exclusive). */
	end: number;
	/**
	 * Clip-local frames trimmed off the head when a reveal transition butts
	 * the clip at its cut (0 otherwise). A speed curve keeps its own clock, so
	 * clip frame `t` plays curve frame `t + headShift`.
	 */
	headShift: number;
	/** First source frame. */
	in: number;
	/** Source frame (fractional) the clip's speed curve starts from. */
	origin: number;
	/** Source frame after the last one used (exclusive). */
	out: number;
	/** Timeline frame the clip starts on. */
	start: number;
}

/**
 * Snap a clip to the frame grid by its absolute boundaries and derive every
 * duration from them, so `start + duration` is the next clip's `start` and
 * `out - in` matches the clip duration (times speed). A source range that
 * would run past the media's last frame is slid back inside it.
 */
function clipFrames(segment: Segment, asset: Asset, fps: number): ClipFrames {
	const start = frameCount(segment.start, fps);
	const end = Math.max(
		start,
		frameCount(segment.start + segmentDuration(segment), fps)
	);
	const duration = end - start;
	const span = Math.round(duration * segment.speed);
	let sourceIn = frameCount(segment.sourceIn, fps);
	let sourceOut = sourceIn + span;
	if (asset.kind !== "image") {
		const limit = assetFrames(asset, fps);
		if (sourceOut > limit) {
			sourceIn = Math.max(0, limit - span);
			sourceOut = Math.min(limit, sourceIn + span);
		}
	}
	return {
		duration,
		end,
		headShift: 0,
		in: sourceIn,
		origin: sourceIn,
		out: sourceOut,
		start,
	};
}
/** Clip frames between sampled time-remap points of a speed-curved clip. */
export const CURVE_SAMPLE_FRAMES = 4;
/** Most time-remap points one curved clip writes. */
export const MAX_CURVE_REMAP_POINTS = 240;

/** One point of a clip's time remap: clip-local frames to source frames. */
export interface RemapPoint {
	/** Whether the point is a curve knot (otherwise an in-between sample). */
	knot: boolean;
	/** Source frame (fractional), on the asset's clock. */
	source: number;
	/** Clip-local timeline frame. */
	time: number;
}

/**
 * A curved clip's time remap on the export's frame grid: one point per curve
 * knot (at its nearest frame) plus samples every `CURVE_SAMPLE_FRAMES` frames between them (fewer
 * on long clips, at most `MAX_CURVE_REMAP_POINTS`), from the clip's first to
 * its last frame. Source frames follow the exact curve mapping from the
 * curve's origin, offset by any head trim (a reveal-transition cut), so knots
 * keep their source moments; the last point is the clip's exported out point.
 */
export function curveRemapPoints(
	segment: Segment,
	frames: Pick<ClipFrames, "duration" | "in" | "out"> &
		Partial<Pick<ClipFrames, "headShift" | "origin">>,
	fps: number
): RemapPoint[] {
	if (!hasSpeedCurve(segment) || frames.duration <= 0) {
		return [];
	}
	const headShift = frames.headShift ?? 0;
	const origin = frames.origin ?? frames.in;
	const sourceSeconds = segment.sourceOut - segment.sourceIn;
	// Exact curve mapping on the curve's own clock: clip frame `t` is curve
	// frame `t + headShift`. The last point lands on the exported out point
	// (the clip snaps to whole frames).
	const sourceAt = (clipFrame: number) =>
		Math.min(
			frames.out,
			origin + clipSourceOffset(segment, (clipFrame + headShift) / fps) * fps
		);
	const knots = normalizedCurvePoints(segment.speedCurve.points)
		.map(
			(point) =>
				clipTimeAtSourceOffset(segment, point.t * sourceSeconds) * fps -
				headShift
		)
		// Knots a cut trimmed away are not part of this clip's remap.
		.filter((knot) => knot >= -0.5 && knot <= frames.duration + 0.5)
		.map((knot) => Math.min(frames.duration, Math.max(0, knot)));
	const step = Math.max(
		CURVE_SAMPLE_FRAMES,
		Math.ceil(frames.duration / (MAX_CURVE_REMAP_POINTS - knots.length))
	);
	const times = new Map<number, boolean>();
	for (let frame = 0; frame < frames.duration; frame += step) {
		times.set(frame, false);
	}
	times.set(frames.duration, false);
	// Knots snap to the frame grid, like every other interchange time.
	for (const knot of knots) {
		times.set(Math.round(knot), true);
	}
	return [...times.entries()]
		.sort(([a], [b]) => a - b)
		.map(([time, knot]) => ({
			knot,
			source: time >= frames.duration ? frames.out : sourceAt(time),
			time,
		}));
}

/**
 * XMEML `<rate>`: the whole-number timebase plus the NTSC flag, so 29.97 is
 * `<timebase>30</timebase><ntsc>TRUE</ntsc>`.
 */
const xmemlRate = (fps: number) =>
	`<rate><timebase>${nominalFrameRate(fps)}</timebase><ntsc>${fpsRational(fps).ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
/**
 * FCPXML time. Integer rates keep decimal seconds; NTSC rates use
 * frame-aligned rationals (`3003/30000s`) because their frame boundaries are
 * not representable as short decimals.
 */
const fcpxmlTime = (seconds: number, fps: number) =>
	fpsRational(fps).ntsc
		? rationalFrameTime(frameCount(seconds, fps), fps)
		: `${decimal(seconds)}s`;
const fcpxmlFrameDuration = (fps: number) => {
	const { den, num } = fpsRational(fps);
	return `${den}/${num}s`;
};
const assetSource = (asset: Asset) =>
	`ryu://video-studio/assets/${encodeURIComponent(asset.id)}`;

function referencedAssets(project: Project, assets: readonly Asset[]): Asset[] {
	const available = new Map(assets.map((asset) => [asset.id, asset]));
	const seen = new Set<string>();
	const result: Asset[] = [];
	for (const segment of project.segments) {
		if (seen.has(segment.assetId)) {
			continue;
		}
		const asset = available.get(segment.assetId);
		if (asset) {
			seen.add(asset.id);
			result.push(asset);
		}
	}
	return result;
}

/** One reveal transition between a predecessor and the clip it reveals, on one track. */
interface CutTransition {
	/** Timeline frame of the edit point (the middle of the overlap). */
	cut: number;
	/** Frames of the transition, centred on `cut`. */
	frames: number;
	/** The incoming clip. */
	incoming: Segment;
	/** The predecessor the incoming clip plays over. */
	outgoing: Segment;
}

/**
 * Reveal transitions (`transitionIn`) as centred dissolves at a cut. Video
 * Studio overlaps the incoming clip with its predecessor for the whole
 * transition; interchange formats want butted clips with handles, so the
 * cut sits in the middle of the overlap and each clip keeps half the
 * overlap as its handle.
 */
function cutTransitions(project: Project): Map<string, CutTransition> {
	const result = new Map<string, CutTransition>();
	for (const segment of project.segments) {
		const reveal = segment.transitionIn;
		if (!reveal) {
			continue;
		}
		const outgoing = project.segments
			.filter(
				(other) =>
					other.id !== segment.id &&
					other.track === segment.track &&
					other.start < segment.start &&
					other.start + segmentDuration(other) >=
						segment.start + reveal.duration - 1e-6
			)
			.sort((a, b) => b.start - a.start)[0];
		if (!outgoing) {
			continue;
		}
		const frames = Math.max(1, frameCount(reveal.duration, project.fps));
		result.set(segment.id, {
			cut: frameCount(segment.start + reveal.duration / 2, project.fps),
			frames,
			incoming: segment,
			outgoing,
		});
	}
	return result;
}

/**
 * Clip frames after butting reveal-transition overlaps at their cut: the
 * outgoing clip ends at the cut and the incoming one starts there, with its
 * source in point moved by the same amount.
 */
function buttedFrames(
	segment: Segment,
	asset: Asset,
	fps: number,
	cuts: Map<string, CutTransition>
): ClipFrames {
	const frames = clipFrames(segment, asset, fps);
	const incoming = cuts.get(segment.id);
	const outgoing = [...cuts.values()].find(
		(cut) => cut.outgoing.id === segment.id
	);
	const curved = hasSpeedCurve(segment);
	// Source frames `clipFrame` frames into the untrimmed clip: the curve's
	// exact mapping for a curved clip, the constant speed otherwise.
	const sourceAfter = (clipFrame: number) =>
		curved
			? Math.round(
					frames.origin + clipSourceOffset(segment, clipFrame / fps) * fps
				)
			: null;
	let { end, headShift, in: sourceIn, out, start } = frames;
	if (incoming && incoming.cut > start) {
		const shift = incoming.cut - start;
		start = incoming.cut;
		headShift = shift;
		sourceIn =
			sourceAfter(shift) ?? sourceIn + Math.round(shift * segment.speed);
	}
	if (outgoing && outgoing.cut < end) {
		const trim = end - outgoing.cut;
		end = outgoing.cut;
		out =
			sourceAfter(outgoing.cut - frames.start) ??
			out - Math.round(trim * segment.speed);
	}
	return {
		duration: end - start,
		end,
		headShift,
		in: sourceIn,
		origin: frames.origin,
		out,
		start,
	};
}

const XMEML_DISSOLVE = `<effect>
                  <name>Cross Dissolve</name>
                  <effectid>Cross Dissolve</effectid>
                  <effectcategory>Dissolve</effectcategory>
                  <effecttype>transition</effecttype>
                  <mediatype>video</mediatype>
                </effect>`;
const XMEML_CROSS_FADE = `<effect>
                  <name>Cross Fade (+3dB)</name>
                  <effectid>KGAudioTransCrossFade3dB</effectid>
                  <effecttype>transition</effecttype>
                  <mediatype>audio</mediatype>
                </effect>`;

/**
 * A transition item: a dissolve (video) or cross fade (audio). Alignment
 * `start-black` fades in from black or silence, `end-black` fades out to it,
 * and `center` dissolves between two clips at a cut.
 */
function xmemlTransition(
	kind: "audio" | "video",
	start: number,
	end: number,
	alignment: "center" | "end-black" | "start-black",
	fps: number
): string {
	return `
              <transitionitem>
                ${xmemlRate(fps)}
                <start>${start}</start>
                <end>${end}</end>
                <alignment>${alignment}</alignment>
                ${kind === "video" ? XMEML_DISSOLVE : XMEML_CROSS_FADE}
              </transitionitem>`;
}

/**
 * Speed as a Premiere time-remap filter: constant speed in percent, or for a
 * speed-curved clip `variablespeed` 1 with a keyframed `graphdict` (clip
 * frame to source frame on the media's clock) at every curve knot and
 * in-between sample, and `speed` holding the average.
 */
function xmemlSpeedFilter(
	segment: Segment,
	mediaType: "audio" | "video",
	frames: ClipFrames,
	fps: number
): string {
	const remap = curveRemapPoints(segment, frames, fps);
	if (remap.length < 2 && Math.abs(segment.speed - 1) < 1e-6) {
		return "";
	}
	const graph =
		remap.length > 1
			? `
                    <parameter authoringApp="PremierePro">
                      <parameterid>graphdict</parameterid>
                      <name>graphdict</name>
                      <valuemin>0</valuemin>
                      <valuemax>${Math.ceil(Math.max(...remap.map((point) => point.source)))}</valuemax>
                      <value>${decimal(remap[0]?.source ?? frames.in)}</value>${remap
												.map(
													(point) => `
                      <keyframe>
                        <when>${point.time}</when>
                        <value>${decimal(point.source)}</value>
                      </keyframe>`
												)
												.join("")}
                      <interpolation>
                        <name>FCPCurve</name>
                      </interpolation>
                    </parameter>`
			: "";
	return `
                <filter>
                  <effect>
                    <name>Time Remap</name>
                    <effectid>timeremap</effectid>
                    <effectcategory>motion</effectcategory>
                    <effecttype>motion</effecttype>
                    <mediatype>${mediaType}</mediatype>
                    <parameter authoringApp="PremierePro">
                      <parameterid>variablespeed</parameterid>
                      <name>variablespeed</name>
                      <value>${remap.length > 1 ? 1 : 0}</value>
                    </parameter>
                    <parameter authoringApp="PremierePro">
                      <parameterid>speed</parameterid>
                      <name>speed</name>
                      <value>${decimal(segment.speed * 100)}</value>
                    </parameter>
                    <parameter authoringApp="PremierePro">
                      <parameterid>reverse</parameterid>
                      <name>reverse</name>
                      <value>FALSE</value>
                    </parameter>${graph}
                  </effect>
                </filter>`;
}

/**
 * Clip volume as an Audio Levels filter (linear gain, 1 = 0 dB), with the
 * clip's volume keyframes as level keyframes in clip-relative frames.
 */
function xmemlLevelFilter(segment: Segment, fps: number): string {
	const points = segment.keyframes.some((frame) => frame.property === "volume")
		? animationPoints(segment, "volume")
		: [];
	if (Math.abs(segment.volume - 1) < 1e-6 && points.length === 0) {
		return "";
	}
	const keyframes = points
		.map(
			(point) => `
                      <keyframe>
                        <when>${frameCount(point.time, fps)}</when>
                        <value>${decimal(point.value)}</value>
                      </keyframe>`
		)
		.join("");
	return `
                <filter>
                  <effect>
                    <name>Audio Levels</name>
                    <effectid>audiolevels</effectid>
                    <effectcategory>audiolevels</effectcategory>
                    <effecttype>audiolevels</effecttype>
                    <mediatype>audio</mediatype>
                    <parameter>
                      <parameterid>level</parameterid>
                      <name>Level</name>
                      <valuemin>0</valuemin>
                      <valuemax>3.98109</valuemax>
                      <value>${decimal(segment.volume)}</value>${keyframes}
                    </parameter>
                  </effect>
                </filter>`;
}

function xmemlText(project: Project, assets: readonly Asset[]): string {
	const duration = projectDuration(project);
	const fps = project.fps;
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const cuts = cutTransitions(project);
	const tracks = [
		...new Set(project.segments.map((segment) => segment.track)),
	].sort((a, b) => a - b);
	const trackText = (kind: "audio" | "video") =>
		tracks
			.map((track) => {
				const segments = project.segments
					.filter((segment) => segment.track === track)
					.sort((a, b) => a.start - b.start)
					.filter((segment) => {
						const asset = assetById.get(segment.assetId);
						return kind === "audio"
							? asset?.kind === "audio"
							: asset?.kind !== "audio";
					});
				const items = segments
					.map((segment) => {
						const asset = assetById.get(segment.assetId);
						if (!asset) {
							return "";
						}
						const frames = buttedFrames(segment, asset, fps, cuts);
						const parts: string[] = [];
						const cut = cuts.get(segment.id);
						if (cut && segments.includes(cut.outgoing)) {
							const half = Math.floor(cut.frames / 2);
							parts.push(
								xmemlTransition(
									kind,
									cut.cut - half,
									cut.cut - half + cut.frames,
									"center",
									fps
								)
							);
						}
						const fadeIn = frameCount(segment.fadeIn, fps);
						if (fadeIn > 0 && !cut) {
							parts.push(
								xmemlTransition(
									kind,
									frames.start,
									Math.min(frames.end, frames.start + fadeIn),
									"start-black",
									fps
								)
							);
						}
						parts.push(`
              <clipitem id="${xml(segment.id)}">
                <name>${xml(asset.name)}</name>
                <duration>${frames.duration}</duration>
                <start>${frames.start}</start>
                <end>${frames.end}</end>
                <in>${frames.in}</in>
                <out>${frames.out}</out>
                ${xmemlRate(fps)}
                <file id="file-${xml(asset.id)}">
                  <name>${xml(asset.name)}</name>
                  <pathurl>${xml(assetSource(asset))}</pathurl>
                </file>${xmemlSpeedFilter(segment, kind, frames, fps)}${kind === "audio" ? xmemlLevelFilter(segment, fps) : ""}
              </clipitem>`);
						const fadeOut = frameCount(segment.fadeOut, fps);
						const continued = [...cuts.values()].some(
							(next) => next.outgoing.id === segment.id
						);
						if (fadeOut > 0 && !continued) {
							parts.push(
								xmemlTransition(
									kind,
									Math.max(frames.start, frames.end - fadeOut),
									frames.end,
									"end-black",
									fps
								)
							);
						}
						return parts.join("");
					})
					.join("");
				return `
          <track id="${kind}-track-${track}">${items}
          </track>`;
			})
			.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="${xml(project.id)}">
    <name>${xml(project.title)}</name>
    <duration>${frameCount(duration, fps)}</duration>
    ${xmemlRate(fps)}
    <media>
      <video>${trackText("video")}</video>
      <audio>${trackText("audio")}</audio>
    </media>
  </sequence>
</xmeml>
`;
}

/** Final Cut's built-in Cross Dissolve. */
const FCP_DISSOLVE_UID = "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265";

/** Linear gain as FCPXML decibels (`-96dB` stands in for silence). */
const decibels = (gain: number) =>
	gain <= 0 ? "-96dB" : `${decimal(20 * Math.log10(gain))}dB`;

function fcpxmlText(project: Project, assets: readonly Asset[]): string {
	const fps = project.fps;
	const duration = projectDuration(project);
	const time = (seconds: number) => fcpxmlTime(seconds, fps);
	const { ntsc } = fpsRational(fps);
	const frameTime = (frames: number) => rationalFrameTime(frames, fps);
	/** Frame count as FCPXML time (decimal seconds at integer rates). */
	const at = (frames: number) =>
		ntsc ? frameTime(Math.round(frames)) : `${decimal(frames / fps)}s`;
	/** A fractional source frame: exact decimal seconds, or the nearest NTSC frame. */
	const sourceTime = (frames: number) =>
		ntsc ? frameTime(Math.round(frames)) : `${decimal(frames / fps)}s`;
	// NTSC asset durations round up so a clip ending on the media's partial
	// last frame stays inside the asset's declared range.
	const assetDuration = (asset: Asset) =>
		ntsc ? frameTime(assetFrames(asset, fps)) : time(asset.duration);
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const resources = assets
		.map(
			(asset, index) => `
      <asset id="asset-${index + 1}" name="${xml(asset.name)}" src="${xml(assetSource(asset))}" duration="${assetDuration(asset)}" />`
		)
		.join("");
	const resourceId = new Map(
		assets.map((asset, index) => [asset.id, `asset-${index + 1}`])
	);
	const cuts = cutTransitions(project);
	const placed = [...project.segments]
		.filter(
			(segment) =>
				assetById.has(segment.assetId) && resourceId.has(segment.assetId)
		)
		.map((segment) => {
			const asset = assetById.get(segment.assetId) as Asset;
			return {
				asset,
				frames: buttedFrames(segment, asset, fps, cuts),
				segment,
			};
		});
	type Placed = (typeof placed)[number];
	let dissolves = 0;

	/** Speed, audio level and fades, and connected-clip opacity fades. */
	const clipChildren = (item: Placed, connected: boolean) => {
		const { asset, frames, segment } = item;
		const children: string[] = [];
		const remap = curveRemapPoints(segment, frames, fps);
		if (remap.length > 1) {
			// One timept per curve knot plus samples in between; smooth2
			// splines through them follow the curve's eased speed.
			children.push(`
            <timeMap>${remap
							.map(
								(point, index) => `
              <timept time="${at(point.time)}" value="${sourceTime(point.source)}" interp="${index === remap.length - 1 ? "linear" : "smooth2"}" />`
							)
							.join("")}
            </timeMap>`);
		} else if (Math.abs(segment.speed - 1) > 1e-6) {
			children.push(`
            <timeMap>
              <timept time="0s" value="${at(frames.in)}" interp="linear" />
              <timept time="${at(frames.duration)}" value="${at(frames.out)}" interp="linear" />
            </timeMap>`);
		}
		const hasAudio = asset.kind === "audio" || asset.hasAudio;
		const levels = segment.keyframes.some(
			(frame) => frame.property === "volume"
		)
			? animationPoints(segment, "volume")
			: [];
		const fadeIn = Math.min(frameCount(segment.fadeIn, fps), frames.duration);
		const fadeOut = Math.min(frameCount(segment.fadeOut, fps), frames.duration);
		if (
			hasAudio &&
			(Math.abs(segment.volume - 1) > 1e-6 ||
				levels.length > 0 ||
				fadeIn > 0 ||
				fadeOut > 0)
		) {
			const keyframes = levels.length
				? `
                <keyframeAnimation>${levels
									.map(
										(point) => `
                  <keyframe time="${at(frames.in + frameCount(point.time * segment.speed, fps))}" value="${decibels(point.value)}" />`
									)
									.join("")}
                </keyframeAnimation>`
				: "";
			const fades = [
				fadeIn > 0 ? `<fadeIn type="easeIn" duration="${at(fadeIn)}" />` : "",
				fadeOut > 0
					? `<fadeOut type="easeOut" duration="${at(fadeOut)}" />`
					: "",
			].join("");
			children.push(`
            <adjust-volume amount="${decibels(segment.volume)}">${
							keyframes || fades
								? `
              <param name="amount">${fades}${keyframes}
              </param>`
								: ""
						}
            </adjust-volume>`);
		}
		// Primary-storyline video fades are dissolves in the spine; connected
		// clips fade their opacity instead.
		if (connected && asset.kind !== "audio" && (fadeIn > 0 || fadeOut > 0)) {
			const points = [
				...(fadeIn > 0
					? [
							[frames.in, 0],
							[frames.in + fadeIn, 1],
						]
					: []),
				...(fadeOut > 0
					? [
							[frames.out - fadeOut, 1],
							[frames.out, 0],
						]
					: []),
			];
			children.push(`
            <adjust-blend amount="1">
              <param name="amount">
                <keyframeAnimation>${points
									.map(
										([when, value]) => `
                  <keyframe time="${at(when ?? 0)}" value="${value}" />`
									)
									.join("")}
                </keyframeAnimation>
              </param>
            </adjust-blend>`);
		}
		return children;
	};

	const clipElement = (
		item: Placed,
		parent?: { localStart: number; offset: number }
	): string => {
		const { asset, frames, segment } = item;
		const ref = resourceId.get(segment.assetId) ?? "";
		const connected = parent !== undefined;
		// Connected clips are placed in their parent's local (source) time.
		const offset = parent
			? parent.localStart + (frames.start - parent.offset)
			: frames.start;
		const lane =
			asset.kind === "audio" ? -Math.max(1, segment.track) : segment.track;
		const attributes = [
			`ref="${xml(ref)}"`,
			`name="${xml(asset.name)}"`,
			`offset="${at(offset)}"`,
			`start="${at(frames.in)}"`,
			`duration="${at(frames.duration)}"`,
			...(connected ? [`lane="${lane}"`] : []),
			...(asset.kind === "audio" ? [`audioRole="Dialogue"`] : []),
		];
		const children = clipChildren(item, connected);
		return children.length
			? `
          <asset-clip ${attributes.join(" ")}>${children.join("")}
          </asset-clip>`
			: `
          <asset-clip ${attributes.join(" ")} />`;
	};

	const dissolve = (offset: number, frames: number) => {
		dissolves += 1;
		return `
          <transition name="Cross Dissolve" offset="${at(offset)}" duration="${at(frames)}">
            <filter-video ref="effect-dissolve" name="Cross Dissolve" />
            <filter-audio ref="effect-dissolve" name="Cross Fade" />
          </transition>`;
	};

	// The primary storyline: track 0, butted, with gaps between clips.
	const primary = placed
		.filter((item) => item.segment.track === 0)
		.sort((a, b) => a.frames.start - b.frames.start);
	const others = placed
		.filter((item) => item.segment.track !== 0)
		.sort(
			(a, b) =>
				a.frames.start - b.frames.start || a.segment.track - b.segment.track
		);
	interface SpineItem {
		end: number;
		item?: Placed;
		start: number;
	}
	const spineItems: SpineItem[] = [];
	let cursor = 0;
	for (const item of primary) {
		if (item.frames.start > cursor) {
			spineItems.push({ end: item.frames.start, start: cursor });
		}
		const start = Math.max(cursor, item.frames.start);
		spineItems.push({ end: item.frames.end, item, start });
		cursor = Math.max(cursor, item.frames.end);
	}
	const totalFrames = frameCount(duration, fps);
	const tailStart = cursor;
	const attachedTo = (child: Placed) =>
		spineItems.find(
			(entry) =>
				child.frames.start >= entry.start && child.frames.start < entry.end
		);
	const childrenOf = new Map<SpineItem, Placed[]>();
	const trailing: Placed[] = [];
	for (const child of others) {
		const parent = attachedTo(child);
		if (parent) {
			childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
		} else {
			trailing.push(child);
		}
	}
	if (trailing.length) {
		const end = Math.max(
			totalFrames,
			...trailing.map((child) => child.frames.end)
		);
		const gap: SpineItem = { end, start: tailStart };
		spineItems.push(gap);
		childrenOf.set(gap, trailing);
	}
	const spine = spineItems
		.map((entry) => {
			const children = childrenOf.get(entry) ?? [];
			if (!entry.item) {
				const inner = children
					.map((child) =>
						clipElement(child, { localStart: entry.start, offset: entry.start })
					)
					.join("");
				const attributes = `name="Gap" offset="${at(entry.start)}" start="${at(entry.start)}" duration="${at(entry.end - entry.start)}"`;
				return inner
					? `
          <gap ${attributes}>${inner}
          </gap>`
					: `
          <gap ${attributes} />`;
			}
			const { item } = entry;
			const parts: string[] = [];
			const cut = cuts.get(item.segment.id);
			const fadeIn = frameCount(item.segment.fadeIn, fps);
			if (cut) {
				const half = Math.floor(cut.frames / 2);
				parts.push(dissolve(cut.cut - half, cut.frames));
			} else if (fadeIn > 0 && item.asset.kind !== "audio") {
				parts.push(
					dissolve(item.frames.start, Math.min(fadeIn, item.frames.duration))
				);
			}
			let element = clipElement(item);
			if (children.length) {
				const inner = children
					.map((child) =>
						clipElement(child, {
							localStart: item.frames.in,
							offset: item.frames.start,
						})
					)
					.join("");
				element = element.endsWith(" />")
					? `${element.slice(0, -3)}>${inner}
          </asset-clip>`
					: element.replace(
							/\n {10}<\/asset-clip>$/,
							`${inner}
          </asset-clip>`
						);
			}
			parts.push(element);
			const fadeOut = frameCount(item.segment.fadeOut, fps);
			const continued = [...cuts.values()].some(
				(next) => next.outgoing.id === item.segment.id
			);
			if (fadeOut > 0 && !continued && item.asset.kind !== "audio") {
				const length = Math.min(fadeOut, item.frames.duration);
				parts.push(dissolve(item.frames.end - length, length));
			}
			return parts.join("");
		})
		.join("");
	const effectResource = dissolves
		? `
    <effect id="effect-dissolve" name="Cross Dissolve" uid="${FCP_DISSOLVE_UID}" />`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <format id="format-1" name="Ryu ${project.width}x${project.height}" frameDuration="${fcpxmlFrameDuration(fps)}" width="${project.width}" height="${project.height}" />${resources}${effectResource}
  </resources>
  <library>
    <event name="${xml(project.title)}">
      <project name="${xml(project.title)}">
        <sequence format="format-1" duration="${time(duration)}" tcStart="0s" tcFormat="NDF">
          <spine>${spine}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/** An OTIO `RationalTime.1` in frames at the project rate. */
const otioTime = (value: number, rate: number) => ({
	OTIO_SCHEMA: "RationalTime.1",
	rate,
	value,
});
const otioRange = (start: number, duration: number, rate: number) => ({
	OTIO_SCHEMA: "TimeRange.1",
	duration: otioTime(duration, rate),
	start_time: otioTime(start, rate),
});

/**
 * `effect_name` of the custom OTIO effect that carries a Video Studio speed
 * curve. It is written as OTIO's generic `Effect.1` rather than a new
 * `OTIO_SCHEMA`, so the OpenTimelineIO library loads it as a plain
 * `otio.schema.Effect` and keeps its metadata (checked with the real library by
 * `sidecar/src/verify-otio.ts`). Editors that import `.otio` were not tested.
 */
export const OTIO_SPEED_CURVE_EFFECT = "Ryu.SpeedCurve.1";

/**
 * The speed-curve effect of a curved clip: one keyframe per curve point with
 * its exact position (`t`, 0 at the clip's source in, 1 at its source out),
 * its speed, and the media frame it lands on (`source_time`, on the media
 * reference's clock).
 */
function otioSpeedCurveEffect(
	curve: NonNullable<Segment["speedCurve"]>,
	segment: Segment,
	origin: number,
	fps: number,
	rate: number
) {
	const sourceFrames = (segment.sourceOut - segment.sourceIn) * fps;
	return {
		OTIO_SCHEMA: "Effect.1",
		effect_name: OTIO_SPEED_CURVE_EFFECT,
		metadata: {
			ryu: {
				keyframes: curve.points.map((point) => ({
					source_time: otioTime(
						Number((origin + point.t * sourceFrames).toFixed(6)),
						rate
					),
					speed: point.speed,
					t: point.t,
				})),
				preservePitch: curve.preservePitch ?? true,
			},
		},
		name: "Speed curve",
	};
}

const otioSpeedCurveKeyframesSchema = z.object({
	keyframes: z.array(z.object({ speed: z.number(), t: z.number() })).min(2),
	preservePitch: z.boolean().optional(),
});
// This exporter writes `Clip.1`; the OpenTimelineIO library (0.15 and later)
// rewrites clips as `Clip.2` (multiple media references) when it saves a file,
// so the reader accepts both.
const otioCurveClipSchema = z.object({
	OTIO_SCHEMA: z.enum(["Clip.1", "Clip.2"]),
	effects: z.array(z.unknown()),
	metadata: z
		.object({ ryu: z.object({ clipId: z.string() }).optional() })
		.optional(),
});
const otioCurveEffectSchema = z.object({
	OTIO_SCHEMA: z.literal("Effect.1"),
	effect_name: z.literal(OTIO_SPEED_CURVE_EFFECT),
	metadata: z.object({ ryu: otioSpeedCurveKeyframesSchema }),
});

/**
 * The speed curves of an OTIO JSON document written by this exporter (or
 * re-saved by the OpenTimelineIO library), by Video Studio clip id
 * (`metadata.ryu.clipId`). Each curve comes from the clip's
 * {@link OTIO_SPEED_CURVE_EFFECT} effect and is validated against the stored
 * speed-curve schema; a clip without the effect, without a clip id, or with
 * keyframes outside that schema is left out. The exporter always writes
 * `preservePitch`, so a curve stored without it reads back with the explicit
 * default `true`. Throws on text that is not JSON. No Video Studio import path
 * calls this yet: `.otio` speed curves are export-only in the product.
 */
export function readOtioSpeedCurves(
	text: string
): Map<string, NonNullable<Segment["speedCurve"]>> {
	const curves = new Map<string, NonNullable<Segment["speedCurve"]>>();
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) {
				visit(child);
			}
			return;
		}
		if (typeof node !== "object" || node === null) {
			return;
		}
		const clip = otioCurveClipSchema.safeParse(node);
		const clipId = clip.success ? clip.data.metadata?.ryu?.clipId : undefined;
		if (clip.success && clipId) {
			for (const effect of clip.data.effects) {
				const parsed = otioCurveEffectSchema.safeParse(effect);
				if (!parsed.success) {
					continue;
				}
				const { keyframes, preservePitch } = parsed.data.metadata.ryu;
				const curve = speedCurveSchema.safeParse({
					points: keyframes.map(({ speed, t }) => ({ speed, t })),
					...(preservePitch === undefined ? {} : { preservePitch }),
				});
				if (curve.success) {
					curves.set(clipId, curve.data);
				}
			}
			return;
		}
		for (const value of Object.values(node)) {
			visit(value);
		}
	};
	visit(JSON.parse(text));
	return curves;
}

/**
 * The OpenTimelineIO JSON of the timeline: one `Track.1` per Video Studio
 * track and kind, clips as `Clip.1` with `ExternalReference.1` media and
 * gaps between them, reveal transitions as centred `SMPTE_Dissolve`s.
 * Times are frames at the project rate. A clip's `source_range` starts at
 * its media in point and lasts its timeline length; speed is a
 * `LinearTimeWarp.1` with the clip's average speed. OTIO's core schema has
 * no variable-speed effect (only `LinearTimeWarp` and `FreezeFrame`), so a
 * speed curve is written three ways: that average (the only part other
 * tools play), a generic `Effect.1` named {@link OTIO_SPEED_CURVE_EFFECT}
 * whose metadata holds the keyframes, and `metadata.ryu.speedCurve` on the
 * clip. The OpenTimelineIO library keeps the effect and metadata
 * (`sidecar/src/verify-otio.ts`); OTIO tools do not apply the custom effect.
 * {@link readOtioSpeedCurves} reads the curve back.
 */
function otioText(project: Project, assets: readonly Asset[]): string {
	const fps = project.fps;
	const { den, num } = fpsRational(fps);
	const rate = num / den;
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const cuts = cutTransitions(project);
	const tracks = [
		...new Set(project.segments.map((segment) => segment.track)),
	].sort((a, b) => a - b);
	const trackOf = (track: number, kind: "Audio" | "Video") => {
		const placed = project.segments
			.filter((segment) => segment.track === track)
			.flatMap((segment) => {
				const asset = assetById.get(segment.assetId);
				if (!asset || (asset.kind === "audio") !== (kind === "Audio")) {
					return [];
				}
				return [
					{ asset, frames: buttedFrames(segment, asset, fps, cuts), segment },
				];
			})
			.sort((a, b) => a.frames.start - b.frames.start);
		const children: unknown[] = [];
		let cursor = 0;
		for (const { asset, frames, segment } of placed) {
			const cut = cuts.get(segment.id);
			if (cut && placed.some((item) => item.segment.id === cut.outgoing.id)) {
				const half = Math.floor(cut.frames / 2);
				children.push({
					OTIO_SCHEMA: "Transition.1",
					in_offset: otioTime(half, rate),
					metadata: {},
					name: "Cross Dissolve",
					out_offset: otioTime(cut.frames - half, rate),
					transition_type: "SMPTE_Dissolve",
				});
			}
			const start = Math.max(cursor, frames.start);
			if (start > cursor) {
				children.push({
					OTIO_SCHEMA: "Gap.1",
					effects: [],
					markers: [],
					metadata: {},
					name: "",
					source_range: otioRange(0, start - cursor, rate),
				});
			}
			const duration = Math.max(0, frames.end - start);
			if (duration === 0) {
				continue;
			}
			const curve = segment.speedCurve;
			children.push({
				OTIO_SCHEMA: "Clip.1",
				effects:
					Math.abs(segment.speed - 1) > 1e-6 || curve
						? [
								{
									OTIO_SCHEMA: "LinearTimeWarp.1",
									effect_name: "LinearTimeWarp",
									metadata: {},
									name: curve ? "Speed curve (average)" : "Speed",
									time_scalar: Number(segment.speed.toFixed(6)),
								},
								...(curve
									? [
											otioSpeedCurveEffect(
												curve,
												segment,
												frames.origin,
												fps,
												rate
											),
										]
									: []),
							]
						: [],
				markers: [],
				media_reference: {
					OTIO_SCHEMA: "ExternalReference.1",
					available_range:
						asset.kind === "image"
							? null
							: otioRange(0, assetFrames(asset, fps), rate),
					metadata: {},
					name: asset.name,
					target_url: assetSource(asset),
				},
				metadata: {
					ryu: {
						clipId: segment.id,
						...(curve
							? {
									speedCurve: {
										points: curve.points.map((point) => ({
											speed: point.speed,
											t: point.t,
										})),
										preservePitch: curve.preservePitch ?? true,
									},
								}
							: {}),
					},
				},
				name: asset.name,
				source_range: otioRange(
					frames.in + Math.round((start - frames.start) * segment.speed),
					duration,
					rate
				),
			});
			cursor = start + duration;
		}
		return {
			OTIO_SCHEMA: "Track.1",
			children,
			effects: [],
			kind,
			markers: [],
			metadata: { ryu: { track } },
			name: `${kind === "Audio" ? "A" : "V"}${track + 1}`,
			source_range: null,
		};
	};
	const children = (["Video", "Audio"] as const).flatMap((kind) =>
		tracks
			.map((track) => trackOf(track, kind))
			.filter((track) => track.children.length > 0)
	);
	const timeline = {
		OTIO_SCHEMA: "Timeline.1",
		global_start_time: otioTime(0, rate),
		metadata: {
			ryu: {
				fps,
				height: project.height,
				projectId: project.id,
				width: project.width,
			},
		},
		name: project.title,
		tracks: {
			OTIO_SCHEMA: "Stack.1",
			children,
			effects: [],
			markers: [],
			metadata: {},
			name: "tracks",
			source_range: null,
		},
	};
	return `${JSON.stringify(timeline, null, 2)}\n`;
}

/**
 * Serialize the saved timeline for import into Final Cut/Resolve (FCPXML),
 * Premiere (XMEML) or OpenTimelineIO tools (OTIO JSON).
 */
export function interchangeText(
	project: Project,
	assets: readonly Asset[],
	format: InterchangeFormat
): string {
	const referenced = referencedAssets(project, assets);
	switch (format) {
		case "fcpxml":
			return fcpxmlText(project, referenced);
		case "otio":
			return otioText(project, referenced);
		default:
			return xmemlText(project, referenced);
	}
}

const INTERCHANGE_EXTENSIONS: Record<InterchangeFormat, string> = {
	fcpxml: "fcpxml",
	otio: "otio",
	xmeml: "xml",
};

export function interchangeFilename(
	project: Pick<Project, "title">,
	format: InterchangeFormat
): string {
	const safeTitle = project.title
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${safeTitle || "video-studio-project"}.${INTERCHANGE_EXTENSIONS[format]}`;
}
