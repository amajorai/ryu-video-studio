import { z } from "zod";

export const styleProfileSchema = z.enum([
	"clean-professional",
	"flat-motion",
	"minimalist-diagram",
	"cinematic",
]);
export type StyleProfile = z.infer<typeof styleProfileSchema>;

export interface StyleProfileConfig {
	accent: string;
	background: string;
	description: string;
	label: string;
}

const profiles: Record<StyleProfile, StyleProfileConfig> = {
	"clean-professional": {
		accent: "#2563eb",
		background: "#000000",
		description: "Neutral black canvas with crisp blue accents.",
		label: "Clean professional",
	},
	"flat-motion": {
		accent: "#f97316",
		background: "#17132b",
		description: "Deep violet canvas with warm flat-motion accents.",
		label: "Flat motion",
	},
	"minimalist-diagram": {
		accent: "#0f766e",
		background: "#f8fafc",
		description: "Light canvas for diagrams and technical explainers.",
		label: "Minimalist diagram",
	},
	cinematic: {
		accent: "#f59e0b",
		background: "#08050f",
		description: "Dark violet canvas with a restrained gold accent.",
		label: "Cinematic",
	},
};

export function styleProfileConfig(profile: StyleProfile): StyleProfileConfig {
	return profiles[profile];
}

export function styleProfileOptions(): Array<{
	value: StyleProfile;
	label: string;
}> {
	return styleProfileSchema.options.map((value) => ({
		label: profiles[value].label,
		value,
	}));
}
