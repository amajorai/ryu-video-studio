import { expect, test } from "bun:test";
import { applyEffects } from "./effect-edits.ts";
import { newProject, newSegment } from "./project.ts";

test("effect edits replace a bounded visual effect stack", () => {
	const asset = {
		createdAt: new Date().toISOString(),
		duration: 4,
		hasAudio: false,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Source",
		width: 640,
	};
	const segment = newSegment(asset);
	const project = { ...newProject("Effects"), segments: [segment] };
	const next = applyEffects(project, [asset], {
		clipIds: [segment.id],
		effects: [{ amount: 0.75, enabled: true, type: "sharpen" }],
		revision: project.revision,
	});
	expect(next.segments[0]?.effects).toEqual([
		{ amount: 0.75, enabled: true, type: "sharpen" },
	]);
});
