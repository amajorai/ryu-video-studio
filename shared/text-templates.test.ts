import { describe, expect, test } from "bun:test";
import { newProject } from "./project.ts";
import {
	applyTextTemplate,
	TEXT_TEMPLATES,
	textTemplate,
	textTemplateLayers,
	textTemplateSchema,
} from "./text-templates.ts";

const counter = () => {
	let next = 0;
	return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
};

describe("text templates", () => {
	test("about twenty valid templates with unique ids across every category", () => {
		expect(TEXT_TEMPLATES.length).toBeGreaterThanOrEqual(20);
		const ids = TEXT_TEMPLATES.map((template) => template.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const template of TEXT_TEMPLATES) {
			expect(() => textTemplateSchema.parse(template)).not.toThrow();
		}
		expect(
			new Set(TEXT_TEMPLATES.map((template) => template.category)).size
		).toBe(6);
	});

	test("every template places into a valid project", () => {
		for (const template of TEXT_TEMPLATES) {
			const placed = applyTextTemplate(newProject("T"), [], template.id, {
				start: 10,
			});
			expect(placed.titles.length).toBe(template.titles.length);
			expect(placed.graphics.length).toBe(template.graphics?.length ?? 0);
			for (const title of placed.titles) {
				expect(title.templateId).toBe(template.id);
				expect(title.start).toBeGreaterThanOrEqual(10);
				expect(title.end).toBeLessThanOrEqual(10 + template.duration);
			}
		}
	});

	test("layers are deterministic, offset, and take replacement text", () => {
		const template = textTemplate("lower-third-bar");
		if (!template) {
			throw new Error("template missing");
		}
		const first = textTemplateLayers(template, {
			newId: counter(),
			start: 2,
			texts: ["Riley Chen", "  "],
		});
		const second = textTemplateLayers(template, {
			newId: counter(),
			start: 2,
			texts: ["Riley Chen", "  "],
		});
		expect(first).toEqual(second);
		expect(
			first.titles.map((title) => [title.text, title.start, title.end])
		).toEqual([
			["Riley Chen", 2.1, 7],
			["Product designer", 2.25, 7],
		]);
		expect(first.graphics[0]).toMatchObject({ end: 7, start: 2 });
	});

	test("placement near the two-hour limit moves earlier", () => {
		const placed = applyTextTemplate(newProject("T"), [], "title-bold-pop", {
			start: 7199,
		});
		expect(placed.titles[0]?.end).toBe(7200);
		expect(() =>
			applyTextTemplate(newProject("T"), [], "missing", { start: 0 })
		).toThrow("Unknown text template");
	});
});
