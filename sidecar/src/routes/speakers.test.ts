import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
	type Asset,
	type Caption,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
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
		await rm(store.directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-speakers-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const call = async (path: string, body: StudioRequestBody) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

/** Register an `aevalsrc` WAV fixture as an audio asset. */
async function toneAsset(
	store: StudioStore,
	name: string,
	expression: string,
	seconds: number
): Promise<Asset> {
	const file = join(store.directory, `${crypto.randomUUID()}.wav`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=${expression}:s=48000:d=${seconds}`,
		"-c:a",
		"pcm_s16le",
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

function wordCaption(count: number): Caption {
	const words = Array.from({ length: count }, (_, index) => ({
		end: index / 2 + 0.5,
		id: crypto.randomUUID(),
		start: index / 2,
		text: `w${index}`,
	}));
	return {
		end: count / 2,
		id: crypto.randomUUID(),
		start: 0,
		text: words.map((word) => word.text).join(" "),
		words,
	};
}

const wordSpeakers = (project: Project) =>
	project.captions[0]?.words?.map((word) => word.speakerId) ?? [];

test("detect with mic dominance tags words, the caption and clips from real audio", async () => {
	const { call, store } = await studio();
	const host = await toneAsset(
		store,
		"Host lav",
		"if(lt(t\\,2)\\,0.5\\,0.01)*sin(2*PI*180*t)",
		4
	);
	const guest = await toneAsset(
		store,
		"Guest lav",
		"if(lt(t\\,2)\\,0.01\\,0.5)*sin(2*PI*220*t)",
		4
	);
	const project = store.save({
		...store.create("Interview"),
		captions: [wordCaption(8)],
		segments: [newSegment(host, 0, 0), newSegment(guest, 0, 1)],
	});
	const stale = await call(`/projects/${project.id}/speakers/detect`, {
		mode: "mic-dominance",
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);
	const detected = await call(`/projects/${project.id}/speakers/detect`, {
		mode: "mic-dominance",
		revision: project.revision,
	});
	expect(detected.status).toBe(200);
	expect(detected.body.assigned).toBe(8);
	expect(detected.body.unassigned).toBe(0);
	const saved = store.project(project.id);
	expect(saved.revision).toBe(project.revision + 1);
	const [hostSpeaker, guestSpeaker] = saved.speakers ?? [];
	expect(hostSpeaker?.label).toBe("Host lav");
	expect(guestSpeaker?.label).toBe("Guest lav");
	expect(wordSpeakers(saved)).toEqual([
		...new Array(4).fill(hostSpeaker?.id),
		...new Array(4).fill(guestSpeaker?.id),
	]);
	// A 50/50 caption tie goes to the first speaker; each lav clip carries
	// its own mic's speaker regardless of the split.
	expect(saved.captions[0]?.speakerId).toBe(hostSpeaker?.id);
	expect(saved.segments.map((segment) => segment.speakerId)).toEqual([
		hostSpeaker?.id,
		guestSpeaker?.id,
	]);
});

test("detect with clustering separates two voices on one mic", async () => {
	const { call, store } = await studio();
	const mic = await toneAsset(
		store,
		"Room mic",
		"0.4*(0.6+0.4*sin(2*PI*4*t))*if(lt(t\\,3)\\,sin(2*PI*120*t)+0.5*sin(2*PI*240*t)\\,sin(2*PI*260*t)+0.5*sin(2*PI*520*t))",
		6
	);
	const project = store.save({
		...store.create("Single mic"),
		captions: [wordCaption(12)],
		segments: [newSegment(mic, 0, 0)],
	});
	const detected = await call(`/projects/${project.id}/speakers/detect`, {
		k: 2,
		mode: "cluster",
		revision: project.revision,
	});
	expect(detected.status).toBe(200);
	const ids = wordSpeakers(store.project(project.id));
	expect(new Set(ids.slice(0, 6)).size).toBe(1);
	expect(new Set(ids.slice(6)).size).toBe(1);
	expect(ids[0]).not.toBe(ids[6]);
	const refused = await call(`/projects/${project.id}/speakers/detect`, {
		mode: "mic-dominance",
		revision: store.project(project.id).revision,
	});
	expect(refused.status).toBe(400);
	expect(refused.body.message).toContain("at least two audible mics");
});

test("rename, recolor and merge edit the speaker list with revision checks", async () => {
	const { call, store } = await studio();
	const mic = await toneAsset(store, "Mic", "0.3*sin(2*PI*200*t)", 2);
	const first = crypto.randomUUID();
	const second = crypto.randomUUID();
	const caption = wordCaption(2);
	const project = store.save({
		...store.create("Edits"),
		captions: [
			{
				...caption,
				speakerId: first,
				words: caption.words?.map((word, index) => ({
					...word,
					speakerId: index === 0 ? first : second,
				})),
			},
		],
		segments: [{ ...newSegment(mic, 0, 0), speakerId: second }],
		speakers: [
			{ color: "#ff0000", id: first, label: "Speaker 1" },
			{ color: "#00ff00", id: second, label: "Speaker 2" },
		],
	});
	const renamed = await call(`/projects/${project.id}/speakers`, {
		action: "rename",
		label: "Host",
		revision: project.revision,
		speakerId: first,
	});
	expect(renamed.status).toBe(200);
	expect(renamed.body.project.speakers[0].label).toBe("Host");
	const stale = await call(`/projects/${project.id}/speakers`, {
		action: "recolor",
		color: "#0000ff",
		revision: project.revision,
		speakerId: first,
	});
	expect(stale.status).toBe(409);
	const recolored = await call(`/projects/${project.id}/speakers`, {
		action: "recolor",
		color: "#0000ff",
		revision: project.revision + 1,
		speakerId: second,
	});
	expect(recolored.body.project.speakers[1].color).toBe("#0000ff");
	const merged = await call(`/projects/${project.id}/speakers`, {
		action: "merge",
		into: first,
		revision: project.revision + 2,
		speakerIds: [second],
	});
	expect(merged.status).toBe(200);
	const saved = store.project(project.id);
	expect(saved.speakers?.map((speaker) => speaker.id)).toEqual([first]);
	expect(saved.segments[0]?.speakerId).toBe(first);
	expect(wordSpeakers(saved)).toEqual([first, first]);
	const missing = await call(`/projects/${project.id}/speakers`, {
		action: "rename",
		label: "Ghost",
		revision: saved.revision,
		speakerId: second,
	});
	expect(missing.status).toBe(400);
});
