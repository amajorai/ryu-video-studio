import { expect, test } from "bun:test";
import { applyColor } from "./color-edits.ts";
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
