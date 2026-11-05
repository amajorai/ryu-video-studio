import { describe, expect, test } from "bun:test";
import { buildRender } from "../sidecar/src/render.ts";
import { newProject, projectSchema } from "./project.ts";
import {
	styleProfileConfig,
	styleProfileOptions,
	styleProfileSchema,
} from "./styles.ts";

describe("visual style profiles", () => {
	test("expose bounded playbooks with deterministic canvas colors", () => {
		const options = styleProfileOptions();
		expect(options).toHaveLength(styleProfileSchema.options.length);
		for (const option of options) {
			const config = styleProfileConfig(option.value);
			expect(config.label).toBe(option.label);
			expect(config.background).toMatch(/^#[0-9a-f]{6}$/i);
			expect(config.accent).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	test("style profile survives project parsing and changes the render canvas", () => {
		const project = newProject("Style profile");
		const migrated = projectSchema.parse({
			...project,
			styleProfile: undefined,
		});
		const parsed = newProject("Style profile");
		parsed.styleProfile = "minimalist-diagram";
		parsed.graphics = [
			{
				animation: "none",
				end: 1,
				entryDuration: 0,
				fill: "#0f766e",
				height: 0.2,
				id: crypto.randomUUID(),
				opacity: 1,
				shape: "rectangle",
				start: 0,
				stroke: "#ffffff",
				strokeWidth: 0,
				width: 0.2,
				x: 0.1,
				y: 0.1,
			},
		];
		const render = buildRender(parsed, [], () => "/tmp/missing.mp4").join(" ");
		expect(render).toContain("color=c=#f8fafc");
		expect(migrated.styleProfile).toBe("clean-professional");
	});
});
