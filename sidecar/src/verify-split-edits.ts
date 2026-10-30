import type { z } from "zod";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

const SAMPLE_RATE = 48_000;
const CUT = 3;
const LEAD = 0.5;

/** Zero crossings per second of 16-bit mono PCM between two times. */
function crossingRate(pcm: Int16Array, from: number, to: number): number {
	const first = Math.floor(from * SAMPLE_RATE);
	const last = Math.min(pcm.length, Math.floor(to * SAMPLE_RATE));
	let crossings = 0;
	for (let index = first + 1; index < last; index++) {
		const previous = pcm[index - 1] ?? 0;
		const current = pcm[index] ?? 0;
		if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
			crossings++;
		}
	}
	return crossings / (to - from);
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}

await test("a J-cut renders the incoming audio ahead of the picture", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-split-edits-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = async (path: string, body?: StudioRequestBody) => {
		const init: RequestInit = {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			init
		);
		const value = await response.json();
		if (!response.ok) {
			throw new Error(`${response.status}: ${JSON.stringify(value)}`);
		}
		return value;
	};
	try {
		const sources: [string, string[]][] = [
			[
				"wide.mp4",
				[
					"-f",
					"lavfi",
					"-i",
					"color=red:s=320x180:r=30:d=6",
					"-c:v",
					"libx264",
				],
			],
			[
				"close.mp4",
				[
					"-f",
					"lavfi",
					"-i",
					"color=blue:s=320x180:r=30:d=6",
					"-c:v",
					"libx264",
				],
			],
			[
				"low.wav",
				["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-ac", "1"],
			],
			[
				"high.wav",
				["-f", "lavfi", "-i", "sine=frequency=880:duration=6", "-ac", "1"],
			],
		];
		const assets: Asset[] = [];
		for (const [name, args] of sources) {
			const file = join(directory, name);
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				...args,
				file,
			]);
			const asset: Asset = {
				...(await probe(file)),
				id: crypto.randomUUID(),
				name,
				createdAt: new Date().toISOString(),
			};
			await Bun.write(store.mediaPath(asset.id), Bun.file(file));
			store.putAsset(asset);
			assets.push(asset);
		}
		const [wide, close, low, high] = assets as [Asset, Asset, Asset, Asset];
		const outGroup = crypto.randomUUID();
		const inGroup = crypto.randomUUID();
		const project = store.save({
			...store.create("J-cut render"),
			fps: 30,
			height: 180,
			width: 320,
			segments: [
				{ ...newSegment(wide, 0, 0), sourceOut: CUT, linkGroupId: outGroup },
				{ ...newSegment(low, 0, 1), sourceOut: CUT, linkGroupId: outGroup },
				{
					...newSegment(close, CUT, 0),
					sourceIn: 1,
					sourceOut: 3,
					linkGroupId: inGroup,
				},
				{
					...newSegment(high, CUT, 1),
					sourceIn: 1,
					sourceOut: 3,
					linkGroupId: inGroup,
				},
			],
		});
		const edited = await call(`/projects/${project.id}/split-edit`, {
			cutKey: `${outGroup}>${inGroup}`,
			crossfade: 0,
			kind: "j",
			offset: LEAD,
			revision: project.revision,
		});
		assert.equal(edited.appliedOffset, -LEAD, "J-cut offset was clamped");
		const queued: RenderJob = await call(`/projects/${project.id}/render`, {});
		let job = queued;
		for (let attempt = 0; attempt < 600; attempt++) {
			job = store.jobs().find((value) => value.id === queued.id) ?? queued;
			if (["completed", "failed"].includes(job.status)) {
				break;
			}
			await Bun.sleep(100);
		}
		assert.equal(job.status, "completed", job.error ?? "render timed out");
		const raw = join(directory, "mix.pcm");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			store.renderPath(job.id),
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(SAMPLE_RATE),
			"-f",
			"s16le",
			raw,
		]);
		const bytes = new Uint8Array(await Bun.file(raw).arrayBuffer());
		const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
		const outgoing = crossingRate(pcm, CUT - LEAD - 0.9, CUT - LEAD - 0.1);
		const lead = crossingRate(pcm, CUT - LEAD + 0.1, CUT - 0.1);
		const incoming = crossingRate(pcm, CUT + 0.1, CUT + 0.9);
		assert.ok(Math.abs(outgoing - 880) < 60, `outgoing tone ${outgoing}/s`);
		assert.ok(
			Math.abs(lead - 1760) < 80,
			`incoming tone should lead the picture cut, measured ${lead}/s`
		);
		assert.ok(Math.abs(incoming - 1760) < 80, `incoming tone ${incoming}/s`);
		process.stdout.write(
			`PASS: J-cut audio leads the picture by ${LEAD}s (zero-crossing rates ${outgoing.toFixed(0)}, ${lead.toFixed(0)}, ${incoming.toFixed(0)} per second).\n`
		);
	} finally {
		app.stop();
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
