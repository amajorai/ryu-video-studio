import { expect, test } from "bun:test";
import {
	newProject,
	newSegment,
	projectDuration,
	rippleDeleteRange,
} from "./project.ts";

const video = {
	createdAt: new Date().toISOString(),
	duration: 10,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video" as const,
	name: "Camera A",
	width: 640,
};
const audio = {
	createdAt: new Date().toISOString(),
	duration: 10,
	hasAudio: true,
	height: 0,
	id: crypto.randomUUID(),
	kind: "audio" as const,
	name: "Program mix",
	width: 0,
};

test("ripple delete splits crossing clips and shifts later layers", () => {
	const first = {
		...newSegment(video),
		sourceOut: 8,
		keyframes: [
			{
				id: crypto.randomUUID(),
				property: "scale" as const,
				time: 1,
				value: 1.2,
			},
			{
				id: crypto.randomUUID(),
				property: "scale" as const,
				time: 6,
				value: 0.8,
			},
		],
	};
	const later = { ...newSegment(audio, 9, 1), sourceOut: 1 };
	const project = {
		...newProject(),
		segments: [first, later],
		captions: [
			{
				end: 3,
				id: crypto.randomUUID(),
				start: 1,
				text: "Removed cue",
			},
			{
				end: 7,
				id: crypto.randomUUID(),
				start: 5,
				text: "Kept cue",
			},
		],
		captionTracks: [
			{
				captions: [
					{
						end: 7,
						id: crypto.randomUUID(),
						start: 5,
						text: "Kept translated cue",
					},
				],
				id: crypto.randomUUID(),
				label: "Français",
				language: "fr",
			},
		],
		titles: [
			{
				animation: "fade" as const,
				color: "#ffffff",
				end: 10,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.07,
				id: crypto.randomUUID(),
				start: 6,
				text: "Title",
				x: 0.5,
				y: 0.3,
			},
		],
		markers: [
			{ id: crypto.randomUUID(), label: "Keep", time: 1 },
			{ id: crypto.randomUUID(), label: "Remove", time: 3 },
			{ id: crypto.randomUUID(), label: "Boundary", time: 4 },
		],
	};
	const next = rippleDeleteRange(project, [video, audio], 2, 4);
	const videoPieces = next.segments.filter(
		(segment) => segment.assetId === video.id
	);
	expect(
		videoPieces.map((segment) => [
			segment.start,
			segment.sourceIn,
			segment.sourceOut,
		])
	).toEqual([
		[0, 0, 2],
		[2, 4, 8],
	]);
	expect(
		next.segments.find((segment) => segment.assetId === audio.id)?.start
	).toBe(7);
	expect(
		next.captions.map((caption) => [caption.start, caption.end, caption.text])
	).toEqual([
		[1, 2, "Removed cue"],
		[3, 5, "Kept cue"],
	]);
	expect(
		next.captionTracks[0]?.captions.map((caption) => [
			caption.start,
			caption.end,
		])
	).toEqual([[3, 5]]);
	expect(next.titles.map((title) => [title.start, title.end])).toEqual([
		[4, 8],
	]);
	expect(next.markers.map((marker) => [marker.label, marker.time])).toEqual([
		["Keep", 1],
		["Boundary", 2],
	]);
	expect(projectDuration(next)).toBe(8);
	expect(
		videoPieces[1]?.keyframes.some((keyframe) => keyframe.time === 0)
	).toBe(true);
});

test("ripple delete rejects an empty or out-of-bounds range", () => {
	const project = newProject();
	const asset = { ...video };
	const segment = { ...newSegment(asset), sourceOut: 2 };
	const withMedia = { ...project, segments: [segment] };
	expect(() => rippleDeleteRange(withMedia, [asset], 1, 1)).toThrow("0.04");
	expect(() => rippleDeleteRange(withMedia, [asset], 0, 3)).toThrow("0.04");
});
