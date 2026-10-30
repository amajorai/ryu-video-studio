import { z } from "zod";
import { fpsRational } from "./frame-rate.ts";
import {
	assetFrames,
	assetSource,
	buttedFrames,
	cutTransitions,
} from "./interchange-shared.ts";
import type { Asset, Project, Segment } from "./project.ts";
import { speedCurveSchema } from "./schema/speed-curve.ts";

/** An OTIO `RationalTime.1` in frames at the project rate. */
export const otioTime = (value: number, rate: number) => ({
	OTIO_SCHEMA: "RationalTime.1",
	rate,
	value,
});
export const otioRange = (start: number, duration: number, rate: number) => ({
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
export function otioSpeedCurveEffect(
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

export const otioSpeedCurveKeyframesSchema = z.object({
	keyframes: z.array(z.object({ speed: z.number(), t: z.number() })).min(2),
	preservePitch: z.boolean().optional(),
});
// This exporter writes `Clip.1`; the OpenTimelineIO library (0.15 and later)
// rewrites clips as `Clip.2` (multiple media references) when it saves a file,
// so the reader accepts both.
export const otioCurveClipSchema = z.object({
	OTIO_SCHEMA: z.enum(["Clip.1", "Clip.2"]),
	effects: z.array(z.unknown()),
	metadata: z
		.object({ ryu: z.object({ clipId: z.string() }).optional() })
		.optional(),
});
export const otioCurveEffectSchema = z.object({
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
export function otioText(project: Project, assets: readonly Asset[]): string {
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
