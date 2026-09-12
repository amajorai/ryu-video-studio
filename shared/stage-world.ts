import { z } from "zod";
import type { SpatialObject, StageCamera } from "./project.ts";
import type { StageCameraKeyframe } from "./stage-camera.ts";

export const stageWorldPromptSchema = z.string().trim().min(1).max(400);
export const stageWorldRequestSchema = z
	.object({
		prompt: stageWorldPromptSchema,
		revision: z.number().int().nonnegative(),
		startTime: z.number().finite().min(0).max(7188).optional(),
	})
	.strict();

export interface GeneratedStageWorld {
	camera: StageCamera;
	objects: SpatialObject[];
	prompt: string;
}

const palettes = [
	{
		accent: "#fbbf24",
		ground: "#365314",
		mountain: "#475569",
		water: "#0ea5e9",
		wood: "#92400e",
	},
	{
		accent: "#fb7185",
		ground: "#3f6212",
		mountain: "#334155",
		water: "#06b6d4",
		wood: "#9a3412",
	},
	{
		accent: "#c4b5fd",
		ground: "#14532d",
		mountain: "#1e3a5f",
		water: "#38bdf8",
		wood: "#78350f",
	},
] as const;

type Palette = (typeof palettes)[number];

function seedFor(prompt: string): number {
	let hash = 2_166_136_261;
	for (const character of prompt) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619);
	}
	return hash >>> 0;
}

function block(
	start: number,
	end: number,
	input: Omit<SpatialObject, "end" | "id" | "start">
): SpatialObject {
	return {
		...input,
		end,
		id: crypto.randomUUID(),
		start,
	};
}

function keyframe(
	property: StageCameraKeyframe["property"],
	time: number,
	value: number
): StageCameraKeyframe {
	return { id: crypto.randomUUID(), property, time, value };
}

export function generateStageWorld(
	input: unknown,
	startTime = 0
): GeneratedStageWorld {
	const prompt = stageWorldPromptSchema.parse(input);
	const start = Math.max(0, Math.min(7188, startTime));
	const middle = Number((start + 6).toFixed(3));
	const end = Number((start + 12).toFixed(3));
	const palette: Palette = palettes[seedFor(prompt) % palettes.length]!;
	const objects = [
		block(start, end, {
			animation: "none",
			depth: 0.9,
			entryDuration: 0.5,
			fill: palette.ground,
			height: 0.24,
			width: 1,
			x: 0,
			y: 0.52,
			z: 0.35,
		}),
		block(start, end, {
			animation: "float",
			depth: 0.22,
			entryDuration: 0.7,
			fill: palette.water,
			height: 0.09,
			width: 0.58,
			x: -0.3,
			y: 0.25,
			z: 0.12,
		}),
		block(start, end, {
			animation: "orbit-left",
			depth: 0.52,
			entryDuration: 0.8,
			fill: palette.mountain,
			height: 0.62,
			width: 0.42,
			x: -0.48,
			y: -0.18,
			z: 0.58,
		}),
		block(start, end, {
			animation: "orbit-right",
			depth: 0.58,
			entryDuration: 0.9,
			fill: palette.mountain,
			height: 0.74,
			width: 0.5,
			x: 0.38,
			y: -0.14,
			z: 0.64,
		}),
		block(start, end, {
			animation: "none",
			depth: 0.2,
			entryDuration: 0.6,
			fill: palette.wood,
			height: 0.2,
			width: 0.17,
			x: -0.1,
			y: 0.18,
			z: 0.28,
		}),
		block(start, end, {
			animation: "float",
			depth: 0.18,
			entryDuration: 0.65,
			fill: palette.accent,
			height: 0.17,
			width: 0.15,
			x: 0.16,
			y: 0.16,
			z: 0.31,
		}),
		block(start, end, {
			animation: "none",
			depth: 0.2,
			entryDuration: 0.75,
			fill: palette.wood,
			height: 0.38,
			width: 0.1,
			x: 0.56,
			y: 0.04,
			z: 0.42,
		}),
		block(start, end, {
			animation: "orbit-left",
			depth: 0.12,
			entryDuration: 0.5,
			fill: palette.accent,
			height: 0.1,
			width: 0.18,
			x: 0.56,
			y: -0.22,
			z: 0.5,
		}),
	];
	const camera: StageCamera = {
		x: -0.2,
		y: 0.04,
		zoom: 0.84,
		orbit: -0.35,
		tilt: 0.12,
		keyframes: [
			keyframe("x", start, -0.24),
			keyframe("x", middle, 0.02),
			keyframe("x", end, 0.22),
			keyframe("y", start, 0.06),
			keyframe("y", middle, -0.02),
			keyframe("y", end, 0.04),
			keyframe("zoom", start, 0.84),
			keyframe("zoom", middle, 1.02),
			keyframe("zoom", end, 0.9),
			keyframe("orbit", start, -0.42),
			keyframe("orbit", middle, 0.02),
			keyframe("orbit", end, 0.4),
			keyframe("tilt", start, 0.14),
			keyframe("tilt", middle, -0.04),
			keyframe("tilt", end, 0.1),
		],
	};
	return { camera, objects, prompt };
}
