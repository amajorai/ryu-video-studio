import { z } from "zod";
import {
	type Asset,
	type Project,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";

export const manageClipLinksRequestSchema = z
	.object({
		action: z.enum(["link", "unlink"]),
		clipIds: z.array(z.uuid()).min(1).max(8),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export type ManageClipLinksRequest = z.infer<
	typeof manageClipLinksRequestSchema
>;

function clip(project: Project, id: string) {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("Clip not found on this timeline.");
	}
	return found;
}

function ensureUnlocked(project: Project, segments: Project["segments"]) {
	for (const segment of segments) {
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error("Unlock every linked clip track before changing links.");
		}
	}
}

/** Link or unlink video and audio clips as one undoable editing group. */
export function manageClipLinks(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = manageClipLinksRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each clip once.");
	}
	const selected = request.clipIds.map((id) => clip(project, id));
	ensureUnlocked(project, selected);
	if (request.action === "unlink") {
		const groupIds = new Set(
			selected.flatMap((segment) =>
				segment.linkGroupId ? [segment.linkGroupId] : []
			)
		);
		if (!groupIds.size) {
			return project;
		}
		const members = project.segments.filter(
			(segment) => segment.linkGroupId && groupIds.has(segment.linkGroupId)
		);
		ensureUnlocked(project, members);
		return validateProject(
			{
				...project,
				segments: project.segments.map((segment) =>
					segment.linkGroupId && groupIds.has(segment.linkGroupId)
						? { ...segment, linkGroupId: undefined }
						: segment
				),
			},
			[...assets]
		);
	}
	if (selected.length < 2) {
		throw new Error("Link a video or image clip with an audio clip.");
	}
	const selectedKinds = new Set(
		selected.map(
			(segment) => assets.find((asset) => asset.id === segment.assetId)?.kind
		)
	);
	if (!selectedKinds.has("audio") || selectedKinds.size < 2) {
		throw new Error("Link groups must contain audio and visual media.");
	}
	const existingGroupIds = new Set(
		selected.flatMap((segment) =>
			segment.linkGroupId ? [segment.linkGroupId] : []
		)
	);
	const groupId = existingGroupIds.values().next().value ?? crypto.randomUUID();
	const members = project.segments.filter(
		(segment) =>
			selected.some((candidate) => candidate.id === segment.id) ||
			(segment.linkGroupId !== undefined &&
				existingGroupIds.has(segment.linkGroupId))
	);
	if (members.length > 8) {
		throw new Error("A clip link group can contain at most eight clips.");
	}
	ensureUnlocked(project, members);
	const memberIds = new Set(members.map((segment) => segment.id));
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				memberIds.has(segment.id)
					? { ...segment, linkGroupId: groupId }
					: segment
			),
		},
		[...assets]
	);
}

export function overlappingLinkCandidate(
	project: Project,
	assets: readonly Asset[],
	selectedId: string
): Project["segments"][number] | undefined {
	const selected = clip(project, selectedId);
	const selectedAsset = assets.find((asset) => asset.id === selected.assetId);
	if (!selectedAsset) {
		return undefined;
	}
	const selectedEnd = selected.start + segmentDuration(selected);
	return project.segments.find((candidate) => {
		if (candidate.id === selected.id || candidate.linkGroupId) {
			return false;
		}
		const candidateAsset = assets.find(
			(asset) => asset.id === candidate.assetId
		);
		if (!candidateAsset || candidateAsset.kind === selectedAsset.kind) {
			return false;
		}
		if (trackSettingFor(project, candidate.track).locked) {
			return false;
		}
		const candidateEnd = candidate.start + segmentDuration(candidate);
		return candidate.start < selectedEnd && selected.start < candidateEnd;
	});
}
