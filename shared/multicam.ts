import { z } from "zod";
import { applyLayout, layoutRange, layoutSupported } from "./layouts.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	type MulticamGroup,
	type MulticamMember,
	type MulticamSwitch,
	multicamGroupSchema,
	multicamSwitchLayoutSchema,
	newSegment,
	type Project,
	projectDuration,
	segmentDuration,
	trackSettingFor,
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

const switchLabel = z.string().trim().min(1).max(80);

/**
 * One switch over `[start, end)`. `angle` cuts to a full-frame camera (and
 * clears a layout), `layout` shows several angles at once in slot order (its
 * first angle leads), and `audio` picks the mic member heard as program
 * audio. Entries apply in order.
 */
export const multicamChangeEntrySchema = z
	.object({
		angle: switchLabel.optional(),
		audio: switchLabel.optional(),
		end: time,
		layout: multicamSwitchLayoutSchema.optional(),
		start: time,
	})
	.strict()
	.refine(
		(entry) =>
			entry.angle !== undefined ||
			entry.audio !== undefined ||
			entry.layout !== undefined,
		"A multicam switch needs an angle, a mic, or a layout."
	);
export type MulticamChangeEntry = z.input<typeof multicamChangeEntrySchema>;

export const multicamChangeRequestSchema = z
	.object({
		action: z.literal("change"),
		entries: z.array(multicamChangeEntrySchema).min(1).max(100),
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

interface MulticamSegments {
	segmentIds: string[];
	segments: Project["segments"];
}

export interface MulticamEditResult {
	group: MulticamGroup;
	project: Project;
}

/** A program picture range: the angles shown and how they are arranged. */
export interface MulticamVideoRange {
	/** Shown angles in layout slot order; the first leads. */
	angles: string[];
	end: number;
	layout?: MulticamSwitch["layout"];
	start: number;
}

/** A program audio range and the mic member heard during it. */
export interface MulticamAudioRange {
	end: number;
	mic: string;
	start: number;
}

export interface MulticamExpansion {
	audio: MulticamAudioRange[];
	video: MulticamVideoRange[];
}

function masterLabel(group: MulticamGroup): string {
	const master = group.members.find(
		(member) => member.assetId === group.masterAssetId
	);
	if (!master) {
		throw new Error("A multicam master is unavailable.");
	}
	return master.label;
}

/** Shortest program range a switch may cover; shorter slivers are absorbed. */
const MIN_SWITCH_SECONDS = 0.04;

/**
 * Expand switches into program ranges. Picture follows each switch's angle
 * or layout; audio follows each switch's mic (the master by default), with
 * neighbouring ranges on the same mic merged into one. Gaps shorter than a
 * minimum switch (older sessions may carry them) are bridged so program
 * audio never drops out between switches.
 */
export function expandMulticamSwitches(
	group: MulticamGroup
): MulticamExpansion {
	const master = masterLabel(group);
	const video = group.switches.map((switchPoint): MulticamVideoRange => {
		const layout = switchPoint.layout;
		return layout
			? {
					angles: [...layout.angles],
					end: switchPoint.end,
					layout,
					start: switchPoint.start,
				}
			: {
					angles: [switchPoint.angle],
					end: switchPoint.end,
					start: switchPoint.start,
				};
	});
	const audio: MulticamAudioRange[] = [];
	for (const switchPoint of group.switches) {
		const mic = switchPoint.audio ?? master;
		const previous = audio.at(-1);
		if (
			previous?.mic === mic &&
			switchPoint.start - previous.end < MIN_SWITCH_SECONDS
		) {
			previous.end = switchPoint.end;
		} else {
			audio.push({ end: switchPoint.end, mic, start: switchPoint.start });
		}
	}
	return { audio, video };
}

/**
 * Tracks for each layout slot. The lead angle stays on track 0 (track 1
 * carries program audio); further slots take the lowest tracks from 2 up
 * that are unlocked and hold no clips outside this group across the whole
 * group range, so a rebuild picks the same tracks for the same project.
 */
export function multicamSlotTracks(
	project: Pick<Project, "segments" | "trackSettings">,
	group: Pick<
		MulticamGroup,
		"duration" | "id" | "segmentIds" | "start" | "switches"
	>
): number[] {
	const slots = Math.max(
		1,
		...group.switches.map(
			(switchPoint) => switchPoint.layout?.angles.length ?? 1
		)
	);
	const end = group.start + group.duration;
	const occupied = new Set<number>();
	for (const segment of project.segments) {
		if (
			segment.multicamGroupId === group.id ||
			group.segmentIds.includes(segment.id)
		) {
			continue;
		}
		const segmentEnd = segment.start + segmentDuration(segment);
		if (segment.start < end && segmentEnd > group.start) {
			occupied.add(segment.track);
		}
	}
	const tracks = [0];
	for (
		let track = 2;
		tracks.length < slots && track <= MAX_TRACK_INDEX;
		track += 1
	) {
		if (!(occupied.has(track) || trackSettingFor(project, track).locked)) {
			tracks.push(track);
		}
	}
	if (tracks.length < slots) {
		throw new Error(
			"Not enough free, unlocked tracks for this layout. Clear or unlock tracks above the multicam session, or pick fewer angles."
		);
	}
	return tracks;
}

function memberSegment(
	group: MulticamGroup,
	member: MulticamMember,
	asset: Asset,
	range: { end: number; start: number },
	track: number,
	role: "picture" | "sound"
): Project["segments"][number] {
	const sourceIn = Math.max(
		0,
		range.start - group.start + member.offsetSeconds
	);
	const length = range.end - range.start;
	if (sourceIn + length > asset.duration + 0.05) {
		throw new Error(
			role === "picture"
				? "A multicam angle does not cover its switch range."
				: "A multicam mic does not cover its program audio range."
		);
	}
	return {
		...newSegment(asset, range.start, track),
		fadeIn: 0,
		fadeOut: 0,
		multicamGroupId: group.id,
		sourceIn,
		sourceOut: Math.min(asset.duration, sourceIn + length),
		...(role === "picture" ? { volume: 0 } : { opacity: 0, volume: 1 }),
	};
}

function buildSegments(
	project: Project,
	group: MulticamGroup,
	assets: readonly Asset[]
): MulticamSegments {
	const byLabel = memberAssets(group.members, assets);
	const members = new Map(
		group.members.map((member) => [member.label, member])
	);
	const resolve = (label: string, message: string) => {
		const member = members.get(label);
		const asset = member ? byLabel.get(member.label) : undefined;
		if (!(member && asset)) {
			throw new Error(message);
		}
		return { asset, member };
	};
	const expansion = expandMulticamSwitches(group);
	const slotTracks = multicamSlotTracks(project, group);
	const segments: Project["segments"] = [];
	for (const range of expansion.video) {
		const shown = range.angles.map((label, slot) => {
			const { asset, member } = resolve(
				label,
				"A multicam switch references an unavailable angle."
			);
			return memberSegment(
				group,
				member,
				asset,
				range,
				slotTracks[slot]!,
				"picture"
			);
		});
		const layout = range.layout;
		if (layout) {
			const arranged = applyLayout(
				{ ...project, segments: shown },
				shown.map((segment) => segment.id),
				layout.layout
			).segments;
			segments.push(
				...arranged.map((segment) => ({ ...segment, fit: layout.fit }))
			);
		} else {
			segments.push(...shown);
		}
	}
	for (const range of expansion.audio) {
		const { asset, member } = resolve(
			range.mic,
			"A multicam mic is unavailable."
		);
		if (member.kind === "angle") {
			throw new Error(
				"A multicam audio switch must name a mic or both member."
			);
		}
		segments.push(memberSegment(group, member, asset, range, 1, "sound"));
	}
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

function switchAt(group: MulticamGroup, at: number): MulticamSwitch {
	return (
		group.switches.find(
			(switchPoint) => switchPoint.start <= at && at < switchPoint.end
		) ?? group.switches[0]!
	);
}

function layoutKey(layout: MulticamSwitch["layout"]): string {
	return layout
		? `${layout.layout}|${layout.fit}|${layout.angles.join("\u0000")}`
		: "";
}

function sameProgram(left: MulticamSwitch, right: MulticamSwitch): boolean {
	return (
		left.angle === right.angle &&
		left.audio === right.audio &&
		layoutKey(left.layout) === layoutKey(right.layout)
	);
}

type ParsedEntry = z.output<typeof multicamChangeEntrySchema>;

function validateEntry(group: MulticamGroup, entry: ParsedEntry): void {
	const angles = new Set(angleMembers(group).map((member) => member.label));
	const mics = new Set(
		group.members
			.filter((member) => member.kind !== "angle")
			.map((member) => member.label)
	);
	if (
		entry.end <= entry.start ||
		entry.start < group.start ||
		entry.end > group.start + group.duration
	) {
		throw new Error("A multicam switch must stay inside the group range.");
	}
	if (entry.angle !== undefined && !angles.has(entry.angle)) {
		throw new Error(`"${entry.angle}" is not a camera angle in this session.`);
	}
	if (entry.audio !== undefined && !mics.has(entry.audio)) {
		throw new Error(`"${entry.audio}" is not a microphone in this session.`);
	}
	const layout = entry.layout;
	if (!layout) {
		return;
	}
	if (!layoutSupported(layout.layout)) {
		throw new Error("That layout is not available for multicam yet.");
	}
	const { max, min } = layoutRange(layout.layout);
	if (
		layout.angles.length < min ||
		layout.angles.length > max ||
		new Set(layout.angles).size !== layout.angles.length ||
		layout.angles.some((angle) => !angles.has(angle))
	) {
		throw new Error(
			`The layout needs ${min === max ? min : `${min}-${max}`} distinct camera angles from this session.`
		);
	}
	if (entry.angle !== undefined && entry.angle !== layout.angles[0]) {
		throw new Error("A layout's lead angle is its first listed angle.");
	}
}

function applyEntry(
	state: MulticamSwitch,
	entry: ParsedEntry,
	master: string
): MulticamSwitch {
	const next: MulticamSwitch = { ...state };
	if (entry.layout) {
		next.layout = entry.layout;
		next.angle = entry.layout.angles[0]!;
	} else if (entry.angle !== undefined) {
		next.angle = entry.angle;
		next.layout = undefined;
	}
	if (entry.audio !== undefined) {
		next.audio = entry.audio === master ? undefined : entry.audio;
	}
	return withoutUndefined(next);
}

function withoutUndefined(switchPoint: MulticamSwitch): MulticamSwitch {
	const result: MulticamSwitch = {
		angle: switchPoint.angle,
		end: switchPoint.end,
		start: switchPoint.start,
	};
	if (switchPoint.audio !== undefined) {
		result.audio = switchPoint.audio;
	}
	if (switchPoint.layout !== undefined) {
		result.layout = switchPoint.layout;
	}
	return result;
}

/**
 * Drop boundaries that would leave a range shorter than a minimum switch, so
 * the slivers fold into a neighbouring range instead of leaving a gap. The
 * first and last boundaries (the group range) always stay.
 */
function contiguousBoundaries(ordered: readonly number[]): number[] {
	const kept: number[] = [];
	for (const [index, boundary] of ordered.entries()) {
		const previous = kept.at(-1);
		if (previous === undefined || boundary - previous >= MIN_SWITCH_SECONDS) {
			kept.push(boundary);
		} else if (index === ordered.length - 1) {
			if (kept.length > 1) {
				kept[kept.length - 1] = boundary;
			} else {
				kept.push(boundary);
			}
		}
	}
	return kept;
}

function mergedSwitches(
	group: MulticamGroup,
	entries: readonly ParsedEntry[]
): MulticamSwitch[] {
	for (const entry of entries) {
		validateEntry(group, entry);
	}
	const master = masterLabel(group);
	const boundaries = new Set<number>([
		group.start,
		group.start + group.duration,
		...group.switches.flatMap((switchPoint) => [
			switchPoint.start,
			switchPoint.end,
		]),
		...entries.flatMap((entry) => [entry.start, entry.end]),
	]);
	const ordered = contiguousBoundaries([...boundaries].sort((a, b) => a - b));
	const result: MulticamSwitch[] = [];
	for (let index = 0; index < ordered.length - 1; index += 1) {
		const start = ordered[index]!;
		const end = ordered[index + 1]!;
		// A range may have absorbed slivers shorter than a minimum switch at its
		// start, so its state comes from its midpoint rather than its start.
		const middle = (start + end) / 2;
		let state = withoutUndefined({ ...switchAt(group, middle), end, start });
		for (const entry of entries) {
			if (entry.start <= middle && middle < entry.end) {
				state = applyEntry(state, entry, master);
			}
		}
		const previous = result.at(-1);
		if (previous && previous.end === start && sameProgram(previous, state)) {
			previous.end = end;
		} else {
			result.push(state);
		}
	}
	return result;
}

/** The multicam group whose program range contains `time`. */
export function multicamGroupAt(
	project: Pick<Project, "multicamGroups">,
	time: number
): MulticamGroup | undefined {
	return project.multicamGroups.find(
		(group) => group.start <= time && time < group.start + group.duration
	);
}

/**
 * The switch a 1-9 (angle) or Alt+1-9 (mic) key makes at `time`: the n-th
 * angle or mic member takes over from the playhead to the end of the
 * current switch. Null when there is nothing to change.
 */
export function multicamShortcutEntry(
	group: MulticamGroup,
	time: number,
	kind: "angle" | "mic",
	index: number
): MulticamChangeEntry | null {
	const candidates =
		kind === "angle"
			? angleMembers(group)
			: group.members.filter((member) => member.kind !== "angle");
	const member = candidates[index];
	if (!member || time < group.start || time >= group.start + group.duration) {
		return null;
	}
	const current = switchAt(group, time);
	const start = Number(Math.max(group.start, time).toFixed(3));
	if (current.end - start < MIN_SWITCH_SECONDS) {
		return null;
	}
	if (kind === "angle") {
		return current.angle === member.label && !current.layout
			? null
			: { angle: member.label, end: current.end, start };
	}
	return (current.audio ?? masterLabel(group)) === member.label
		? null
		: { audio: member.label, end: current.end, start };
}

export type CreateMulticamGroupInput = z.input<
	typeof multicamCreateRequestSchema
>;

export function createMulticamGroup(
	project: Project,
	assets: readonly Asset[],
	input: CreateMulticamGroupInput
): MulticamEditResult {
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
	const built = buildSegments(project, group, assets);
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

export type ChangeMulticamAnglesInput = z.input<
	typeof multicamChangeRequestSchema
>;

export function changeMulticamAngles(
	project: Project,
	assets: readonly Asset[],
	input: ChangeMulticamAnglesInput
): MulticamEditResult {
	const request = multicamChangeRequestSchema.parse(input);
	const group = project.multicamGroups.find(
		(candidate) => candidate.id === request.groupId
	);
	if (!group) {
		throw new Error("Multicam group not found.");
	}
	const switches = mergedSwitches(group, request.entries);
	const nextGroupBase = { ...group, switches };
	const built = buildSegments(project, nextGroupBase, assets);
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

export type UngroupMulticamInput = z.input<typeof multicamUngroupRequestSchema>;

export function ungroupMulticam(
	project: Project,
	assets: readonly Asset[],
	input: UngroupMulticamInput
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
