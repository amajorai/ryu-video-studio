import { roundAdjustmentTime } from "./adjustment.ts";
import { type Project, type Segment, segmentDuration } from "./project.ts";
import type { AdjustmentLayer, TrackedSource } from "./schema/adjustment.ts";

/**
 * Tracked region layers follow their clip's content (W4b).
 *
 * A tracked blur or mosaic is a free adjustment layer whose span and mask
 * keyframes sit on the timeline, but what it hides is a subject at certain
 * source moments of one clip. A ripple head trim, slip or speed ramp of that
 * clip moves those moments; the layer records them (`follows`) so the edit
 * can move it along instead of leaving the mask behind its subject.
 */

const EPSILON = 1e-6;

/** The source seconds a clip shows at a timeline time. */
export function sourceTimeAt(segment: Segment, time: number): number {
	const source = segment.sourceIn + (time - segment.start) * segment.speed;
	return Math.min(segment.sourceOut, Math.max(segment.sourceIn, source));
}

/** What a new tracked region layer over `segment` follows. */
export function trackedSourceOf(
	segment: Segment,
	span: { end: number; start: number }
): TrackedSource {
	return {
		assetId: segment.assetId,
		clipId: segment.id,
		sourceEnd: roundAdjustmentTime(sourceTimeAt(segment, span.end)),
		sourceStart: roundAdjustmentTime(sourceTimeAt(segment, span.start)),
	};
}

/**
 * Where `source` seconds of the followed asset play: in the followed clip
 * when it still shows them, else in another clip of the asset that does (a
 * speed ramp splits a clip into steps with new ids), the one nearest `near`.
 */
function timelineAt(
	project: Project,
	follows: TrackedSource,
	source: number,
	near: number
): { segment: Segment; time: number } | undefined {
	let best: { distance: number; segment: Segment; time: number } | undefined;
	for (const segment of project.segments) {
		if (
			segment.assetId !== follows.assetId ||
			source < segment.sourceIn - EPSILON ||
			source > segment.sourceOut + EPSILON
		) {
			continue;
		}
		const time = segment.start + (source - segment.sourceIn) / segment.speed;
		if (segment.id === follows.clipId) {
			return { segment, time };
		}
		const distance = Math.abs(time - near);
		if (!best || distance < best.distance) {
			best = { distance, segment, time };
		}
	}
	return best && { segment: best.segment, time: best.time };
}

/** The layer moved (and stretched) to where its followed moments play. */
function followLayer(
	project: Project,
	layer: AdjustmentLayer,
	follows: TrackedSource
): AdjustmentLayer {
	const first = timelineAt(project, follows, follows.sourceStart, layer.start);
	const last = timelineAt(project, follows, follows.sourceEnd, layer.end);
	if (!(first || last)) {
		// The edit trimmed every followed moment away: leave the layer be.
		return layer;
	}
	const length = layer.end - layer.start;
	const sourceLength = follows.sourceEnd - follows.sourceStart;
	// A followed moment the edit trimmed away maps past its clip's edge; the
	// layer is then cut at that edge.
	const mappedStart = first
		? first.time
		: (last?.time ?? 0) - sourceLength / (last?.segment.speed ?? 1);
	const mappedEnd = last
		? last.time
		: mappedStart + sourceLength / (first?.segment.speed ?? 1);
	const lower = first || !last ? 0 : last.segment.start;
	const upper =
		last || !first
			? mappedEnd
			: first.segment.start + segmentDuration(first.segment);
	const start = roundAdjustmentTime(Math.max(0, lower, mappedStart));
	const end = roundAdjustmentTime(Math.min(upper, mappedEnd));
	if (!(end - start > EPSILON && mappedEnd - mappedStart > EPSILON)) {
		return layer;
	}
	if (
		Math.abs(start - layer.start) < EPSILON &&
		Math.abs(end - layer.end) < EPSILON
	) {
		const clipId = (first ?? last)?.segment.id ?? follows.clipId;
		return clipId === follows.clipId
			? layer
			: { ...layer, follows: { ...follows, clipId } };
	}
	// Keyframes are layer-relative: stretch them with the span (a speed
	// change) and drop those that fall outside a span cut at an edge.
	const scale = (mappedEnd - mappedStart) / length;
	const cut = start - mappedStart;
	const span = end - start;
	const seen = new Set<string>();
	const keyframes = layer.keyframes?.flatMap((frame) => {
		const time = frame.time * scale - cut;
		if (time < -EPSILON || time > span + EPSILON) {
			return [];
		}
		// `span` is the length validation measures (`end - start`), so the
		// rounded time is clamped to it last.
		const clamped = Math.min(span, roundAdjustmentTime(Math.max(0, time)));
		const key = `${frame.property}:${frame.target ?? ""}:${clamped}`;
		if (seen.has(key)) {
			return [];
		}
		seen.add(key);
		return [{ ...frame, time: clamped }];
	});
	return {
		...layer,
		end,
		follows: {
			...follows,
			clipId: (first ?? last)?.segment.id ?? follows.clipId,
		},
		...(keyframes ? { keyframes } : {}),
		start,
	};
}

/**
 * After an edit of clips (`before` to `after`), move every tracked region
 * layer to where its followed source moments now play. Layers are taken
 * from `before`, so a ripple shift the edit already applied is not added
 * twice, and a layer whose content did not move stays where it was.
 */
export function followTrackedLayers(before: Project, after: Project): Project {
	const layers = after.adjustmentLayers;
	if (!layers?.some((layer) => layer.follows)) {
		return after;
	}
	const earlier = new Map(
		(before.adjustmentLayers ?? []).map((layer) => [layer.id, layer])
	);
	let changed = false;
	const next = layers.map((layer) => {
		const base = earlier.get(layer.id) ?? layer;
		if (!base.follows) {
			return layer;
		}
		const followed = followLayer(after, base, base.follows);
		if (followed !== layer) {
			changed = true;
		}
		return followed;
	});
	return changed ? { ...after, adjustmentLayers: next } : after;
}
