import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
	type Asset,
	type Caption,
	newSegment,
} from "../../../shared/project.ts";
import { assCaptions } from "../render-ass.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	}
});

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-captions-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const call = async (path: string, body?: StudioRequestBody) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: body === undefined ? "GET" : "POST",
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

function wordCaption(texts: string[]): Caption {
	const words = texts.map((text, index) => ({
		end: index * 0.5 + 0.4,
		id: crypto.randomUUID(),
		start: index * 0.5,
		text,
	}));
	return {
		end: texts.length * 0.5,
		id: crypto.randomUUID(),
		start: 0,
		text: texts.join(" "),
		words,
	};
}

const MALFORMED_SRT = `1
00:00:00,500 --> 00:00:02,000
Good one

2
00:00:03,000 --> 00:00:01,000
Backwards

3
00:00:aa,000 --> 00:00:05,000
Broken stamp

4
00:00:05,000 --> 00:00:06,500
Good two
`;

test("caption-style saves a revisioned style and renders it", async () => {
	const { call, store } = await studio();
	const project = store.save({
		...store.create("Styled"),
		captions: [wordCaption(["hello", "there"])],
	});
	const stale = await call(`/projects/${project.id}/caption-style`, {
		revision: project.revision + 1,
		style: { color: "#ff0000" },
	});
	expect(stale.status).toBe(409);
	const styled = await call(`/projects/${project.id}/caption-style`, {
		revision: project.revision,
		style: { positionY: 0.5, uppercase: true, wordAnimation: "pop" },
	});
	expect(styled.status).toBe(200);
	const saved = store.project(project.id);
	expect(saved.captionStyle).toEqual({
		positionY: 0.5,
		uppercase: true,
		wordAnimation: "pop",
	});
	const script = assCaptions(saved);
	expect(script).toContain("Style: Caption,");
	expect(script).toContain("\\pos(960,540)");
	expect(script).toContain("HELLO");
	const invalid = await call(`/projects/${project.id}/caption-style`, {
		revision: saved.revision,
		style: { fontSize: 3 },
	});
	expect(invalid.status).toBe(400);
});

test("caption-rechunk regroups words and stores the chunking", async () => {
	const { call, store } = await studio();
	const project = store.save({
		...store.create("Chunks"),
		captions: [wordCaption(["one", "damn", "three", "four"])],
	});
	const result = await call(`/projects/${project.id}/caption-rechunk`, {
		chunking: { maxWords: 2, mode: "words", profanity: "mask" },
		revision: project.revision,
	});
	expect(result.status).toBe(200);
	const saved = store.project(project.id);
	expect(saved.captions.map((caption) => caption.text)).toEqual([
		"one d***",
		"three four",
	]);
	expect(saved.captionChunking).toEqual({
		maxWords: 2,
		mode: "words",
		profanity: "mask",
	});
});

test("caption-import reports skipped cues in lenient mode", async () => {
	const { call, store } = await studio();
	const project = store.save(store.create("Import"));
	const strict = await call(`/projects/${project.id}/caption-import`, {
		format: "srt",
		revision: project.revision,
		text: MALFORMED_SRT,
	});
	expect(strict.status).toBe(400);
	const lenient = await call(`/projects/${project.id}/caption-import`, {
		format: "srt",
		lenient: true,
		revision: project.revision,
		text: MALFORMED_SRT,
	});
	expect(lenient.status).toBe(200);
	expect(lenient.body.imported).toBe(2);
	expect(lenient.body.skipped).toHaveLength(2);
	expect(
		lenient.body.skipped.map((item: { line: number }) => item.line)
	).toEqual([6, 10]);
	expect(
		store.project(project.id).captions.map((caption) => caption.text)
	).toEqual(["Good one", "Good two"]);
	const ass = await call(`/projects/${project.id}/caption-import`, {
		format: "ass",
		mode: "append",
		revision: store.project(project.id).revision,
		text: "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,{\\b1}Bold{\\b0}\\Nnext\n",
	});
	expect(ass.status).toBe(200);
	expect(store.project(project.id).captions.at(-1)?.text).toBe("Bold\nnext");
});

test("the registry publishes the caption operations", () => {
	const paths = Object.keys(openapi().paths);
	for (const action of ["caption-style", "caption-rechunk", "caption-import"]) {
		expect(paths).toContain(`/api/video-studio/projects/{id}/${action}`);
	}
});

test("transcript POST accepts a language hint and rejects malformed tags", async () => {
	const { call, store } = await studio();
	const asset: Asset = {
		createdAt: new Date().toISOString(),
		duration: 4,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Voice",
		width: 0,
	};
	store.putAsset(asset);
	const bad = await call(`/assets/${asset.id}/transcript`, {
		language: "not a tag!",
	});
	expect(bad.status).toBe(400);
	const begun = await call(`/assets/${asset.id}/transcript`, {
		language: "pt-BR",
	});
	expect(begun.status).toBe(200);
	expect(begun.body.status).toBe("running");
	expect(begun.body.language).toBe("pt-BR");
	expect(store.transcript(asset.id)?.language).toBe("pt-BR");
	const auto = await call(`/assets/${asset.id}/transcript`, {
		language: "auto",
	});
	expect(auto.status).toBe(200);
});

