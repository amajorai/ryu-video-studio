/**
 * Entity-level three-way merge of a project.
 *
 * `base` is the revision the editor last saved or loaded, `local` is the
 * editor's project with its unsaved edits on top of `base`, and `remote` is a
 * newer revision saved elsewhere (an agent route, another window). Clips,
 * tracks, titles, captions, markers and the other id-keyed lists are matched
 * by id and merged field by field: a field changed on one side only takes
 * that side's value, the same change on both sides is kept once, and
 * different changes to the same field are reported as a conflict. Deleting
 * an entity on one side while the other side edited it is a conflict too.
 *
 * A clean merge returns a project at the remote revision carrying both sides'
 * edits, so the editor can keep its edits (still unsaved) on top of the newer
 * revision. A merge with conflicts returns no project; the caller keeps the
 * "Changed elsewhere" flow and lists the conflicts.
 */
import {
	type Project,
	projectSchema,
	type Segment,
	segmentDuration,
} from "./project.ts";

/** The lists merged entity by entity, with how each entity is keyed. */
const KEYED_LISTS = {
	adjustmentLayers: "id",
	avatars: "id",
	captionTracks: "id",
	captions: "id",
	graphics: "id",
	markers: "id",
	meshes: "id",
	multicamGroups: "id",
	researchSources: "id",
	scenes: "id",
	segments: "id",
	spatialObjects: "id",
	titles: "id",
	trackSettings: "track",
} as const satisfies Partial<Record<keyof Project, string>>;

export type MergeCollection = keyof typeof KEYED_LISTS | "project";

/** Fields every save rewrites, or that the sidecar owns. */
const SERVER_FIELDS: ReadonlySet<string> = new Set([
	"decisions",
	"id",
	"revision",
	"schemaVersion",
	"updatedAt",
]);

export type MergeConflictKind =
	/** Both sides set the same field to different values. */
	| "both-changed"
	/** Edited here, deleted elsewhere. */
	| "deleted-remotely"
	/** Deleted here, edited elsewhere. */
	| "deleted-locally"
	/** Both sides' clips land on top of each other on one track. */
	| "overlap"
	/**
	 * The other side renumbered the tracks (removed, inserted or reordered
	 * them) and this side's track edits cannot be carried onto the new
	 * numbering with certainty.
	 */
	| "tracks"
	/** The merged project fails the project schema. */
	| "invalid";

export interface MergeConflict {
	collection: MergeCollection;
	/** The field both sides changed, when the conflict is about one field. */
	field?: string;
	/** Entity id (or track number), absent for project-level fields. */
	id?: string;
	kind: MergeConflictKind;
	/** A human name for the entity when it has one (clip asset, title text). */
	name?: string;
}

export type ProjectMergeResult =
	| { conflicts: []; project: Project; status: "clean" }
	| { conflicts: MergeConflict[]; status: "conflict" };

type Entity = Readonly<Record<string, unknown>>;

/** Structural equality that ignores object key order. */
export function sameValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null
	) {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => sameValue(item, right[index]))
		);
	}
	const leftRecord = left as Entity;
	const rightRecord = right as Entity;
	const leftKeys = Object.keys(leftRecord).filter(
		(key) => leftRecord[key] !== undefined
	);
	const rightKeys = Object.keys(rightRecord).filter(
		(key) => rightRecord[key] !== undefined
	);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => sameValue(leftRecord[key], rightRecord[key]))
	);
}

interface FieldPick {
	conflict: boolean;
	value: unknown;
}

/** The three-way choice for one value. */
function pick(base: unknown, local: unknown, remote: unknown): FieldPick {
	if (sameValue(local, base)) {
		return { conflict: false, value: remote };
	}
	if (sameValue(remote, base) || sameValue(local, remote)) {
		return { conflict: false, value: local };
	}
	return { conflict: true, value: local };
}

function entityName(entity: Entity | undefined): string | undefined {
	if (!entity) {
		return;
	}
	for (const key of ["name", "label", "text", "title"]) {
		const value = entity[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim().slice(0, 60);
		}
	}
	return;
}

function keyOf(entity: Entity, key: string): string | null {
	const value = entity[key];
	return typeof value === "string" || typeof value === "number"
		? String(value)
		: null;
}

