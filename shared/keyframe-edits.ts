import { z } from "zod";
import {
	type Asset,
	type Project,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import {
	isColorKeyframeProperty,
	type Keyframe,
	type KeyframeOwnerKind,
	keyframeBezierSchema,
	keyframeInterpolationSchema,
	keyframePropertyAllowed,
	keyframePropertySchema,
	keyframeValueBounds,
	targetedKeyframeProperties,
} from "./schema/keyframe.ts";
import { hexColorSchema, idSchema } from "./schema/primitives.ts";

const timelineTime = z.number().finite().min(0).max(7200);

const keyframeValueSchema = z
	.object({
		time: timelineTime,
		/** Required for numeric channels; color channels take 0 or omit it. */
		value: z.number().finite().min(-180).max(180).optional(),
		/** `#rrggbb`, required for (and only allowed on) color channels. */
		color: hexColorSchema.optional(),
		interpolation: keyframeInterpolationSchema.optional(),
		bezier: keyframeBezierSchema.optional(),
	})
	.strict();

/**
 * Replace one animated channel (a property, plus the effect or mask id that
 * `effectAmount`/`mask*` keyframes drive) on a clip, title or graphic: name
 * exactly one of `clipId`, `titleId` or `graphicId`. Each keyframe's
 * `interpolation` shapes the interval to the next keyframe (absent = linear);
 * `bezier` holds CSS-style controls and is required for, and only allowed
 * with, `interpolation: "bezier"`. Values must sit in the property's range.
 * Titles also animate `fontSize`, `letterSpacing`, `lineHeight`,
 * `backgroundPadding`, `backgroundRadius` and the colors `color` and
 * `backgroundColor`; graphics `scale`, `strokeWidth`, `cornerRadius`,
 * `innerRadius` and the colors `fill` and `stroke`. Color keyframes carry a
 * `#rrggbb` `color` instead of a value.
 */
export const setKeyframesRequestSchema = z
	.object({
		clipId: z.uuid().optional(),
		titleId: idSchema.optional(),
		graphicId: idSchema.optional(),
		keyframes: z.array(keyframeValueSchema).max(200),
		property: keyframePropertySchema,
		target: z.string().trim().min(1).max(64).optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict()
	.superRefine((request, context) => {
		const owners = [request.clipId, request.titleId, request.graphicId].filter(
			(id) => id !== undefined
		);
		if (owners.length !== 1) {
			context.addIssue({
				code: "custom",
				message: "Name exactly one of clipId, titleId or graphicId.",
				path: ["clipId"],
			});
		}
		const owner = requestOwner(request);
		if (!keyframePropertyAllowed(owner, request.property)) {
			context.addIssue({
				code: "custom",
				message: `A ${owner} cannot carry ${request.property} keyframes.`,
				path: ["property"],
			});
		}
		const colored = isColorKeyframeProperty(request.property);
		const [min, max] = keyframeValueBounds(request.property);
		for (const [index, keyframe] of request.keyframes.entries()) {
			if (colored !== (keyframe.color !== undefined)) {
				context.addIssue({
					code: "custom",
					message: colored
						? `${request.property} keyframes need a #rrggbb color.`
						: "Only color channels take a color.",
					path: ["keyframes", index, "color"],
				});
			}
			const value = keyframe.value ?? (colored ? 0 : undefined);
			if (value === undefined) {
				context.addIssue({
					code: "custom",
					message: `${request.property} keyframes need a value.`,
					path: ["keyframes", index, "value"],
				});
			} else if (value < min || value > max) {
				context.addIssue({
					code: "custom",
					message: `${request.property} keyframes must be between ${min} and ${max}.`,
					path: ["keyframes", index, "value"],
				});
			}
			if (
				(keyframe.bezier !== undefined) !==
				(keyframe.interpolation === "bezier")
			) {
				context.addIssue({
					code: "custom",
					message:
						"Bezier keyframes need bezier controls, and only they may carry them.",
					path: ["keyframes", index, "bezier"],
				});
			}
		}
		if (
			targetedKeyframeProperties.has(request.property) !==
			(request.target !== undefined)
		) {
			context.addIssue({
				code: "custom",
				message:
					"Effect amount and mask keyframes need a target id; other properties take none.",
				path: ["target"],
			});
		}
	});
export type SetKeyframesRequest = z.infer<typeof setKeyframesRequestSchema>;

function requestOwner(
	request: Pick<SetKeyframesRequest, "graphicId" | "titleId">
): KeyframeOwnerKind {
	if (request.titleId !== undefined) {
		return "title";
	}
	return request.graphicId === undefined ? "clip" : "graphic";
}

function editable(project: Project, clipId: string) {
	const current = project.segments.find((segment) => segment.id === clipId);
	if (!current) {
		throw new Error("Clip not found on this timeline.");
	}
	if (trackSettingFor(project, current.track).locked) {
		throw new Error("Unlock the clip track before editing the timeline.");
	}
	return current;
}

export type SetKeyframesInput = z.input<typeof setKeyframesRequestSchema>;

/** Replace one keyframe channel on a clip, title or graphic. */
export function setKeyframes(
	project: Project,
	assets: readonly Asset[],
	input: SetKeyframesInput
): Project {
	const request = setKeyframesRequestSchema.parse(input);
	const times = new Set<number>();
	const keyframes: Keyframe[] = request.keyframes
		.map(({ color, value, ...keyframe }) => ({
			...keyframe,
			id: crypto.randomUUID(),
			property: request.property,
			value: value ?? 0,
			...(color === undefined ? {} : { color }),
			...(request.target === undefined ? {} : { target: request.target }),
		}))
		.sort((a, b) => a.time - b.time);
	for (const keyframe of keyframes) {
		if (times.has(keyframe.time)) {
			throw new Error("Choose each keyframe time once.");
		}
		times.add(keyframe.time);
	}
	const replace = (existing: readonly Keyframe[] | undefined) => [
		...(existing ?? []).filter(
			(frame) =>
				frame.property !== request.property || frame.target !== request.target
		),
		...keyframes,
	];
	/** Overlay keyframes disappear with their last channel. */
	const overlayKeyframes = (existing: readonly Keyframe[] | undefined) => {
		const next = replace(existing);
		return next.length > 0 ? { keyframes: next } : { keyframes: undefined };
	};
	const withoutEmpty = <Item extends { keyframes?: Keyframe[] }>(
		item: Item
	): Item => {
		if (item.keyframes !== undefined) {
			return item;
		}
		const { keyframes: _keyframes, ...rest } = item;
		return rest as Item;
	};
	if (request.titleId !== undefined) {
		const id = request.titleId;
		if (!project.titles.some((title) => title.id === id)) {
			throw new Error("Title not found on this timeline.");
		}
		return validateProject(
			{
				...project,
				titles: project.titles.map((title) =>
					title.id === id
						? withoutEmpty({ ...title, ...overlayKeyframes(title.keyframes) })
						: title
				),
			},
			[...assets]
		);
	}
	if (request.graphicId !== undefined) {
		const id = request.graphicId;
		if (!project.graphics.some((graphic) => graphic.id === id)) {
			throw new Error("Graphic not found on this timeline.");
		}
		return validateProject(
			{
				...project,
				graphics: project.graphics.map((graphic) =>
					graphic.id === id
						? withoutEmpty({
								...graphic,
								...overlayKeyframes(graphic.keyframes),
							})
						: graphic
				),
			},
			[...assets]
		);
	}
	const current = editable(project, request.clipId as string);
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				segment.id === current.id
					? { ...segment, keyframes: replace(segment.keyframes) }
					: segment
			),
		},
		[...assets]
	);
}
