import {
	type Asset,
	avatarSchema,
	captionSchema,
	graphicSchema,
	meshSchema,
	newProject,
	type Project,
	segmentSchema,
	spatialObjectSchema,
	titleSchema,
} from "../../../../shared/project.ts";

/** Stable ids so rendered markup is deterministic across runs. */
const id = (suffix: number) =>
	`00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;

export const previewAssets: Asset[] = [
	{
		duration: 5,
		hasAudio: false,
		height: 720,
		id: id(0xa1),
		kind: "image",
		name: "Still",
		width: 1280,
	} as Asset,
	{
		duration: 8,
		hasAudio: false,
		height: 1080,
		id: id(0xa2),
		kind: "video",
		name: "Clip",
		width: 1920,
	} as Asset,
	{
		duration: 8,
		hasAudio: false,
		id: id(0xa3),
		kind: "audio",
		name: "Voice",
	} as Asset,
];

export const previewSources: Record<string, string> = {
	[id(0xa1)]: "blob:still",
	[id(0xa2)]: "blob:clip",
	[id(0xa3)]: "blob:voice",
};

const segmentBase = {
	brightness: 0,
	contrast: 1,
	fadeIn: 0,
	fadeOut: 0,
	opacity: 1,
	saturation: 1,
	scale: 1,
	sourceIn: 0,
	speed: 1,
	start: 0,
	volume: 1,
	x: 0,
	y: 0,
};

/** One of every preview layer kind, all active between 1 s and 3 s. */
export function previewProject(): Project {
	const project = newProject("Preview fixture");
	project.id = id(0xf0);
	project.updatedAt = "2026-01-01T00:00:00.000Z";
	project.segments = [
		segmentSchema.parse({
			...segmentBase,
			assetId: id(0xa1),
			effects: [{ amount: 0.5, type: "vignette" }],
			id: id(1),
			sourceOut: 5,
			track: 0,
		}),
		segmentSchema.parse({
			...segmentBase,
			assetId: id(0xa2),
			crop: { bottom: 0, left: 0.1, right: 0, top: 0 },
			entryTransition: "slide-up",
			id: id(2),
			sourceOut: 8,
			track: 1,
			visualEffect: "sepia",
		}),
		segmentSchema.parse({
			...segmentBase,
			assetId: id(0xa3),
			id: id(3),
			sourceOut: 8,
			track: 2,
			visualization: "waveform",
		}),
	];
	project.titles = [
		titleSchema.parse({
			animation: "slide-left",
			color: "#ffcc00",
			end: 4,
			fadeIn: 1,
			fadeOut: 0.5,
			fontSize: 0.08,
			id: id(10),
			start: 1,
			text: "Opening title",
			x: 0.5,
			y: 0.3,
		}),
	];
	project.graphics = [
		graphicSchema.parse({
			animation: "slide-up",
			end: 4,
			fill: "#ff0000",
			height: 0.2,
			id: id(20),
			opacity: 0.8,
			shape: "triangle",
			start: 1,
			strokeWidth: 0.01,
			width: 0.3,
			x: 0.1,
			y: 0.1,
		}),
		graphicSchema.parse({
			end: 4,
			fill: "#00ff00",
			height: 0.1,
			id: id(21),
			opacity: 1,
			shape: "line",
			start: 0,
			stroke: "#0000ff",
			width: 0.5,
			x: 0.2,
			y: 0.6,
		}),
	];
	project.avatars = [
		avatarSchema.parse({
			accent: "#3366ff",
			end: 4,
			height: 0.5,
			id: id(30),
			outfit: "#222222",
			skin: "#f1c27d",
			start: 1,
			width: 0.2,
			x: 0.7,
			y: 0.4,
		}),
	];
	project.spatialObjects = [
		spatialObjectSchema.parse({
			animation: "orbit-left",
			depth: 0.2,
			end: 4,
			fill: "#884400",
			height: 0.2,
			id: id(40),
			start: 1,
			width: 0.2,
			x: 0.1,
			y: -0.1,
			z: 0.3,
		}),
	];
	project.meshes = [
		meshSchema.parse({
			end: 4,
			faces: [
				[0, 1, 2],
				[0, 2, 3],
			],
			fill: "#336699",
			id: id(50),
			start: 1,
			vertices: [
				[0, 0, 0],
				[1, 0, 0.5],
				[1, 1, 0],
				[0, 1, -0.5],
			],
		}),
	];
	project.captions = [
		captionSchema.parse({
			end: 3,
			id: id(60),
			start: 1,
			text: "Hello there",
			words: [
				{ end: 1.8, id: id(61), start: 1, text: "Hello" },
				{ end: 3, id: id(62), start: 1.8, text: "there" },
			],
		}),
	];
	return project;
}
