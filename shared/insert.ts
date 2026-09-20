import { z } from "zod";
import {
	type Asset,
	newSegment,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
	splitSegment,
	validateProject,
} from "./project.ts";

const timelineTime = z.number().finite().min(0).max(7200);

export const insertClipSchema = z
	.object({
		assetId: z.uuid(),
		sourceIn: timelineTime.default(0),
		sourceOut: timelineTime.optional(),
		speed: z.number().finite().min(0.25).max(4).default(1),
		volume: z.number().finite().min(0).max(4).default(1),
	})
	.strict();
export type InsertClip = z.infer<typeof insertClipSchema>;

export const insertClipsRequestSchema = z
	.object({
		at: timelineTime,
		entries: z.array(insertClipSchema).min(1).max(30),
		revision: z.number().int().nonnegative(),
		track: z.number().int().min(0).max(15),
	})
	.strict();
export type InsertClipsRequest = z.infer<typeof insertClipsRequestSchema>;

/** Insert clips at one timeline point and ripple every later timed layer right. */
export function insertClips(
	project: Project,
	assets: readonly Asset[],
	at: number,
	track: number,
	entries: readonly InsertClip[]
): Project {
	if (!(Number.isFinite(at) && at >= 0 && at <= projectDuration(project))) {
		throw new Error("Choose an insertion point inside the timeline.");
	}
	if (!entries.length) {
		throw new Error("Choose at least one clip to insert.");
	}
	const parsedEntries = entries.map((entry) => insertClipSchema.parse(entry));
	let insertedDuration = 0;
	const inserted: Segment[] = [];
	for (const entry of parsedEntries) {
		const asset = assets.find((candidate) => candidate.id === entry.assetId);
		if (!asset) {
			throw new Error("An inserted clip references missing media.");
		}
		const sourceDuration =
			asset.kind === "image" ? Math.max(5, asset.duration) : asset.duration;
		const sourceOut = entry.sourceOut ?? sourceDuration;
		if (
			entry.sourceIn >= sourceOut ||
			sourceOut > sourceDuration + 0.05 ||
			sourceOut - entry.sourceIn < 0.04
		) {
			throw new Error("An inserted clip range is outside its source duration.");
		}
		const segment = {
			...newSegment(asset, at + insertedDuration, track),
			sourceIn: entry.sourceIn,
			sourceOut: Math.min(asset.duration, sourceOut),
			speed: entry.speed,
			volume: entry.volume,
		};
		inserted.push(segment);
		insertedDuration += segmentDuration(segment);
	}
	if (at + insertedDuration > 7200) {
		throw new Error(
			"The insertion would make this project longer than two hours."
		);
	}
	const mapTime = (value: number) =>
		value < at ? value : value + insertedDuration;
	const segments: Segment[] = [];
	for (const segment of project.segments) {
		const end = segment.start + segmentDuration(segment);
		if (end <= at) {
			segments.push(segment);
			continue;
		}
		if (segment.start >= at) {
			segments.push({ ...segment, start: segment.start + insertedDuration });
			continue;
		}
		const [left, right] = splitSegment(segment, at);
		segments.push(left, {
			...right,
			start: right.start + insertedDuration,
		});
	}
	const timed = <T extends { end: number; start: number }>(
		items: readonly T[]
	) =>
		items.map((item) => ({
			...item,
			end: mapTime(item.end),
			start: mapTime(item.start),
		}));
	const mapCaptions = (items: Project["captions"]) =>
		items.map((caption) => ({
			...caption,
			end: mapTime(caption.end),
			start: mapTime(caption.start),
			words: caption.words?.map((word) => ({
				...word,
				end: mapTime(word.end),
				start: mapTime(word.start),
			})),
		}));
	const captions = mapCaptions(project.captions);
	const captionTracks = project.captionTracks.map((track) => ({
		...track,
		captions: mapCaptions(track.captions),
	}));
	const markers = project.markers.map((marker) => ({
		...marker,
		time: mapTime(marker.time),
	}));
	return validateProject(
		{
			...project,
			captions,
			captionTracks,
			graphics: timed(project.graphics),
			markers,
			segments: [...segments, ...inserted].sort(
				(a, b) => a.track - b.track || a.start - b.start
			),
			titles: timed(project.titles),
			avatars: timed(project.avatars),
			spatialObjects: timed(project.spatialObjects),
			meshes: timed(project.meshes),
		},
		[...assets]
	);
}