/** Index a list by its key, or null when an item has no usable key. */
function indexList(
	list: unknown,
	key: string
): Map<string, Entity> | null | undefined {
	if (list === undefined) {
		return;
	}
	if (!Array.isArray(list)) {
		return null;
	}
	const index = new Map<string, Entity>();
	for (const item of list) {
		if (typeof item !== "object" || item === null) {
			return null;
		}
		const id = keyOf(item as Entity, key);
		if (id === null || index.has(id)) {
			return null;
		}
		index.set(id, item as Entity);
	}
	return index;
}

/** Merge one entity present on all sides, field by field. */
function mergeEntity(
	base: Entity,
	local: Entity,
	remote: Entity,
	report: (field: string) => void
): Entity {
	const merged: Record<string, unknown> = {};
	const fields = new Set([
		...Object.keys(base),
		...Object.keys(local),
		...Object.keys(remote),
	]);
	for (const field of fields) {
		const choice = pick(base[field], local[field], remote[field]);
		if (choice.conflict) {
			report(field);
		}
		if (choice.value !== undefined) {
			merged[field] = choice.value;
		}
	}
	return merged;
}

/**
 * The merged order: the remote order, with entities only the editor added
 * placed after the entity that precedes them locally.
 */
function mergedOrder(
	localOrder: readonly string[],
	remoteOrder: readonly string[],
	kept: ReadonlySet<string>
): string[] {
	const order = remoteOrder.filter((id) => kept.has(id));
	const placed = new Set(order);
	let previous: string | null = null;
	for (const id of localOrder) {
		if (kept.has(id) && !placed.has(id)) {
			const at = previous === null ? 0 : order.indexOf(previous) + 1;
			order.splice(at, 0, id);
			placed.add(id);
		}
		if (placed.has(id)) {
			previous = id;
		}
	}
	return order;
}

function mergeList(
	collection: keyof typeof KEYED_LISTS,
	lists: { base: unknown; local: unknown; remote: unknown },
	conflicts: MergeConflict[]
): { value: unknown } {
	const key = KEYED_LISTS[collection];
	const base = indexList(lists.base, key) ?? new Map<string, Entity>();
	const local = indexList(lists.local, key);
	const remote = indexList(lists.remote, key);
	if (local === null || remote === null) {
		// Not keyable: fall back to a whole-list choice.
		const choice = pick(lists.base, lists.local, lists.remote);
		if (choice.conflict) {
			conflicts.push({ collection, kind: "both-changed" });
		}
		return { value: choice.value };
	}
	if (local === undefined || remote === undefined) {
		return { value: pick(lists.base, lists.local, lists.remote).value };
	}
	const merged = new Map<string, Entity>();
	const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
	for (const id of ids) {
		const was = base.get(id);
		const here = local.get(id);
		const there = remote.get(id);
		const name = entityName(here ?? there ?? was);
		const conflict = (kind: MergeConflictKind, field?: string) =>
			conflicts.push({
				collection,
				id,
				kind,
				...(field ? { field } : {}),
				...(name ? { name } : {}),
			});
		if (here && there) {
			merged.set(
				id,
				mergeEntity(was ?? {}, here, there, (field) =>
					conflict("both-changed", field)
				)
			);
		} else if (here && was) {
			// Deleted elsewhere: fine unless the editor changed it.
			if (!sameValue(here, was)) {
				conflict("deleted-remotely");
			}
		} else if (there && was) {
			// Deleted here: fine unless it changed elsewhere.
			if (!sameValue(there, was)) {
				conflict("deleted-locally");
			}
		} else if (here ?? there) {
			merged.set(id, (here ?? there) as Entity);
		}
	}
	const order = mergedOrder(
		[...local.keys()],
		[...remote.keys()],
		new Set(merged.keys())
	);
	return { value: order.map((id) => merged.get(id)) };
}

function segmentsOverlap(left: Segment, right: Segment): boolean {
	if (left.track !== right.track) {
		return false;
	}
	const leftEnd = left.start + segmentDuration(left);
	const rightEnd = right.start + segmentDuration(right);
	return left.start < rightEnd - 1e-6 && right.start < leftEnd - 1e-6;
}