test("resuming saved windows keeps one transcript language", async () => {
	const { call, store } = await studio();
	const asset: Asset = {
		createdAt: new Date().toISOString(),
		duration: 40,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: "Interview",
		width: 0,
	};
	store.putAsset(asset);
	const begun = await call(`/assets/${asset.id}/transcript`, {
		language: "fr",
	});
	expect(begun.status).toBe(200);
	const saved = store.appendTranscript(asset.id, begun.body.revision, 0, []);
	store.stopTranscript(asset.id, saved.revision, "canceled");
	const switched = await call(`/assets/${asset.id}/transcript`, {
		language: "en",
	});
	expect(switched.status).toBe(409);
	expect(store.transcript(asset.id)?.language).toBe("fr");
	expect(store.transcript(asset.id)?.status).toBe("canceled");
	const resumed = await call(`/assets/${asset.id}/transcript`, {
		language: "fr",
	});
	expect(resumed.status).toBe(200);
	expect(resumed.body.status).toBe("running");
	expect(resumed.body.language).toBe("fr");
});

test("captions/rechunk and captions/import alias the caption routes", async () => {
	const { call, store } = await studio();
	const project = store.save({
		...store.create("Aliases"),
		captions: [wordCaption(["one", "two", "three", "four"])],
	});
	const rechunked = await call(`/projects/${project.id}/captions/rechunk`, {
		chunking: { maxWords: 2, mode: "words" },
		revision: project.revision,
	});
	expect(rechunked.status).toBe(200);
	expect(
		store.project(project.id).captions.map((caption) => caption.text)
	).toEqual(["one two", "three four"]);
	const imported = await call(`/projects/${project.id}/captions/import`, {
		format: "srt",
		revision: store.project(project.id).revision,
		text: "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
	});
	expect(imported.status).toBe(200);
	expect(imported.body.imported).toBe(1);
	expect(
		store.project(project.id).captions.map((caption) => caption.text)
	).toEqual(["Hello"]);
	// The built-in caption edit still answers the bare path only.
	const unknown = await call(`/projects/${project.id}/captions/style`, {
		revision: store.project(project.id).revision,
	});
	expect(unknown.status).toBe(404);
	const paths = Object.keys(openapi().paths);
	expect(paths).toContain("/api/video-studio/projects/{id}/captions/rechunk");
	expect(paths).toContain("/api/video-studio/projects/{id}/captions/import");
});

test("caption-glossary saves pairs and fixes captions, tracks and transcripts", async () => {
	const { call, store } = await studio();
	const asset: Asset = {
		createdAt: new Date().toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "talk.mp4",
		width: 640,
	};
	store.putAsset(asset);
	store.importTranscript(asset, null, [
		{ end: 2, id: crypto.randomUUID(), start: 0, text: "welcome to rye you" },
	]);
	const created = store.create("Glossary");
	const project = store.save({
		...created,
		captions: [wordCaption(["Welcome", "to", "rye", "you."])],
		captionTracks: [
			{
				captions: [wordCaption(["rye", "you", "en", "français"])],
				id: crypto.randomUUID(),
				label: "French",
				language: "fr",
			},
		],
		segments: [newSegment(asset)],
	});
	const saveOnly = await call(`/projects/${project.id}/caption-glossary`, {
		apply: false,
		glossary: [{ from: "rye you", to: "Ryu" }],
		revision: project.revision,
	});
	expect(saveOnly.status).toBe(200);
	expect(saveOnly.body.replacements).toBe(0);
	expect(saveOnly.body.project.captionGlossary).toEqual([
		{ from: "rye you", to: "Ryu" },
	]);
	expect(saveOnly.body.project.captions[0].text).toBe("Welcome to rye you.");

	const applied = await call(`/projects/${project.id}/caption-glossary`, {
		allTracks: true,
		revision: saveOnly.body.project.revision,
	});
	expect(applied.status).toBe(200);
	expect(applied.body.replacements).toBe(2);
	expect(applied.body.project.captions[0].text).toBe("Welcome to Ryu.");
	expect(
		applied.body.project.captions[0].words.map(
			(word: { text: string }) => word.text
		)
	).toEqual(["Welcome", "to", "Ryu."]);
	expect(applied.body.project.captionTracks[0].captions[0].text).toBe(
		"Ryu en français"
	);
	expect(applied.body.transcripts).toEqual([asset.id]);
	expect(store.transcript(asset.id)?.cues[0]?.text).toBe("welcome to Ryu");

	const stale = await call(`/projects/${project.id}/caption-glossary`, {
		revision: project.revision,
	});
	expect(stale.status).toBe(409);
});
