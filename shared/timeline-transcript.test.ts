import { expect, test } from "bun:test";
import { newProject, newSegment } from "./project.ts";
import { timelineTranscript } from "./timeline-transcript.ts";

test("timeline transcript maps source cues through trim, speed, and timeline position", () => {
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
	const segment = newSegment(asset, 10);
	segment.sourceIn = 2;
	segment.sourceOut = 6;
	segment.speed = 2;
	const project = { ...newProject("Timeline transcript"), segments: [segment] };
	const result = timelineTranscript(project, (assetId) =>
		assetId === asset.id
			? {
					assetId: asset.id,
					cues: [{ end: 4, id: crypto.randomUUID(), start: 2, text: "Hello" }],
					duration: 8,
					nextOffset: 8,
					origin: "imported" as const,
					revision: 0,
					status: "completed" as const,
					timing: "imported" as const,
					updatedAt: new Date().toISOString(),
					words: [],
				}
			: null
	);
	expect(result.clips[0]?.cues[0]).toMatchObject({ start: 10, end: 11 });
});
