import { expect, test } from "bun:test";
import { newProject } from "./project.ts";
import { updateProjectSettings } from "./settings.ts";

test("settings accepts aspect-ratio presets and preserves the current short edge", () => {
	const project = newProject("Portrait");
	const changed = updateProjectSettings(project, [], {
		aspectRatio: "9:16",
		revision: project.revision,
	});
	expect(changed).toMatchObject({ height: 1920, width: 1080 });
});

test("settings quality presets preserve the selected ratio", () => {
	const project = newProject("Quality");
	const changed = updateProjectSettings(project, [], {
		exportCodec: "prores",
		quality: "4K",
		revision: project.revision,
	});
	expect(changed).toMatchObject({
		exportCodec: "prores",
		height: 2160,
		width: 3840,
	});
});

test("settings rejects mixed explicit dimensions and ratio/quality", () => {
	const project = newProject("Invalid settings");
	expect(() =>
		updateProjectSettings(project, [], {
			aspectRatio: "1:1",
			height: 720,
			revision: project.revision,
			width: 720,
		})
	).toThrow();
});

test("settings updates the visual style profile with revision validation", () => {
	const project = newProject("Style settings");
	const next = updateProjectSettings(project, [], {
		revision: project.revision,
		styleProfile: "cinematic",
	});
	expect(next.styleProfile).toBe("cinematic");
});
