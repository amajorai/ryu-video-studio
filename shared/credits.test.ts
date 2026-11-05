import { describe, expect, test } from "bun:test";
import { creditsForProject, creditsMarkdown } from "./credits.ts";
import { newProject, newSegment } from "./project.ts";

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

describe("generated media credits", () => {
	test("records provider, model, task and consent of generated media in use", () => {
		const project = newProject("Generated proof");
		const used = crypto.randomUUID();
		const unused = crypto.randomUUID();
		const generated = (id: string) => ({
			createdAt: new Date().toISOString(),
			duration: 4,
			generation: {
				consent: "subjects-agreed" as const,
				kind: "video" as const,
				model: "fal-ai/sync-lipsync",
				prompt: "Lip-sync",
				provider: "fal",
				task: "lipsync" as const,
			},
			hasAudio: true,
			height: 720,
			id,
			kind: "video" as const,
			name: "Lip-sync take",
			width: 1280,
		});
		project.segments = [newSegment(generated(used))];
		const credits = creditsForProject(project, [
			generated(used),
			generated(unused),
		]);
		expect(credits.generated).toEqual([
			{
				assetId: used,
				assetName: "Lip-sync take",
				consent: "subjects-agreed",
				kind: "video",
				model: "fal-ai/sync-lipsync",
				provider: "fal",
				task: "lipsync",
			},
		]);
		const text = creditsMarkdown(credits);
		expect(text).toContain("## Generated media");
		expect(text).toContain("Provider: fal; model: fal-ai/sync-lipsync");
		expect(text).toContain("Consent:");
	});

	test("omits the generated list when no generated media is used", () => {
		const credits = creditsForProject(newProject("Plain"), []);
		expect(credits.generated).toBeUndefined();
		expect(creditsMarkdown(credits)).not.toContain("Generated media");
	});
});
