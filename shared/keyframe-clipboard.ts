import { z } from "zod";
import {
	type Asset,
	type Keyframe,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import {
	type KeyframeProperty,
	keyframeBezierSchema,
	keyframeInterpolationSchema,
	keyframePropertySchema,
	keyframeValueBounds,
	maskKeyframeProperties,
	targetedKeyframeProperties,
} from "./schema/keyframe.ts";
import { timeSchema } from "./schema/primitives.ts";

/** One copied keyframe, timed relative to the first copied keyframe. */
export const keyframeClipboardItemSchema = z
	.object({
		property: keyframePropertySchema,
		target: z.string().trim().min(1).max(64).optional(),
		offset: timeSchema,
		value: z.number().finite().min(-180).max(180),
		interpolation: keyframeInterpolationSchema.optional(),
		bezier: keyframeBezierSchema.optional(),
	})
	.strict();
export type KeyframeClipboardItem = z.infer<typeof keyframeClipboardItemSchema>;

/** Copied keyframes and the time they span (last offset). */
export const keyframeClipboardSchema = z
	.object({
		items: z.array(keyframeClipboardItemSchema).max(5200),
		span: timeSchema,
	})
	.strict();
export type KeyframeClipboard = z.infer<typeof keyframeClipboardSchema>;

/** Clip-relative time window, inclusive at both ends. */
const keyframeRangeSchema = z
	.object({ start: timeSchema, end: timeSchema })
	.strict()
	.refine((range) => range.start <= range.end, {
		message: "The keyframe range must end after it starts.",
	});

export interface CopyKeyframesOptions {
	/** Only these keyframe ids (the selected keyframes). */
	ids?: readonly string[];
	/** Only these properties. */
	properties?: readonly KeyframeProperty[];
	/** Only keyframes inside this clip-relative window. */
	range?: { end: number; start: number };
}

const keyframeTime = (value: number) => Number(value.toFixed(6));

/**
 * Copy a clip's keyframes, optionally narrowed by id, property and time
 * window. Offsets are relative to the earliest copied keyframe, so a paste
 * lands that keyframe on the paste time.
 */
export function copyKeyframes(
	segment: Pick<Segment, "keyframes">,
	options: CopyKeyframesOptions = {}
): KeyframeClipboard {
	const ids = options.ids ? new Set(options.ids) : undefined;
	const properties = options.properties
		? new Set(options.properties)
		: undefined;
	const { range } = options;
	const frames = segment.keyframes
		.filter(
			(frame) =>
				(!ids || ids.has(frame.id)) &&
				(!properties || properties.has(frame.property)) &&
				(!range || (frame.time >= range.start && frame.time <= range.end))
		)
		.sort((a, b) => a.time - b.time);
	const origin = frames[0]?.time ?? 0;
	const items = frames.map((frame) => {
		const item: KeyframeClipboardItem = {
			property: frame.property,
			offset: keyframeTime(frame.time - origin),
			value: frame.value,
		};
		if (frame.target !== undefined) {
			item.target = frame.target;
		}
		if (frame.interpolation !== undefined) {
			item.interpolation = frame.interpolation;
		}
		if (frame.bezier !== undefined) {
			item.bezier = frame.bezier;
		}
		return item;
	});
	return { items, span: items.at(-1)?.offset ?? 0 };
}

export interface PasteKeyframesResult {
	/** Keyframes written to the target clip. */
	pasted: number;
	segment: Segment;
	/** Items outside the clip, or driving an effect or mask it lacks. */
	skipped: number;
}

/** Effect and mask ids on a clip that targeted keyframes may drive. */
function targetPool(segment: Segment, property: KeyframeProperty): Set<string> {
	if (maskKeyframeProperties.has(property)) {
		return new Set((segment.masks ?? []).map((mask) => mask.id));
	}
	return new Set(
		segment.effects.flatMap((effect) =>
			effect.id === undefined ? [] : [effect.id]
		)
	);
}

/**
 * Paste copied keyframes onto a clip with the first one at clip-relative
 * `atTime`. A pasted keyframe replaces an existing one on the same channel
 * and time; values are clamped to the property's range. Items past the clip
 * end, or targeting an effect or mask the clip does not have, are skipped.
 */
export function pasteKeyframes(
	target: Segment,
	payload: KeyframeClipboard,
	atTime: number
): PasteKeyframesResult {
	const clipboard = keyframeClipboardSchema.parse(payload);
	const duration = segmentDuration(target);
	const pasted: Keyframe[] = [];
	let skipped = 0;
	for (const item of clipboard.items) {
		const time = keyframeTime(atTime + item.offset);
		const targeted = targetedKeyframeProperties.has(item.property);
		const targetMissing = targeted
			? item.target === undefined ||
				!targetPool(target, item.property).has(item.target)
			: item.target !== undefined;
		const duplicate = pasted.some(
			(frame) =>
				frame.property === item.property &&
				frame.target === item.target &&
				frame.time === time
		);
		if (time < 0 || time > duration || targetMissing || duplicate) {
			skipped++;
			continue;
		}
		const [min, max] = keyframeValueBounds(item.property);
		const frame: Keyframe = {
			id: crypto.randomUUID(),
			property: item.property,
			time,
			value: Math.min(max, Math.max(min, item.value)),
		};
		if (item.target !== undefined) {
			frame.target = item.target;
		}
		if (item.interpolation !== undefined) {
			frame.interpolation = item.interpolation;
		}
		if (item.bezier !== undefined) {
			frame.bezier = item.bezier;
		}
		pasted.push(frame);
	}
	const replaced = (frame: Keyframe) =>
		pasted.some(
			(next) =>
				next.property === frame.property &&
				next.target === frame.target &&
				next.time === frame.time
		);
	return {
		pasted: pasted.length,
		segment: {
			...target,
			keyframes: [
				...target.keyframes.filter((frame) => !replaced(frame)),
				...pasted,
			],
		},
		skipped,
	};
}

/**
 * Copy keyframes from one clip and paste them onto up to 200 clips. `at` is
 * the clip-relative time in each target where the earliest copied keyframe
 * lands. `properties`, `keyframeIds` and `range` narrow the copy.
 */
export const pasteKeyframesRequestSchema = z
	.object({
		sourceClipId: z.uuid(),
		targetClipIds: z.array(z.uuid()).min(1).max(200),
		properties: z
			.array(keyframePropertySchema)
			.min(1)
			.max(keyframePropertySchema.options.length)
			.optional(),
		keyframeIds: z.array(z.uuid()).min(1).max(5200).optional(),
		range: keyframeRangeSchema.optional(),
		at: timeSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type PasteKeyframesRequest = z.input<typeof pasteKeyframesRequestSchema>;

export interface PasteKeyframesBetweenClipsResult {
	pasted: number;
	project: Project;
	skipped: number;
}

/** Copy keyframes from a source clip onto target clips as one edit. */
export function pasteKeyframesBetweenClips(
	project: Project,
	assets: readonly Asset[],
	input: PasteKeyframesRequest
): PasteKeyframesBetweenClipsResult {
	const request = pasteKeyframesRequestSchema.parse(input);
	const source = project.segments.find(
		(segment) => segment.id === request.sourceClipId
	);
	if (!source) {
		throw new Error("Source clip not found on this timeline.");
	}
	const options: CopyKeyframesOptions = {};
	if (request.keyframeIds) {
		options.ids = request.keyframeIds;
	}
	if (request.properties) {
		options.properties = request.properties;
	}
	if (request.range) {
		options.range = request.range;
	}
	const payload = copyKeyframes(source, options);
	if (payload.items.length === 0) {
		throw new Error("The source clip has no matching keyframes to copy.");
	}
	const targetIds = new Set(request.targetClipIds);
	const results = new Map<string, PasteKeyframesResult>();
	for (const segment of project.segments) {
		if (!targetIds.has(segment.id)) {
			continue;
		}
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error("Unlock the target clip track before pasting keyframes.");
		}
		results.set(segment.id, pasteKeyframes(segment, payload, request.at));
	}
	if (results.size !== targetIds.size) {
		throw new Error("Target clip not found on this timeline.");
	}
	let pasted = 0;
	let skipped = 0;
	for (const result of results.values()) {
		pasted += result.pasted;
		skipped += result.skipped;
	}
	if (pasted === 0) {
		throw new Error("No copied keyframe fits the target clips at that time.");
	}
	return {
		pasted,
		project: validateProject(
			{
				...project,
				segments: project.segments.map(
					(segment) => results.get(segment.id)?.segment ?? segment
				),
			},
			[...assets]
		),
		skipped,
	};
}
