import { z } from "zod";
import {
	type Asset,
	type MulticamGroup,
	type MulticamMember,
	type MulticamSwitch,
	multicamGroupSchema,
	newSegment,
	type Project,
	projectDuration,
	validateProject,
} from "./project.ts";

const time = z.number().finite().min(0).max(7200);
const memberKind = z.enum(["angle", "mic", "both"]);
const memberRequestSchema = z
	.object({
		assetId: z.uuid(),
		kind: memberKind,
		label: z.string().trim().min(1).max(80).optional(),
		offsetSeconds: z.number().finite().min(-600).max(600).default(0),
	})
	.strict();

export const multicamCreateRequestSchema = z
	.object({
		action: z.literal("create"),
		duration: time.optional(),
		masterAssetId: z.uuid().optional(),
		members: z.array(memberRequestSchema).min(2).max(8),
		name: z.string().trim().min(1).max(120).optional(),
		revision: z.number().int().nonnegative(),
		start: time.optional(),
	})
	.strict();

export const multicamChangeRequestSchema = z
	.object({
		action: z.literal("change"),
		entries: z
			.array(
				z
					.object({
						angle: z.string().trim().min(1).max(80),
						end: time,
						start: time,
					})
					.strict()
			)
			.min(1)
			.max(100),
		groupId: z.uuid(),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export const multicamUngroupRequestSchema = z
	.object({
		action: z.literal("ungroup"),
		groupId: z.uuid(),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export const multicamRequestSchema = z.discriminatedUnion("action", [
	multicamCreateRequestSchema,
	multicamChangeRequestSchema,
	multicamUngroupRequestSchema,
]);
export type MulticamRequest = z.infer<typeof multicamRequestSchema>;

function round(value: number): number {
	return Number(value.toFixed(6));
}

function memberAssets(
	members: readonly MulticamMember[],
	assets: readonly Asset[]
): Map<string, Asset> {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const result = new Map<string, Asset>();
	for (const member of members) {
		const asset = byId.get(member.assetId);
		if (!asset) {
			throw new Error("A multicam member references missing media.");
		}
		if (member.kind !== "mic" && asset.kind !== "video") {
			throw new Error("Camera angles must reference video media.");
		}
		if (member.kind !== "angle" && !asset.hasAudio) {
			throw new Error("Microphone and both members must contain audio.");
		}
		result.set(member.label, asset);
	}
	return result;
}

function angleMembers(group: MulticamGroup): MulticamMember[] {
	return group.members.filter((member) =>
		["angle", "both"].includes(member.kind)
	);
}

function buildSegments(
	group: MulticamGroup,
	assets: readonly Asset[]
): { segmentIds: string[]; segments: Project["segments"] } {
	const byLabel = memberAssets(group.members, assets);
	const members = new Map(
		group.members.map((member) => [member.label, member])
	);
	const segments: Project["segments"] = [];
	for (const switchPoint of group.switches) {
		const member = members.get(switchPoint.angle);
		const asset = member ? byLabel.get(member.label) : undefined;
		if (!(member && asset)) {
			throw new Error("A multicam switch references an unavailable angle.");
		}
		const sourceIn = Math.max(
			0,
			switchPoint.start - group.start + member.offsetSeconds
		);
		const length = switchPoint.end - switchPoint.start;
		if (sourceIn + length > asset.duration + 0.05) {
			throw new Error("A multicam angle does not cover its switch range.");
		}
		segments.push({
			...newSegment(asset, switchPoint.start, 0),
			fadeIn: 0,
			fadeOut: 0,
			multicamGroupId: group.id,
			sourceIn,
			sourceOut: Math.min(asset.duration, sourceIn + length),
			volume: 0,
		});
	}
	const master = group.members.find(
		(member) => member.assetId === group.masterAssetId
	);
	const masterAsset = master ? byLabel.get(master.label) : undefined;
	if (!(master && masterAsset)) {
		throw new Error("A multicam master is unavailable.");
	}
	const masterOffset = Math.max(0, master.offsetSeconds);
	if (masterOffset + group.duration > masterAsset.duration + 0.05) {
		throw new Error("The multicam master does not cover the program duration.");
	}
	segments.push({
		...newSegment(masterAsset, group.start, 1),
		fadeIn: 0,
		fadeOut: 0,
		multicamGroupId: group.id,
		opacity: 0,
		sourceIn: masterOffset,
		sourceOut: Math.min(masterAsset.duration, masterOffset + group.duration),
		volume: 1,
	});
	return { segmentIds: segments.map((segment) => segment.id), segments };
}

function normalizedMembers(
	input: z.infer<typeof memberRequestSchema>[],
	assets: readonly Asset[]
): MulticamMember[] {
	const labels = new Set<string>();
	const assetIds = new Set<string>();
	const members = input.map((member) => {
		const asset = assets.find((candidate) => candidate.id === member.assetId);
		const label = member.label ?? asset?.name ?? "Camera";
		if (labels.has(label) || assetIds.has(member.assetId)) {
			throw new Error("Multicam member labels and media must be unique.");
		}
		labels.add(label);
		assetIds.add(member.assetId);
		return {
			assetId: member.assetId,
			kind: member.kind,
			label,
			offsetSeconds: member.offsetSeconds,
		};
	});
	const angles = members.filter((member) =>
		["angle", "both"].includes(member.kind)
	);
	const program = members.filter((member) =>
		["mic", "both"].includes(member.kind)
	);
	if (angles.length < 2) {
		throw new Error("Multicam needs at least two camera angles.");
	}
	if (!program.length) {
		throw new Error("Add a mic or both member for program audio.");
	}
	memberAssets(members, assets);
	return members;
}

function currentAngle(group: MulticamGroup, at: number): string {
	return (
		group.switches.find(
			(switchPoint) => switchPoint.start <= at && at < switchPoint.end
		)?.angle ?? group.switches[0]!.angle
	);
}

function mergedSwitches(
	group: MulticamGroup,
	entries: readonly { angle: string; end: number; start: number }[]
): MulticamSwitch[] {
	const labels = new Set(angleMembers(group).map((member) => member.label));
	for (const entry of entries) {
		if (
			entry.end <= entry.start ||
			entry.start < group.start ||
			entry.end > group.start + group.duration ||
			!labels.has(entry.angle)
		) {
			throw new Error("A multicam switch must stay inside the group range.");
		}
	}
	const boundaries = new Set<number>([
		group.start,
		group.start + group.duration,
		...group.switches.flatMap((switchPoint) => [
			switchPoint.start,
			switchPoint.end,
		]),
		...entries.flatMap((entry) => [entry.start, entry.end]),
	]);
	const ordered = [...boundaries].sort((a, b) => a - b);
	const result: MulticamSwitch[] = [];
	for (let index = 0; index < ordered.length - 1; index += 1) {
		const start = ordered[index]!;
		const end = ordered[index + 1]!;
		if (end - start < 0.04) {
			continue;
		}
		const override = [...entries]
			.reverse()
			.find((entry) => entry.start <= start && entry.end >= end);
		const angle = override?.angle ?? currentAngle(group, start);
		const previous = result.at(-1);
		if (previous?.angle === angle && previous.end === start) {
			previous.end = end;
		} else {
			result.push({ angle, end, start });
		}
	}
	return result;
}

export function createMulticamGroup(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): { group: MulticamGroup; project: Project } {
	const request = multicamCreateRequestSchema.parse(input);
	const members = normalizedMembers(request.members, assets);
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const angleAssets = members
		.filter((member) => ["angle", "both"].includes(member.kind))
		.map((member) => byId.get(member.assetId)!);
	const program = members.find((member) =>
		["mic", "both"].includes(member.kind)
	);
	const masterAssetId = request.masterAssetId ?? program!.assetId;
	const master = members.find((member) => member.assetId === masterAssetId);
	if (!(master && ["mic", "both"].includes(master.kind))) {
		throw new Error("The multicam master must be a mic or both member.");
	}
	const masterAsset = byId.get(master.assetId)!;
	const start = request.start ?? projectDuration(project);
	const availableDurations = [
		...members
			.filter((member) => ["angle", "both"].includes(member.kind))
			.map(
				(member) =>
					byId.get(member.assetId)!.duration - Math.max(0, member.offsetSeconds)
			),
		masterAsset.duration - Math.max(0, master.offsetSeconds),
	];
	const duration = request.duration ?? Math.min(...availableDurations);
	if (start + duration > 7200 || duration < 0.04) {
		throw new Error(
			"The multicam group must fit inside the two-hour timeline."
		);
	}
	const group: MulticamGroup = multicamGroupSchema.parse({
		duration,
		id: crypto.randomUUID(),
		masterAssetId,
		members,
		name: request.name ?? `Multicam ${project.multicamGroups.length + 1}`,
		segmentIds: [crypto.randomUUID()],
		start,
		switches: [
			{
				angle: angleAssets[0]
					? members.find((member) => member.assetId === angleAssets[0]!.id)!
							.label
					: "",
				end: start + duration,
				start,
			},
		],
	});
	const built = buildSegments(group, assets);
	const nextGroup = { ...group, segmentIds: built.segmentIds };
	const nextProject = validateProject(
		{
			...project,
			multicamGroups: [...project.multicamGroups, nextGroup],
			segments: [...project.segments, ...built.segments],
		},
		[...assets]
	);
	return {
		group: nextProject.multicamGroups.at(-1)!,
		project: nextProject,
	};
}

export function changeMulticamAngles(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): { group: MulticamGroup; project: Project } {
	const request = multicamChangeRequestSchema.parse(input);
	const group = project.multicamGroups.find(
		(candidate) => candidate.id === request.groupId
	);
	if (!group) {
		throw new Error("Multicam group not found.");
	}
	const switches = mergedSwitches(group, request.entries);
	const nextGroupBase = { ...group, switches };
	const built = buildSegments(nextGroupBase, assets);
	const nextGroup = { ...nextGroupBase, segmentIds: built.segmentIds };
	const nextProject = validateProject(
		{
			...project,
			multicamGroups: project.multicamGroups.map((candidate) =>
				candidate.id === group.id ? nextGroup : candidate
			),
			segments: [
				...project.segments.filter(
					(segment) =>
						segment.multicamGroupId !== group.id &&
						!group.segmentIds.includes(segment.id)
				),
				...built.segments,
			],
		},
		[...assets]
	);
	return {
		group: nextProject.multicamGroups.find(
			(candidate) => candidate.id === group.id
		)!,
		project: nextProject,
	};
}

export function ungroupMulticam(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = multicamUngroupRequestSchema.parse(input);
	if (!project.multicamGroups.some((group) => group.id === request.groupId)) {
		throw new Error("Multicam group not found.");
	}
	return validateProject(
		{
			...project,
			multicamGroups: project.multicamGroups.filter(
				(group) => group.id !== request.groupId
			),
			segments: project.segments.map((segment) =>
				segment.multicamGroupId === request.groupId
					? { ...segment, multicamGroupId: undefined }
					: segment
			),
		},
		[...assets]
	);
}
