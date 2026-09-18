import { z } from "zod";
import {
	type Asset,
	idSchema,
	newSegment,
	type Project,
	type Segment,
	validateProject,
} from "./project.ts";

export const recipeSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		kind: z.enum([
			"animated-explainer",
			"cinematic",
			"montage",
			"narrated-slides",
			"waveform",
			"clip-factory",
			"multicam",
		]),
		assetIds: z.array(idSchema).max(30),
		audioId: idSchema.nullable(),
		shotDuration: z.number().min(0.5).max(60),
		title: z.string().trim().max(200),
		format: z.enum(["landscape", "vertical", "square"]),
	})
	.strict();
export type Recipe = z.infer<typeof recipeSchema>;

export function composeRecipe(
	project: Project,
	assets: Asset[],
	input: unknown
): Project {
	const recipe = recipeSchema.parse(input);
	if (recipe.revision !== project.revision) {
		throw new Error("The project changed. Reload before applying a recipe.");
	}
	if (new Set(recipe.assetIds).size !== recipe.assetIds.length) {
		throw new Error("Choose each visual source once.");
	}
	const selected = recipe.assetIds.map((id) => {
		const asset = assets.find((item) => item.id === id);
		if (!asset || asset.kind === "audio") {
			throw new Error("A selected visual source is unavailable.");
		}
		return asset;
	});
	const audio = recipe.audioId
		? assets.find((item) => item.id === recipe.audioId)
		: undefined;
	if (recipe.audioId && (audio?.kind !== "audio" || audio.duration < 0.04)) {
		throw new Error("Choose an available audio source.");
	}
	if (["narrated-slides", "waveform"].includes(recipe.kind) && !audio) {
		throw new Error("This recipe needs a narration or audio source.");
	}
	if (
		recipe.kind !== "waveform" &&
		recipe.kind !== "animated-explainer" &&
		!selected.length
	) {
		throw new Error("Choose visual sources in their playback order.");
	}
	if (recipe.kind === "waveform" && selected.length > 1) {
		throw new Error("Waveform video accepts one optional background image.");
	}
	if (
		recipe.kind === "narrated-slides" &&
		selected.some((asset) => asset.kind !== "image")
	) {
		throw new Error("Choose still images for this recipe.");
	}
	if (recipe.kind === "clip-factory") {
		if (selected.length !== 1 || selected[0]?.kind !== "video") {
			throw new Error("Clip factory needs exactly one video source.");
		}
		const clipCount = Math.ceil(selected[0].duration / recipe.shotDuration);
		if (clipCount > 200) {
			throw new Error(
				"Choose a longer clip duration; clip factory output is limited to 200 clips."
			);
		}
	}
	if (recipe.kind === "multicam") {
		if (selected.length < 2 || selected.length > 4) {
			throw new Error("Multicam needs between two and four video sources.");
		}
		if (selected.some((asset) => asset.kind !== "video")) {
			throw new Error("Multicam sources must be video files.");
		}
		if (Math.min(...selected.map((asset) => asset.duration)) < 0.04) {
			throw new Error("A multicam source is too short.");
		}
	}
	const used = [...selected, ...(audio ? [audio] : [])];
	if (
		project.requireApproval &&
		used.some(
			(asset) =>
				!project.scenes.some(
					(scene) => scene.approved && scene.assetIds.includes(asset.id)
				)
		)
	) {
		throw new Error(
			"Approve the selected media in Plan before applying this recipe."
		);
	}
	const segments: Segment[] = [];
	let duration = 0;
	if (recipe.kind === "animated-explainer") {
		duration = audio ? Math.min(30, audio.duration) : 12;
		if (duration < 0.5) {
			throw new Error("The explainer needs at least half a second of audio.");
		}
	}
	if (recipe.kind === "multicam") {
		const shortest = Math.min(...selected.map((asset) => asset.duration));
		duration = audio ? Math.min(shortest, audio.duration) : shortest;
		if (duration < 0.04) {
			throw new Error("The multicam program has no usable duration.");
		}
		const cameraSegments = Math.ceil(duration / recipe.shotDuration);
		if (cameraSegments > 200) {
			throw new Error(
				"Choose a longer camera cut duration; multicam output is limited to 200 cuts."
			);
		}
		for (let index = 0; index < cameraSegments; index += 1) {
			const asset = selected[index % selected.length]!;
			const start = index * recipe.shotDuration;
			const length = Math.min(recipe.shotDuration, duration - start);
			segments.push({
				...newSegment(asset, start, 1),
				sourceIn: start,
				sourceOut: start + length,
				volume: 0,
				fadeIn: 0,
				fadeOut: 0,
			});
		}
		const programAudio = audio ?? selected[0]!;
		segments.push({
			...newSegment(programAudio, 0, 0),
			sourceOut: duration,
			volume: 1,
			opacity: 0,
			fadeIn: Math.min(0.1, duration / 4),
			fadeOut: Math.min(0.2, duration / 4),
		});
	}
	const sources =
		recipe.kind === "clip-factory"
			? Array.from(
					{
						length: Math.ceil(selected[0]!.duration / recipe.shotDuration),
					},
					(_, index) => ({
						asset: selected[0]!,
						sourceIn: index * recipe.shotDuration,
					})
				)
			: recipe.kind === "multicam" || recipe.kind === "animated-explainer"
				? []
				: selected.map((asset) => ({ asset, sourceIn: 0 }));
	for (const [index, source] of sources.entries()) {
		const { asset, sourceIn } = source;
		const length =
			recipe.kind === "clip-factory"
				? Math.min(recipe.shotDuration, asset.duration - sourceIn)
				: recipe.kind === "narrated-slides" && audio
					? audio.duration / selected.length
					: recipe.kind === "waveform" && audio
						? audio.duration
						: asset.kind === "image"
							? recipe.shotDuration
							: Math.min(recipe.shotDuration, asset.duration);
		if (length < 0.04) {
			throw new Error("A source is too short for this recipe.");
		}
		segments.push({
			...newSegment(asset, duration, 0),
			sourceIn,
			sourceOut: sourceIn + length,
			volume: audio ? 0 : 1,
			fadeIn: Math.min(0.2, length / 4),
			fadeOut: Math.min(0.2, length / 4),
			entryTransition:
				recipe.kind === "cinematic" && index > 0 ? "crossfade" : "none",
			entryDuration:
				recipe.kind === "cinematic"
					? Math.min(0.75, Math.max(0.04, length / 2))
					: 0.5,
			keyframes:
				asset.kind === "image" && recipe.kind === "narrated-slides"
					? [
							{
								id: crypto.randomUUID(),
								time: 0,
								property: "scale",
								value: index % 2 ? 1.08 : 1,
							},
							{
								id: crypto.randomUUID(),
								time: length,
								property: "scale",
								value: index % 2 ? 1 : 1.08,
							},
						]
					: [],
		});
		duration += length;
	}
	if (audio && recipe.kind !== "multicam") {
		if (recipe.kind === "waveform") {
			duration = audio.duration;
		}
		segments.push({
			...newSegment(audio, 0, 1),
			sourceOut: Math.min(audio.duration, duration),
			visualization: recipe.kind === "waveform" ? "waveform" : "none",
			y: recipe.kind === "waveform" ? 0.35 : 0,
			fadeIn: Math.min(0.1, Math.min(audio.duration, duration) / 4),
			fadeOut: Math.min(0.3, Math.min(audio.duration, duration) / 4),
		});
	}
	const explainerGraphics =
		recipe.kind === "animated-explainer"
			? [
					{
						animation: "slide-up" as const,
						end: duration,
						entryDuration: 0.45,
						fill: "#2563eb",
						height: 0.22,
						id: crypto.randomUUID(),
						opacity: 0.92,
						shape: "rectangle" as const,
						start: 0,
						stroke: "#93c5fd",
						strokeWidth: 0.008,
						width: 0.64,
						x: 0.18,
						y: 0.2,
					},
					{
						animation: "slide-right" as const,
						end: duration,
						entryDuration: 0.55,
						fill: "#f97316",
						height: 0.16,
						id: crypto.randomUUID(),
						opacity: 0.94,
						shape: "ellipse" as const,
						start: Math.min(0.25, duration / 8),
						stroke: "#fed7aa",
						strokeWidth: 0,
						width: 0.22,
						x: 0.65,
						y: 0.55,
					},
					{
						animation: "slide-left" as const,
						end: duration,
						entryDuration: 0.6,
						fill: "#14b8a6",
						height: 0.13,
						id: crypto.randomUUID(),
						opacity: 0.9,
						shape: "triangle" as const,
						start: Math.min(0.5, duration / 6),
						stroke: "#99f6e4",
						strokeWidth: 0,
						width: 0.2,
						x: 0.13,
						y: 0.62,
					},
				]
			: [];
	const size =
		recipe.format === "vertical"
			? [1080, 1920]
			: recipe.format === "square"
				? [1080, 1080]
				: [1920, 1080];
	const recipeMarkers =
		recipe.kind === "clip-factory"
			? sources.slice(1).flatMap((_, index) => {
					const time = segments[index + 1]?.start;
					return time === undefined ||
						project.markers.some((marker) => marker.time === time)
						? []
						: [{ id: crypto.randomUUID(), label: `Clip ${index + 2}`, time }];
				})
			: recipe.kind === "multicam"
				? segments.slice(1, -1).flatMap((segment, index) =>
						project.markers.some((marker) => marker.time === segment.start)
							? []
							: [
									{
										color: "#a78bfa",
										id: crypto.randomUUID(),
										label: `Camera ${((index + 1) % selected.length) + 1}`,
										time: segment.start,
									},
								]
					)
				: [];
	return validateProject(
		{
			...project,
			width: size[0],
			height: size[1],
			markers: [...project.markers, ...recipeMarkers],
			segments,
			captionTrackId: null,
			captionTracks: [],
			captions: [],
			graphics: explainerGraphics,
			titles: recipe.title
				? [
						{
							id: crypto.randomUUID(),
							start: 0,
							end: Math.min(duration, 3.5),
							text: recipe.title,
							x: 0.5,
							y: 0.3,
							fontSize: 0.07,
							color: "#ffffff",
							fadeIn: Math.min(0.25, duration / 4),
							fadeOut: Math.min(0.25, duration / 4),
						},
					]
				: [],
		},
		assets
	);
}