function overlappingPairs(segments: readonly Segment[]): Set<string> {
	const pairs = new Set<string>();
	const byTrack = new Map<number, Segment[]>();
	for (const segment of segments) {
		const lane = byTrack.get(segment.track) ?? [];
		lane.push(segment);
		byTrack.set(segment.track, lane);
	}
	for (const lane of byTrack.values()) {
		const sorted = [...lane].sort((a, b) => a.start - b.start);
		for (let index = 0; index < sorted.length; index++) {
			const current = sorted[index] as Segment;
			for (let next = index + 1; next < sorted.length; next++) {
				const other = sorted[next] as Segment;
				if (other.start >= current.start + segmentDuration(current)) {
					break;
				}
				if (segmentsOverlap(current, other)) {
					pairs.add([current.id, other.id].sort().join("|"));
				}
			}
		}
	}
	return pairs;
}

/**
 * Clips that overlap only after the merge (each side moved one clip into a
 * spot that was free on its own side).
 */
function newOverlaps(
	merged: readonly Segment[],
	local: readonly Segment[],
	remote: readonly Segment[]
): MergeConflict[] {
	const allowed = new Set([
		...overlappingPairs(local),
		...overlappingPairs(remote),
	]);
	const conflicts: MergeConflict[] = [];
	for (const pair of overlappingPairs(merged)) {
		if (!allowed.has(pair)) {
			const [id] = pair.split("|");
			conflicts.push({
				collection: "segments",
				kind: "overlap",
				...(id ? { id } : {}),
			});
		}
	}
	return conflicts;
}

/** Where each base track sits in `remote`, read from the clips both share. */
interface TrackRenumbering {
	/** True when at least two tracks moved: a reorder, insert or shift. */
	certain: boolean;
	/** Base track to remote track, for tracks whose clips all moved together. */
	map: ReadonlyMap<number, number>;
	/** True when the remote side renumbered whole tracks. */
	renumbered: boolean;
}

/**
 * Infer the remote side's track renumbering. A track whose surviving clips
 * all sit on one other remote track moved as a whole; tracks whose clips
 * stayed map to themselves. Clips moved one by one (a track's clips split
 * over several tracks, or two tracks folded into one) are not a renumbering.
 */
function remoteRenumbering(base: Project, remote: Project): TrackRenumbering {
	const remoteTrack = new Map(
		remote.segments.map((segment) => [segment.id, segment.track])
	);
	const targets = new Map<number, Set<number>>();
	for (const segment of base.segments) {
		const there = remoteTrack.get(segment.id);
		if (there === undefined) {
			continue;
		}
		const set = targets.get(segment.track) ?? new Set<number>();
		set.add(there);
		targets.set(segment.track, set);
	}
	const map = new Map<number, number>();
	for (const [track, set] of targets) {
		if (set.size === 1) {
			map.set(track, [...set][0] as number);
		}
	}
	const used = new Set(map.values());
	const moved = [...map].filter(([from, to]) => from !== to).length;
	const injective = used.size === map.size;
	const renumbered = injective && moved > 0;
	return { certain: renumbered && moved >= 2, map, renumbered };
}

/**
 * Carry the editor's track edits onto the remote side's track numbering.
 * Clips the editor added, or moved to another track, are moved through the
 * remote renumbering so they stay beside the clips they were placed with.
 * When that numbering is uncertain or does not cover a track the editor
 * used, or the editor changed track settings or adjustment layers (whose
 * tracks the remote side also rewrote), a `tracks` conflict is reported.
 */
