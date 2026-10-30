import { z } from "zod";
import {
	type Layout,
	layoutLabel,
	layoutRange,
	layoutSchema,
	layoutSupported,
} from "../../shared/layouts.ts";
import type {
	MulticamChangeEntry,
	MulticamExpansion,
} from "../../shared/multicam.ts";
import type { MulticamGroup } from "../../shared/project.ts";

/** Layouts a multicam switch can show (more than one angle at once). */
export const MULTICAM_LAYOUTS = layoutSchema.options.filter(
	(layout) => layout !== "single" && layoutSupported(layout)
);

export const switchKindSchema = z.enum(["angle", "mic", "layout"]);
export type SwitchKind = z.infer<typeof switchKindSchema>;
export const fitSchema = z.enum(["fit", "fill"]);

/** Human summary of the program ranges, one line per picture range. */
export function programSummary(expansion: MulticamExpansion): string[] {
	return expansion.video.map((range) => {
		const mic = expansion.audio.find(
			(audio) => audio.start <= range.start && range.start < audio.end
		)?.mic;
		const picture = range.layout
			? `${layoutLabel(range.layout.layout)}: ${range.angles.join(", ")}`
			: range.angles[0];
		return `${range.start.toFixed(2)}–${range.end.toFixed(2)}s · ${picture}${mic ? ` · mic ${mic}` : ""}`;
	});
}

/** The switch entry the switcher form describes, or null when incomplete. */
export function switcherEntry(input: {
	angle: string;
	end: number;
	fit: "fit" | "fill";
	kind: SwitchKind;
	layout: Layout;
	layoutAngles: string[];
	mic: string;
	start: number;
}): MulticamChangeEntry | null {
	if (!(input.end > input.start)) {
		return null;
	}
	const range = { end: input.end, start: input.start };
	if (input.kind === "angle") {
		return input.angle ? { ...range, angle: input.angle } : null;
	}
	if (input.kind === "mic") {
		return input.mic ? { ...range, audio: input.mic } : null;
	}
	const { max, min } = layoutRange(input.layout);
	return input.layoutAngles.length >= min && input.layoutAngles.length <= max
		? {
				...range,
				layout: {
					angles: input.layoutAngles,
					fit: input.fit,
					layout: input.layout,
				},
			}
		: null;
}

export const angleLabels = (group: MulticamGroup | undefined) =>
	(group?.members ?? [])
		.filter((member) => member.kind !== "mic")
		.map((member) => member.label);
export const micLabels = (group: MulticamGroup | undefined) =>
	(group?.members ?? [])
		.filter((member) => member.kind !== "angle")
		.map((member) => member.label);
