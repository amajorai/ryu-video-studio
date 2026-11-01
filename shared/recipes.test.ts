import { expect, test } from "bun:test";
import { type Asset, newProject, projectDuration } from "./project.ts";
import { composeRecipe, type Recipe } from "./recipes.ts";

const asset = (kind: Asset["kind"], duration = 6): Asset => ({
	id: crypto.randomUUID(),
	name: kind,
	kind,
	duration,
	width: kind === "audio" ? 0 : 640,
	height: kind === "audio" ? 0 : 360,
	hasAudio: kind !== "image",
	createdAt: new Date().toISOString(),
});
const recipe = (
	kind: Recipe["kind"],
	assetIds: string[],
	audioId: string | null = null
): Recipe => ({
	revision: 0,
	kind,
	assetIds,
	audioId,
	shotDuration: 5,
	title: "My film",
	format: "landscape",
});
test("montage bounds shots and uses selected order", () => {
	const a = asset("video", 2);
	const b = asset("image", 0);
	const result = composeRecipe(
		newProject(),
		[a, b],
		recipe("montage", [a.id, b.id])
	);
	expect(result.segments.map((s) => [s.assetId, s.start, s.sourceOut])).toEqual(
		[
			[a.id, 0, 2],
			[b.id, 2, 5],
		]
	);
	expect(projectDuration(result)).toBe(7);
});
test("cinematic montage crossfades later shots", () => {
	const a = asset("video", 3);
	const b = asset("video", 4);
	const result = composeRecipe(
		newProject(),
		[a, b],
		recipe("cinematic", [a.id, b.id])
	);
	expect(result.segments.map((segment) => segment.entryTransition)).toEqual([
		"none",
		"crossfade",
	]);
	expect(result.segments[1]?.entryDuration).toBe(0.75);
});
test("narrated slides cover the full narration with opposing zooms", () => {
	const a = asset("image", 0);
	const b = asset("image", 0);
	const audio = asset("audio", 7);
	const result = composeRecipe(
		newProject(),
		[a, b, audio],
		recipe("narrated-slides", [a.id, b.id], audio.id)
	);
	expect(result.segments.map((s) => s.sourceOut)).toEqual([3.5, 3.5, 7]);
	expect(result.segments[0]!.keyframes.map((k) => k.value)).toEqual([1, 1.08]);
	expect(result.segments[1]!.keyframes.map((k) => k.value)).toEqual([1.08, 1]);
	expect(projectDuration(result)).toBe(7);
});
test("waveform uses the entire audio and preserves approval gates", () => {
	const audio = asset("audio", 3.25);
	const input = recipe("waveform", [], audio.id);
	const result = composeRecipe(newProject(), [audio], input);
	expect(result.segments[0]!.visualization).toBe("waveform");
	expect(projectDuration(result)).toBe(3.25);
	expect(() =>
		composeRecipe({ ...newProject(), requireApproval: true }, [audio], input)
	).toThrow("Approve");
});

test("animated explainer builds an editable zero-key local composition", () => {
	const result = composeRecipe(
		newProject(),
		[],
		recipe("animated-explainer", [])
	);
	expect(result.graphics.map((graphic) => graphic.shape)).toEqual([
		"rectangle",
		"ellipse",
		"triangle",
	]);
	expect(result.titles).toHaveLength(1);
	expect(result.titles[0]).toMatchObject({ end: 3.5, text: "My film" });
	expect(projectDuration(result)).toBe(12);
});

test("clip factory cuts one long video into bounded clips and markers", () => {
	const video = asset("video", 6.2);
	const composed = composeRecipe(newProject(), [video], {
		...recipe("clip-factory", [video.id]),
		shotDuration: 2,
	});
	expect(
		composed.segments.map((segment) => [
			segment.start,
			segment.sourceIn,
			segment.sourceOut,
		])
	).toEqual([
		[0, 0, 2],
		[2, 2, 4],
		[4, 4, 6],
		[6, 6, 6.2],
	]);
	expect(composed.markers.map((marker) => [marker.label, marker.time])).toEqual(
		[
			["Clip 2", 2],
			["Clip 3", 4],
			["Clip 4", 6],
		]
	);
	expect(projectDuration(composed)).toBe(6.2);
	const image = asset("image");
	expect(() =>
		composeRecipe(newProject(), [image], recipe("clip-factory", [image.id]))
	).toThrow("exactly one video source");
});

test("multicam alternates synchronized cameras and isolates program audio", () => {
	const cameraA = asset("video", 4.3);
	const cameraB = asset("video", 3.2);
	const audio = asset("audio", 3.2);
	const composed = composeRecipe(newProject(), [cameraA, cameraB, audio], {
		...recipe("multicam", [cameraA.id, cameraB.id], audio.id),
		shotDuration: 1,
	});
	const visuals = composed.segments.filter((segment) => segment.track === 1);
	expect(
		visuals.map((segment) => [
			segment.assetId,
			segment.start,
			segment.sourceIn,
			segment.sourceOut,
			segment.volume,
		])
	).toEqual([
		[cameraA.id, 0, 0, 1, 0],
		[cameraB.id, 1, 1, 2, 0],
		[cameraA.id, 2, 2, 3, 0],
		[cameraB.id, 3, 3, 3.2, 0],
	]);
	const programAudio = composed.segments.find((segment) => segment.track === 0);
	expect(programAudio).toMatchObject({
		assetId: audio.id,
		opacity: 0,
		sourceOut: 3.2,
		volume: 1,
	});
	expect(composed.markers.map((marker) => [marker.label, marker.time])).toEqual(
		[
			["Camera 2", 1],
			["Camera 1", 2],
			["Camera 2", 3],
		]
	);
	expect(projectDuration(composed)).toBe(3.2);
});

test("multicam rejects a single angle or a still image", () => {
	const camera = asset("video");
	const still = asset("image");
	const input = recipe("multicam", [camera.id, still.id]);
	expect(() =>
		composeRecipe(newProject(), [camera], { ...input, assetIds: [camera.id] })
	).toThrow("between two and four");
	expect(() => composeRecipe(newProject(), [camera, still], input)).toThrow(
		"video files"
	);
});

test("recipes reject stale edits and incompatible inputs without mutating the project", () => {
	const project = newProject();
	const video = asset("video");
	const snapshot = JSON.stringify(project);
	expect(() =>
		composeRecipe(project, [video], {
			...recipe("montage", [video.id]),
			revision: 1,
		})
	).toThrow("changed");
	expect(() =>
		composeRecipe(project, [video], recipe("narrated-slides", [video.id]))
	).toThrow("audio");
	expect(() =>
		composeRecipe(project, [video], recipe("montage", [video.id, video.id]))
	).toThrow("once");
	expect(JSON.stringify(project)).toBe(snapshot);
});
