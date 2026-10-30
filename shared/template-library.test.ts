import { describe, expect, test } from "bun:test";
import {
	type Asset,
	idSchema,
	segmentDuration,
	validateProject,
} from "./project.ts";
import { soundtrackBarSeconds } from "./soundtrack.ts";
import {
	BUILT_IN_TEMPLATES,
	builtInTemplate,
	builtInTemplateDuration,
	builtInTemplateProject,
	builtInTemplateSummary,
	sequentialIds,
	TEMPLATE_MUSIC_TRACK,
} from "./template-library.ts";
import { fillTemplate } from "./templates.ts";

const createdAt = new Date(0).toISOString();

function media(kind: Asset["kind"], duration: number): Asset {
	return {
		createdAt,
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 1080,
		id: crypto.randomUUID(),
		kind,
		name: kind,
		width: kind === "audio" ? 0 : 1920,
	};
}

const placeholder: Asset = { ...media("image", 5), derivation: "matte" };

describe("BUILT_IN_TEMPLATES", () => {
	test("ships eight templates with unique UUID ids and titles", () => {
		expect(BUILT_IN_TEMPLATES).toHaveLength(8);
		const ids = BUILT_IN_TEMPLATES.map((template) => template.id);
		expect(new Set(ids).size).toBe(8);
		for (const id of ids) {
			expect(idSchema.safeParse(id).success).toBe(true);
		}
		expect(BUILT_IN_TEMPLATES.map((template) => template.title)).toEqual([
			"Vlog intro",
			"Product promo",
			"Recap montage",
			"Quote card",
			"Podcast clip",
			"Slideshow",
			"Event highlight",
			"Tutorial step",
		]);
		expect(builtInTemplate(ids[3] ?? "")?.title).toBe("Quote card");
		expect(builtInTemplate(crypto.randomUUID())).toBeUndefined();
	});

	for (const template of BUILT_IN_TEMPLATES) {
		describe(template.title, () => {
			const duration = builtInTemplateDuration(template);
			const music = media("audio", duration);
			const project = builtInTemplateProject(template, {
				music,
				placeholder,
			});

			test("is a valid project with a music slot", () => {
				expect(() =>
					validateProject(project, [placeholder, music])
				).not.toThrow();
				expect(project.id).toBe(template.id);
				const slots = project.template?.slots ?? [];
				expect(slots).toHaveLength(template.slots.length + 1);
				expect(slots.at(-1)?.kind).toBe("audio");
				const bed = project.segments.find(
					(segment) => segment.assetId === music.id
				);
				expect(bed?.track).toBe(TEMPLATE_MUSIC_TRACK);
				expect(segmentDuration(bed ?? project.segments[0]!)).toBeCloseTo(
					duration
				);
			});

			test("cuts every slot on a bar of the music tempo", () => {
				const bar = soundtrackBarSeconds(template.music.bpm);
				for (const slot of project.template?.slots ?? []) {
					const segment = project.segments.find(
						(item) => item.id === slot.segmentId
					);
					const bars = (segment?.start ?? 0) / bar;
					expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
				}
			});

			test("fills with fewer and with more media than slots", () => {
				const visual = template.slots.length;
				const few = [media("video", 60)];
				const fewResult = fillTemplate(
					project,
					[placeholder, music, ...few],
					few.map((item) => item.id)
				);
				expect(fewResult.unfilledSlotIds).toHaveLength(visual);
				expect(() =>
					validateProject(fewResult.project, [placeholder, music, ...few])
				).not.toThrow();
				const many = Array.from({ length: visual + 2 }, () =>
					media("image", 5)
				);
				const manyResult = fillTemplate(
					project,
					[placeholder, music, ...many],
					many.map((item) => item.id)
				);
				expect(manyResult.unusedAssetIds).toHaveLength(2);
				// Only the music slot is left: images never fill audio slots.
				expect(manyResult.unfilledSlotIds).toHaveLength(1);
				expect(() =>
					validateProject(manyResult.project, [placeholder, music, ...many])
				).not.toThrow();
				expect(
					manyResult.project.segments.some(
						(segment) => segment.assetId === placeholder.id
					)
				).toBe(false);
			});
		});
	}
});

describe("builtInTemplateProject", () => {
	test("without music has no audio slot", () => {
		const template = BUILT_IN_TEMPLATES[0];
		if (!template) {
			throw new Error("Missing template.");
		}
		const project = builtInTemplateProject(template, { placeholder });
		expect(project.template?.slots.some((slot) => slot.kind === "audio")).toBe(
			false
		);
		expect(() => validateProject(project, [placeholder])).not.toThrow();
	});

	test("trims a music asset shorter than the template", () => {
		const template = BUILT_IN_TEMPLATES[1];
		if (!template) {
			throw new Error("Missing template.");
		}
		const music = media("audio", 3);
		const project = builtInTemplateProject(template, { music, placeholder });
		const bed = project.segments.find(
			(segment) => segment.assetId === music.id
		);
		expect(bed?.sourceOut).toBe(3);
		expect(() => validateProject(project, [placeholder, music])).not.toThrow();
	});
});

describe("builtInTemplateSummary", () => {
	test("is deterministic and lists the slots", () => {
		for (const template of BUILT_IN_TEMPLATES) {
			const summary = builtInTemplateSummary(template);
			expect(builtInTemplateSummary(template)).toEqual(summary);
			expect(summary.builtIn).toBe(true);
			expect(summary.id).toBe(template.id);
			expect(summary.duration).toBeCloseTo(builtInTemplateDuration(template));
			expect(summary.slots.map((slot) => slot.label)).toEqual([
				...template.slots.map((slot) => slot.label),
				"Music",
			]);
		}
	});
});

describe("sequentialIds", () => {
	test("produces distinct UUID-shaped ids per seed", () => {
		const a = sequentialIds("a");
		const b = sequentialIds("b");
		const first = a();
		expect(idSchema.safeParse(first).success).toBe(true);
		expect(a()).not.toBe(first);
		expect(b()).not.toBe(first);
		expect(sequentialIds("a")()).toBe(first);
	});
});
