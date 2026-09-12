import { z } from "zod";
import {
	type Asset,
	markerSchema,
	type Project,
	validateProject,
} from "./project.ts";

const markerTime = z.number().finite().min(0).max(7200);
const markerDuration = z.number().finite().min(0).max(7200).optional();
const markerStatus = z.enum(["open", "review", "resolved"]);

export const manageMarkerRequestSchema = z
	.object({
		action: z.enum(["create", "update", "delete"]),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/)
			.optional(),
		comment: z.string().max(2000).optional(),
		duration: markerDuration,
		label: z.string().trim().min(1).max(120).optional(),
		markerId: z.uuid().optional(),
		revision: z.number().int().nonnegative(),
		status: markerStatus.optional(),
		time: markerTime.optional(),
	})
	.strict()
	.superRefine((input, context) => {
		if (
			input.action === "create" &&
			!(input.label && input.time !== undefined)
		) {
			context.addIssue({
				code: "custom",
				message: "Creating a marker requires label and time.",
				path: ["label"],
			});
		}
		if (input.action !== "create" && !input.markerId) {
			context.addIssue({
				code: "custom",
				message: "Updating or deleting a marker requires markerId.",
				path: ["markerId"],
			});
		}
		if (
			input.action === "update" &&
			input.label === undefined &&
			input.time === undefined &&
			input.duration === undefined &&
			input.comment === undefined &&
			input.color === undefined &&
			input.status === undefined
		) {
			context.addIssue({
				code: "custom",
				message: "Updating a marker requires at least one field.",
				path: ["action"],
			});
		}
	});
export type ManageMarkerRequest = z.infer<typeof manageMarkerRequestSchema>;

function ensureUniqueTime(
	markers: Project["markers"],
	marker: Project["markers"][number],
	ignoreId?: string
) {
	if (
		markers.some(
			(candidate) => candidate.id !== ignoreId && candidate.time === marker.time
		)
	) {
		throw new Error("A timeline marker already exists at that time.");
	}
}

/** Apply a revisioned marker create, update, or delete operation. */
export function manageMarker(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): { marker?: Project["markers"][number]; project: Project } {
	const request = manageMarkerRequestSchema.parse(input);
	if (request.action === "create") {
		const marker = markerSchema.parse({
			color: request.color,
			comment: request.comment,
			duration: request.duration,
			id: crypto.randomUUID(),
			label: request.label,
			status: request.status,
			time: request.time,
		});
		ensureUniqueTime(project.markers, marker);
		return {
			marker,
			project: validateProject(
				{ ...project, markers: [...project.markers, marker] },
				[...assets]
			),
		};
	}
	const index = project.markers.findIndex(
		(marker) => marker.id === request.markerId
	);
	if (index < 0) {
		throw new Error("Timeline marker not found.");
	}
	if (request.action === "delete") {
		return {
			project: validateProject(
				{
					...project,
					markers: project.markers.filter(
						(marker) => marker.id !== request.markerId
					),
				},
				[...assets]
			),
		};
	}
	const marker = markerSchema.parse({
		...project.markers[index],
		...(request.color === undefined ? {} : { color: request.color }),
		...(request.comment === undefined ? {} : { comment: request.comment }),
		...(request.duration === undefined ? {} : { duration: request.duration }),
		...(request.label === undefined ? {} : { label: request.label }),
		...(request.status === undefined ? {} : { status: request.status }),
		...(request.time === undefined ? {} : { time: request.time }),
	});
	ensureUniqueTime(project.markers, marker, marker.id);
	return {
		marker,
		project: validateProject(
			{
				...project,
				markers: project.markers.map((candidate) =>
					candidate.id === marker.id ? marker : candidate
				),
			},
			[...assets]
		),
	};
}
