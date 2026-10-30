import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_FRAME_RATES } from "../../../shared/frame-rate.ts";
import {
	type Asset,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes, WRITABLE_FRAME_RATES } from "./settings.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

async function harness() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-settings-route-"))
	);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	cleanups.push(async () => {
		app.stop();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const post = (path: string, body: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	return { post, store };
}

function video(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 8,
		frameRate: 50,
		hasAudio: true,
		height: 1080,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Pitch.mov",
		width: 1440,
		...overrides,
	};
}

test("settings accepts the widened frame-rate list", async () => {
	const { post, store } = await harness();
	const project = store.create("Rates");
	for (const fps of [48, 50, 120] as const) {
		const current = store.project(project.id);
		const response = await post(`/projects/${project.id}/settings`, {
			fps,
			revision: current.revision,
		});
		expect(response.status).toBe(200);
		expect(projectSchema.parse(await response.json()).fps).toBe(fps);
	}
	const invalid = await post(`/projects/${project.id}/settings`, {
		fps: 15,
		revision: store.project(project.id).revision,
	});
	expect(invalid.status).toBe(400);
});

test("settings description advertises exactly the rates the route saves", async () => {
	const description =
		routes.find(
			(route) => route.operation.id === "video_studio_update_project_settings"
		)?.operation.description ?? "";
	const advertised = /Frame rates are ([\d., ]+)\./.exec(description)?.[1];
	expect(advertised?.split(", ").map(Number)).toEqual([
		...WRITABLE_FRAME_RATES,
	]);
	const { post, store } = await harness();
	const project = store.create("Advertised");
	for (const fps of PROJECT_FRAME_RATES) {
		const response = await post(`/projects/${project.id}/settings`, {
			fps,
			revision: store.project(project.id).revision,
		});
		expect(response.status).toBe(
			WRITABLE_FRAME_RATES.includes(fps) ? 200 : 400
		);
	}
});

test("match-media matches canvas and rate with a revision check", async () => {
	const { post, store } = await harness();
	const asset = video();
	store.putAsset(asset);
	const created = store.create("Match");
	const project = store.save({
		...created,
		segments: [newSegment(asset, 0)],
	});
	const stale = await post(`/projects/${project.id}/match-media`, {
		assetId: asset.id,
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);
	const response = await post(`/projects/${project.id}/match-media`, {
		assetId: asset.id,
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		mismatch: { canvas: unknown; fps: number };
		project: unknown;
	};
	const saved = projectSchema.parse(body.project);
	expect(saved).toMatchObject({ fps: 50, height: 1080, width: 1440 });
	expect(saved.revision).toBe(project.revision + 1);
	expect(body.mismatch).toMatchObject({
		canvas: { height: 1080, width: 1440 },
		fps: 50,
	});
	const again = await post(`/projects/${project.id}/match-media`, {
		assetId: asset.id,
		revision: saved.revision,
	});
	expect(again.status).toBe(400);
	expect(((await again.json()) as { message: string }).message).toContain(
		"already matches"
	);
	const unknown = await post(`/projects/${project.id}/match-media`, {
		assetId: crypto.randomUUID(),
		revision: saved.revision,
	});
	expect(unknown.status).toBe(400);
	const extra = await post(`/projects/${project.id}/match-media`, {
		assetId: asset.id,
		fps: 30,
		revision: saved.revision,
	});
	expect(extra.status).toBe(400);
});