function alignLocalTracks(
	base: Project,
	local: Project,
	remote: Project
): { base: Project; conflicts: MergeConflict[]; local: Project } {
	const renumbering = remoteRenumbering(base, remote);
	if (!renumbering.renumbered) {
		return { base, conflicts: [], local };
	}
	const baseTrack = new Map(
		base.segments.map((segment) => [segment.id, segment.track])
	);
	const touched = local.segments.filter(
		(segment) => baseTrack.get(segment.id) !== segment.track
	);
	const layersTouched = !sameValue(
		(local.adjustmentLayers ?? []).map((layer) => [layer.id, layer.track]),
		(base.adjustmentLayers ?? []).map((layer) => [layer.id, layer.track])
	);
	const settingsTouched = !sameValue(local.trackSettings, base.trackSettings);
	if (!(touched.length || layersTouched || settingsTouched)) {
		return { base, conflicts: [], local };
	}
	const conflict = (name?: string): MergeConflict => ({
		collection: "trackSettings",
		kind: "tracks",
		...(name ? { name } : {}),
	});
	if (layersTouched || settingsTouched) {
		return { base, conflicts: [conflict()], local };
	}
	const unmapped = touched.filter(
		(segment) => !renumbering.map.has(segment.track)
	);
	const moves = touched.some(
		(segment) => renumbering.map.get(segment.track) !== segment.track
	);
	const certain = renumbering.certain && unmapped.length === 0;
	if (!(certain || moves || unmapped.length)) {
		return { base, conflicts: [], local };
	}
	if (!certain) {
		return {
			base,
			conflicts: [conflict(entityName(unmapped[0]))],
			local,
		};
	}
	// Read base and local in the remote numbering, so a clip only the remote
	// side renumbered matches on both, and one the editor moved keeps its move.
	const renumber = (project: Project): Project => ({
		...project,
		segments: project.segments.map((segment) => {
			const track = renumbering.map.get(segment.track) ?? segment.track;
			return track === segment.track ? segment : { ...segment, track };
		}),
	});
	return { base: renumber(base), conflicts: [], local: renumber(local) };
}

/** Three-way merge `local` and `remote`, both descended from `base`. */
export function mergeProjects(
	base: Project,
	local: Project,
	remote: Project
): ProjectMergeResult {
	if (base.id !== local.id || remote.id !== local.id) {
		return {
			conflicts: [{ collection: "project", field: "id", kind: "invalid" }],
			status: "conflict",
		};
	}
	const aligned = alignLocalTracks(base, local, remote);
	if (aligned.conflicts.length) {
		return { conflicts: aligned.conflicts, status: "conflict" };
	}
	const conflicts: MergeConflict[] = [];
	const merged: Record<string, unknown> = {};
	const baseRecord = aligned.base as unknown as Entity;
	const localRecord = aligned.local as unknown as Entity;
	const remoteRecord = remote as unknown as Entity;
	const fields = new Set([
		...Object.keys(baseRecord),
		...Object.keys(localRecord),
		...Object.keys(remoteRecord),
	]);
	for (const field of fields) {
		if (SERVER_FIELDS.has(field)) {
			if (remoteRecord[field] !== undefined) {
				merged[field] = remoteRecord[field];
			}
			continue;
		}
		if (Object.hasOwn(KEYED_LISTS, field)) {
			const { value } = mergeList(
				field as keyof typeof KEYED_LISTS,
				{
					base: baseRecord[field],
					local: localRecord[field],
					remote: remoteRecord[field],
				},
				conflicts
			);
			if (value !== undefined) {
				merged[field] = value;
			}
			continue;
		}
		const choice = pick(
			baseRecord[field],
			localRecord[field],
			remoteRecord[field]
		);
		if (choice.conflict) {
			conflicts.push({ collection: "project", field, kind: "both-changed" });
		}
		if (choice.value !== undefined) {
			merged[field] = choice.value;
		}
	}
	if (conflicts.length) {
		return { conflicts, status: "conflict" };
	}
	const parsed = projectSchema.safeParse(merged);
	if (!parsed.success) {
		return {
			conflicts: [{ collection: "project", kind: "invalid" }],
			status: "conflict",
		};
	}
	const overlaps = newOverlaps(
		parsed.data.segments,
		aligned.local.segments,
		remote.segments
	);
	if (overlaps.length) {
		return { conflicts: overlaps, status: "conflict" };
	}
	return { conflicts: [], project: parsed.data, status: "clean" };
}

/** Singular English names of the merged entity kinds, for conflict lists. */
export const MERGE_COLLECTION_LABELS: Readonly<
	Record<MergeCollection, string>
> = {
	adjustmentLayers: "Adjustment layer",
	avatars: "Avatar",
	captionTracks: "Caption track",
	captions: "Caption",
	graphics: "Graphic",
	markers: "Marker",
	meshes: "3D object",
	multicamGroups: "Multicam group",
	project: "Project",
	researchSources: "Research source",
	scenes: "Scene",
	segments: "Clip",
	spatialObjects: "Stage object",
	titles: "Title",
	trackSettings: "Track",
};
