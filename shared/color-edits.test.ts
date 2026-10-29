import { expect, test } from "bun:test";
import { applyColor, applyLook } from "./color-edits.ts";
import { newProject, newSegment } from "./project.ts";

const asset = (name: string) => ({
	createdAt: new Date().toISOString(),
	duration: 4,
	hasAudio: false,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video" as const,
	name,
	width: 640,
});

test("color edits apply patches, copy grades, and reset grades", () => {
	const first = asset("First");
	const second = asset("Second");
	const one = newSegment(first);
	const two = newSegment(second, 4);
	const project = { ...newProject("Color"), segments: [one, two] };
	const patched = applyColor(project, [first, second], {
		clipIds: [one.id],
		patch: { exposure: 1, vibrance: 0.4 },
		revision: project.revision,
	});
	const copied = applyColor(patched, [first, second], {
		clipIds: [two.id],
		revision: patched.revision,
		sourceClipId: one.id,
	});
	expect(copied.segments[1]?.colorGrade).toEqual(
		copied.segments[0]?.colorGrade
	);
	const reset = applyColor(copied, [first, second], {
		clipIds: [one.id, two.id],
		reset: true,
		revision: copied.revision,
	});
	expect(
		reset.segments.every((segment) => segment.colorGrade.exposure === 0)
	).toBe(true);
});

test("color edits apply a named look and refuse mixed requests", () => {
	const first = asset("First");
	const one = newSegment(first);
	const lut = { intensity: 1, lutId: "00000000-0000-4000-8000-0000000000aa" };
	one.colorGrade = { ...one.colorGrade, lut };
	const project = { ...newProject("Looks"), segments: [one] };
	const looked = applyColor(project, [first], {
		clipIds: [one.id],
		look: { id: "golden-hour", intensity: 0.5 },
		revision: project.revision,
	});
	const grade = looked.segments[0]?.colorGrade;
	expect(grade?.look).toBe("golden-hour");
	expect(grade?.temperature).toBe(0.2);
	expect(grade?.lut).toEqual(lut);
	const viaHelper = applyLook(project, [first], [one.id], "golden-hour", 0.5);
	expect(viaHelper.segments[0]?.colorGrade).toEqual(grade);
	expect(() =>
		applyColor(project, [first], {
			clipIds: [one.id],
			look: { id: "noir" },
			patch: { exposure: 1 },
			revision: project.revision,
		})
	).toThrow();
	expect(() =>
		applyColor(project, [first], {
			clipIds: [one.id],
			look: { id: "not-a-look" as never },
			revision: project.revision,
		})
	).toThrow();
});

test("color patches accept advanced controls", () => {
	const first = asset("First");
	const one = newSegment(first);
	const project = { ...newProject("Advanced"), segments: [one] };
	const patched = applyColor(project, [first], {
		clipIds: [one.id],
		patch: {
			curves: {
				master: [
					{ x: 0, y: 1 },
					{ x: 1, y: 0 },
				],
			},
			lift: { b: 0.1, g: 0, master: 0, r: 0 },
		},
		revision: project.revision,
	});
	expect(patched.segments[0]?.colorGrade.lift?.b).toBe(0.1);
	expect(() =>
		applyColor(project, [first], {
			clipIds: [one.id],
			patch: {
				curves: {
					master: [
						{ x: 0.5, y: 1 },
						{ x: 0.5, y: 0 },
					],
				},
			},
			revision: project.revision,
		})
	).toThrow();
});
