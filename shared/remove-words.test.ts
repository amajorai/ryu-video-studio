import { expect, test } from "bun:test";
import { newProject, newSegment } from "./project.ts";
import { removeWordRanges } from "./remove-words.ts";

test("remove word ranges merges overlaps and ripples later media", () => {
	const asset = {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Speech",
		width: 640,
	};
	const first = newSegment(asset, 0);
	first.sourceOut = 6;
	const later = newSegment(asset, 6);
	later.sourceIn = 6;
	later.sourceOut = 8;
	const project = { ...newProject("Remove words"), segments: [first, later] };
	const next = removeWordRanges(project, [asset], {
		ranges: [
			{ end: 3, start: 1 },
			{ end: 4, start: 2.5 },
		],
		revision: project.revision,
	});
	expect(next.segments.map((segment) => segment.start)).toEqual([0, 1, 3]);
	expect(next.segments.map((segment) => segment.sourceOut)).toEqual([1, 6, 8]);
});
