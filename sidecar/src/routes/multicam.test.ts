import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMulticamGroup } from "../../../shared/multicam.ts";
import type { Asset, Project } from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) {
		await step();
	}
});

function media(name: string, kind: "audio" | "video"): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 6,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-multicam-")));
	cleanup.push(async () => {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	cleanup.push(() => app.stop());
	const url = (project: Project) =>
		`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/multicam`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	return { headers, store, url };
}

test("multicam route switches mics and layouts over ranges", async () => {
	const { headers, store, url } = await studio();
	const assets = [
		media("Wide", "video"),
		media("Close", "video"),
		media("Host", "audio"),
		media("Guest", "audio"),
	];
	for (const asset of assets) {
		store.putAsset(asset);
	}
	const [wide, close, host, guest] = assets as [Asset, Asset, Asset, Asset];
	const blank = store.create("Route multicam");
	const created = createMulticamGroup(blank, assets, {
		action: "create",
		masterAssetId: host.id,
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: host.id, kind: "mic", label: "Host" },
			{ assetId: guest.id, kind: "mic", label: "Guest" },
		],
		revision: blank.revision,
	});
	const project = store.save(created.project);
	const response = await fetch(url(project), {
		body: JSON.stringify({
			action: "change",
			entries: [
				{ audio: "Guest", end: 4, start: 2 },
				{
					end: 4,
					layout: {
						angles: ["Wide", "Close"],
						fit: "fit",
						layout: "picture-in-picture",
					},
					start: 3,
				},
			],
			groupId: created.group.id,
			revision: project.revision,
		}),
		headers,
		method: "POST",
	});
	expect(response.status).toBe(200);
	const saved = store.project(project.id);
	expect(saved.revision).toBe(project.revision + 1);
	expect(
		saved.segments
			.filter((segment) => segment.track === 1)
			.map((segment) => segment.assetId)
	).toEqual([host.id, guest.id, host.id]);
	expect(
		saved.segments.find(
			(segment) => segment.track === 2 && segment.assetId === close.id
		)
	).toMatchObject({ scale: 0.35, start: 3 });
	const read = (await (await fetch(url(project), { headers })).json()) as {
		groups: { switches: { audio?: string }[] }[];
	};
	expect(read.groups[0]?.switches.map((entry) => entry.audio)).toEqual([
		undefined,
		"Guest",
		"Guest",
		undefined,
	]);
	const refused = await fetch(url(project), {
		body: JSON.stringify({
			action: "change",
			entries: [{ audio: "Wide", end: 2, start: 1 }],
			groupId: created.group.id,
			revision: saved.revision,
		}),
		headers,
		method: "POST",
	});
	expect(refused.status).toBe(400);
	expect(store.project(project.id).revision).toBe(saved.revision);
});
