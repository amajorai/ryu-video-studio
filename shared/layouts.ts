import { z } from "zod";
import type { Project } from "./project.ts";

export const layoutSchema = z.enum([
	"single",
	"side-by-side",
	"stacked",
	"grid-2x2",
	"grid-3x3",
	"grid-4x4",
	"picture-in-picture",
]);
export type Layout = z.infer<typeof layoutSchema>;

type LayoutSlot = Pick<Project["segments"][number], "scale" | "x" | "y">;

function gridSlots(size: number): readonly LayoutSlot[] {
	const scale = 1 / size;
	return Array.from({ length: size * size }, (_, index) => ({
		scale,
		x: ((index % size) + 0.5) * 2 * scale - 1,
		y: (Math.floor(index / size) + 0.5) * 2 * scale - 1,
	}));
}

const slots = (layout: Layout): readonly LayoutSlot[] => {
	switch (layout) {
		case "side-by-side":
			return [
				{ scale: 0.5, x: -0.5, y: 0 },
				{ scale: 0.5, x: 0.5, y: 0 },
			];
		case "stacked":
			return [
				{ scale: 0.5, x: 0, y: -0.5 },
				{ scale: 0.5, x: 0, y: 0.5 },
			];
		case "grid-2x2":
			return gridSlots(2);
		case "grid-3x3":
			return gridSlots(3);
		case "grid-4x4":
			return gridSlots(4);
		case "picture-in-picture":
			return [
				{ scale: 1, x: 0, y: 0 },
				{ scale: 0.35, x: 0.55, y: -0.55 },
			];
		default:
			return [{ scale: 1, x: 0, y: 0 }];
	}
};

export function layoutLabel(layout: Layout): string {
	switch (layout) {
		case "side-by-side":
			return "Side by side";
		case "picture-in-picture":
			return "Picture in picture";
		case "grid-2x2":
			return "2 × 2 grid";
		case "grid-3x3":
			return "3 × 3 grid";
		case "grid-4x4":
			return "4 × 4 grid";
		case "stacked":
			return "Stacked";
		default:
			return "Single frame";
	}
}

export function layoutRange(layout: Layout): { max: number; min: number } {
	const count = slots(layout).length;
	return ["grid-2x2", "grid-3x3", "grid-4x4"].includes(layout)
		? { max: count, min: 2 }
		: { max: count, min: count };
}

export function applyLayout(
	project: Project,
	segmentIds: readonly string[],
	layout: Layout
): Project {
	const ids = [...segmentIds];
	if (new Set(ids).size !== ids.length) {
		throw new Error("Select unique visual clips for the layout.");
	}
	const { max, min } = layoutRange(layout);
	if (ids.length < min || ids.length > max) {
		throw new Error(
			`${layoutLabel(layout)} needs ${min === max ? min : `${min}–${max}`} visual clips.`
		);
	}
	const selected = new Set(ids);
	if (
		ids.some((id) => !project.segments.some((segment) => segment.id === id))
	) {
		throw new Error("A selected layout clip is no longer on this timeline.");
	}
	const visualIds = new Set(
		project.segments
			.filter((segment) => selected.has(segment.id))
			.map((segment) => segment.id)
	);
	if (visualIds.size !== ids.length) {
		throw new Error("Select unique visual clips for the layout.");
	}
	const placement = new Map(
		ids.map((id, index) => [id, slots(layout)[index]!] as const)
	);
	return {
		...project,
		segments: project.segments.map((segment) => {
			const slot = placement.get(segment.id);
			if (!slot) {
				return segment;
			}
			return {
				...segment,
				...slot,
				keyframes: segment.keyframes.filter(
					(frame) => !["scale", "x", "y"].includes(frame.property)
				),
			};
		}),
	};
}
