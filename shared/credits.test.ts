import { describe, expect, test } from "bun:test";
import { creditsForProject, creditsMarkdown } from "./credits.ts";
import { newProject } from "./project.ts";

describe("project credits", () => {
	test("reports only attributed media used by the project", () => {
		const project = newProject("Credits proof");
		const usedId = crypto.randomUUID();
		const unusedId = crypto.randomUUID();
		project.segments = [
			{
				id: crypto.randomUUID(),
				assetId: usedId,
				track: 0,
				start: 0,
				sourceIn: 0,
				sourceOut: 2,
				speed: 1,
				volume: 1,
				opacity: 1,
				scale: 1,
				x: 0,
				y: 0,
				crop: { bottom: 0, left: 0, right: 0, top: 0 },
				edgeRounding: 0,
				edgeSoftness: 0,
				colorGrade: { exposure: 0, temperature: 0, tint: 0, vibrance: 0 },
				effects: [],
				brightness: 0,
				contrast: 1,
				saturation: 1,
				rotation: 0,
				fadeIn: 0,
				fadeOut: 0,
				keyframes: [],
				visualization: "none",
				entryTransition: "none",
				entryDuration: 0.5,
				entryOffset: 0,
				waveformHeight: 0.2,
				waveformColor: "#ffffff",
				duckUnderVoice: false,
			},
		];
		const assets = [
			{
				id: usedId,
				name: "Open footage",
				kind: "video" as const,
				duration: 2,
				width: 640,
				height: 360,
				hasAudio: false,
				createdAt: new Date().toISOString(),
				origin: {
					attribution: "Artist",
					identifier: "File:Open.webm",
					pageUrl: "https://commons.wikimedia.org/wiki/File:Open.webm",
					provider: "wikimedia.commons" as const,
					rights: "CC BY 4.0",
				},
			},
			{
				id: unusedId,
				name: "Private clip",
				kind: "video" as const,
				duration: 2,
				width: 640,
				height: 360,
				hasAudio: false,
				createdAt: new Date().toISOString(),
			},
		];
		const credits = creditsForProject(project, assets);
		expect(credits.entries).toHaveLength(1);
		expect(credits.entries[0]?.provider).toBe("wikimedia.commons");
		expect(creditsMarkdown(credits)).toContain("CC BY 4.0");
	});
});
