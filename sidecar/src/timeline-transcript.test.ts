import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	projectDuration,
	projectSchema,
} from "../../shared/project.ts";
import {
	selectionRanges,
	timelineTokens,
	timelineTranscriptSchema,
} from "../../shared/timeline-transcript.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "ryu-video-timeline-transcript-"));
	const store = new StudioStore(dir);
	cleanup.push(async () => {
		store.close();
		await rm(dir, { force: true, recursive: true });
	});
	return store;
}

const speech: Asset = {
	createdAt: new Date().toISOString(),
	duration: 6,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Interview",
	width: 640,
};

const WORDS: [number, number, string][] = [
	[0.2, 0.6, "Keep"],
	[0.8, 1.2, "these"],
	[1.5, 2.1, "really"],
	[2.2, 2.9, "unnecessary"],
	[3.4, 3.8, "words"],
	[4, 4.6, "please."],
];

test("deleting two transcript words shortens the timeline by their duration", async () => {
	const store = await setup();
	store.putAsset(speech);
	const running = store.beginTranscript(speech);
	store.appendTranscript(
		speech.id,
		running.revision,
		0,
		[{ end: 4.6, id: crypto.randomUUID(), start: 0.2, text: "Keep these…" }],
		"segments",
		WORDS.map(([start, end, text]) => ({
			end,
			id: crypto.randomUUID(),
			start,
			text,
		}))
	);
	// The clip starts 1 s into the source and 2 s into the timeline.
	const clip = { ...newSegment(speech, 2), sourceIn: 1 };
	const project = store.save({
		...store.create("Timeline transcript delete"),
		segments: [clip],
	});
	const before = projectDuration(project);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	try {
		const transcript = timelineTranscriptSchema.parse(
			await (await fetch(`${base}/transcript`, { headers })).json()
		);
		const tokens = timelineTokens(transcript);
		// "really unnecessary": source 1.5-2.9 is timeline 2.5-3.9.
		const selected = tokens.filter((word) =>
			["really", "unnecessary"].includes(word.norm)
		);
		expect(selected.map((word) => [word.start, word.end])).toEqual([
			[2.5, 3.1],
			[3.2, 3.9],
		]);
		const ranges = selectionRanges(
			tokens,
			[{ first: selected[0]?.index ?? -1, last: selected[1]?.index ?? -1 }],
			before
		);
		expect(ranges).toEqual([{ end: 3.9, start: 2.5 }]);
		const response = await fetch(`${base}/remove-words`, {
			body: JSON.stringify({ ranges, revision: transcript.revision }),
			headers,
			method: "POST",
		});
		expect(response.status).toBe(200);
		const after = projectSchema.parse(await response.json());
		expect(projectDuration(after)).toBeCloseTo(before - 1.4, 6);
		const remaining = timelineTokens(
			timelineTranscriptSchema.parse(
				await (await fetch(`${base}/transcript`, { headers })).json()
			)
		).map((word) => word.norm);
		expect(remaining).toEqual(["these", "words", "please"]);
	} finally {
		app.stop();
	}
});
