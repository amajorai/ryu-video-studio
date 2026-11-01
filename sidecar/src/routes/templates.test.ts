import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import {
	BUILT_IN_TEMPLATES,
	TEMPLATE_PLACEHOLDER_NAME,
} from "../../../shared/template-library.ts";
import {
	templateAdjustmentSchema,
	templateAssignmentSchema,
	templateSummarySchema,
	templatesResponseSchema,
} from "../../../shared/templates.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./templates.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

const errorSchema = z.object({ code: z.string(), message: z.string() });
const savedSchema = z.object({
	project: projectSchema,
	template: templateSummarySchema,
});
const instanceSchema = z.object({
	adjustments: z.array(templateAdjustmentSchema),
	assignments: z.array(templateAssignmentSchema),
	createdAssets: z.array(z.object({ id: z.string(), name: z.string() })),
	project: projectSchema,
	unfilledSlotIds: z.array(z.string()),
	unusedAssetIds: z.array(z.string()),
});

function media(kind: Asset["kind"], duration: number): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}.bin`,
		width: kind === "audio" ? 0 : 640,
	};
}

async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-studio-templates-")
	);
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const call = (method: "GET" | "POST", path: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method,
		});
	return { call, store };
}

/** A saved project with three 2 s clips of one 30 s video. */
function seed(store: StudioStore) {
	const footage = media("video", 30);
	store.putAsset(footage);
	const created = store.create("Source");
	const clips = [0, 2, 4].map((start) => ({
		...newSegment(footage, start),
		sourceIn: 3,
		sourceOut: 5,
	}));
	const project = store.save({ ...created, segments: clips });
	return { clips, footage, project };
}

describe("GET /templates", () => {
	test("lists the built-ins, then saved templates", async () => {
		const { call, store } = await setup();
		const { clips, project } = seed(store);
		let response = await call("GET", "/templates");
		expect(response.status).toBe(200);
		let body = templatesResponseSchema.parse(await response.json());
		expect(body.templates.map((item) => item.id)).toEqual(
			BUILT_IN_TEMPLATES.map((item) => item.id)
		);
		await call("POST", `/projects/${project.id}/save-template`, {
			slots: [{ segmentId: clips[0]?.id }],
			revision: project.revision,
		});
		response = await call("GET", "/templates");
		body = templatesResponseSchema.parse(await response.json());
		expect(body.templates).toHaveLength(BUILT_IN_TEMPLATES.length + 1);
		expect(body.templates.at(-1)?.builtIn).toBe(false);
		expect(body.templates.at(-1)?.title).toBe("Source template");
	});
});

describe("POST /projects/:id/save-template", () => {
	test("creates a template copy and leaves the source unchanged", async () => {
		const { call, store } = await setup();
		const { clips, project } = seed(store);
		const response = await call(
			"POST",
			`/projects/${project.id}/save-template`,
			{
				slots: clips.map((clip, index) => ({
					segmentId: clip.id,
					label: `Shot ${index + 1}`,
				})),
				title: "Three cuts",
				category: "Mine",
				revision: project.revision,
			}
		);
		expect(response.status).toBe(201);
		const body = savedSchema.parse(await response.json());
		expect(body.project.id).not.toBe(project.id);
		expect(body.project.title).toBe("Three cuts");
		expect(body.project.template?.slots).toHaveLength(3);
		expect(body.template.slots.map((slot) => slot.label)).toEqual([
			"Shot 1",
			"Shot 2",
			"Shot 3",
		]);
		expect(store.project(project.id)).toEqual(project);
	});

	test("rejects a stale revision", async () => {
		const { call, store } = await setup();
		const { clips, project } = seed(store);
		const response = await call(
			"POST",
			`/projects/${project.id}/save-template`,
			{ slots: [{ segmentId: clips[0]?.id }], revision: project.revision + 1 }
		);
		expect(response.status).toBe(409);
		expect(errorSchema.parse(await response.json()).code).toBe("CONFLICT");
		expect(store.projects()).toHaveLength(1);
	});

	test("rejects a slot naming a missing clip", async () => {
		const { call, store } = await setup();
		const { project } = seed(store);
		const response = await call(
			"POST",
			`/projects/${project.id}/save-template`,
			{
				slots: [{ segmentId: crypto.randomUUID() }],
				revision: project.revision,
			}
		);
		expect(response.status).toBe(400);
		expect(store.projects()).toHaveLength(1);
	});
});

describe("POST /template-instances", () => {
	test("fills a saved template and reports leftovers", async () => {
		const { call, store } = await setup();
		const { clips, footage, project } = seed(store);
		const saved = savedSchema.parse(
			await (
				await call("POST", `/projects/${project.id}/save-template`, {
					slots: clips.map((clip) => ({ segmentId: clip.id })),
					revision: project.revision,
				})
			).json()
		);
		const photo = media("image", 5);
		const shortClip = media("video", 1);
		store.putAsset(photo);
		store.putAsset(shortClip);
		const response = await call("POST", "/template-instances", {
			templateId: saved.project.id,
			assetIds: [photo.id, shortClip.id],
			title: "From template",
		});
		expect(response.status).toBe(201);
		const body = instanceSchema.parse(await response.json());
		expect(body.project.title).toBe("From template");
		expect(body.project.template).toBeUndefined();
		expect(body.project.revision).toBe(1);
		expect(body.assignments).toHaveLength(2);
		expect(body.unfilledSlotIds).toEqual([
			saved.project.template?.slots[2]?.id ?? "",
		]);
		expect(body.adjustments).toEqual([
			{ segmentId: clips[1]?.id ?? "", change: "retimed" },
		]);
		expect(body.createdAssets).toEqual([]);
		expect(body.project.segments.map((segment) => segment.assetId)).toEqual([
			photo.id,
			shortClip.id,
			footage.id,
		]);
		// The template itself is unchanged.
		expect(store.project(saved.project.id)).toEqual(saved.project);
	});

	test("POST /templates/:id/instantiate takes the template id from the path", async () => {
		const { call, store } = await setup();
		const { clips, project } = seed(store);
		const saved = savedSchema.parse(
			await (
				await call("POST", `/projects/${project.id}/save-template`, {
					slots: clips.map((clip) => ({ segmentId: clip.id })),
					revision: project.revision,
				})
			).json()
		);
		const photo = media("image", 5);
		store.putAsset(photo);
		const response = await call(
			"POST",
			`/templates/${saved.project.id}/instantiate`,
			{ assetIds: [photo.id], title: "By id" }
		);
		expect(response.status).toBe(201);
		const body = instanceSchema.parse(await response.json());
		expect(body.project.title).toBe("By id");
		expect(body.project.segments[0]?.assetId).toBe(photo.id);
		// The id lives in the path, so a body templateId is refused.
		const refused = await call(
			"POST",
			`/templates/${saved.project.id}/instantiate`,
			{ assetIds: [], templateId: saved.project.id }
		);
		expect(refused.status).toBe(400);
	});

	test("rejects unknown media and non-template projects without creating anything", async () => {
		const { call, store } = await setup();
		const { project } = seed(store);
		let response = await call("POST", "/template-instances", {
			templateId: BUILT_IN_TEMPLATES[0]?.id,
			assetIds: [crypto.randomUUID()],
		});
		expect(response.status).toBe(400);
		response = await call("POST", "/template-instances", {
			templateId: project.id,
			assetIds: [],
		});
		expect(response.status).toBe(400);
		expect(errorSchema.parse(await response.json()).message).toContain(
			"not a template"
		);
		expect(store.projects()).toHaveLength(1);
		expect(store.assets()).toHaveLength(1);
	});

	test("rejects a preview proxy before creating any media", async () => {
		const { call, store } = await setup();
		const source = media("video", 10);
		const proxy: Asset = {
			...media("video", 10),
			derivation: "proxy",
			derivedFromAssetId: source.id,
		};
		store.putAsset(source);
		store.putAsset(proxy);
		const response = await call("POST", "/template-instances", {
			templateId: BUILT_IN_TEMPLATES[0]?.id,
			assetIds: [proxy.id],
		});
		expect(response.status).toBe(400);
		expect(errorSchema.parse(await response.json()).message).toContain("proxy");
		expect(
			store
				.assets()
				.map((asset) => asset.id)
				.sort()
		).toEqual([source.id, proxy.id].sort());
		expect(store.projects()).toHaveLength(0);
	});

	test("removes media it created when the fill is refused", async () => {
		const { call, store } = await setup();
		const template = BUILT_IN_TEMPLATES[0];
		if (!template) {
			throw new Error("Missing template.");
		}
		// Too short to be the music bed: refused after the matte is made.
		const blip = media("audio", 0.01);
		store.putAsset(blip);
		const response = await call("POST", "/template-instances", {
			templateId: template.id,
			assetIds: [blip.id],
		});
		expect(response.status).toBe(400);
		expect(store.assets().map((asset) => asset.id)).toEqual([blip.id]);
		expect(store.projects()).toHaveLength(0);
		const leftovers = await readdir(join(store.directory, "media"));
		expect(leftovers).toEqual([]);
	});

	test("materializes a built-in with a reused placeholder matte and no music", async () => {
		const { call, store } = await setup();
		const template = BUILT_IN_TEMPLATES[5];
		if (!template) {
			throw new Error("Missing template.");
		}
		const photos = [media("image", 5), media("image", 5)];
		for (const photo of photos) {
			store.putAsset(photo);
		}
		const first = instanceSchema.parse(
			await (
				await call("POST", "/template-instances", {
					templateId: template.id,
					assetIds: photos.map((photo) => photo.id),
					music: false,
				})
			).json()
		);
		expect(first.project.title).toBe(template.title);
		expect(first.createdAssets.map((asset) => asset.name)).toEqual([
			TEMPLATE_PLACEHOLDER_NAME,
		]);
		const matte = first.createdAssets[0];
		expect(existsSync(store.mediaPath(matte?.id ?? ""))).toBe(true);
		expect(first.unfilledSlotIds).toHaveLength(template.slots.length - 2);
		expect(first.project.background).toEqual(template.background);
		const second = instanceSchema.parse(
			await (
				await call("POST", "/template-instances", {
					templateId: template.id,
					assetIds: [],
					music: false,
				})
			).json()
		);
		expect(second.createdAssets).toEqual([]);
		expect(
			second.project.segments.every((segment) => segment.assetId === matte?.id)
		).toBe(true);
	});

	test("a supplied audio asset becomes the music bed", async () => {
		const { call, store } = await setup();
		const template = BUILT_IN_TEMPLATES[0];
		if (!template) {
			throw new Error("Missing template.");
		}
		const song = media("audio", 120);
		store.putAsset(song);
		const body = instanceSchema.parse(
			await (
				await call("POST", "/template-instances", {
					templateId: template.id,
					assetIds: [song.id],
				})
			).json()
		);
		expect(body.createdAssets).toHaveLength(1);
		expect(body.unusedAssetIds).toEqual([]);
		const bed = body.project.segments.find(
			(segment) => segment.assetId === song.id
		);
		expect(bed?.track).toBe(3);
		expect(bed?.volume).toBe(0.5);
	});
});

describe("openapi", () => {
	test("publishes the template operations", () => {
		const paths = openapi(routes).paths as Record<string, unknown>;
		expect(Object.keys(paths)).toEqual(
			expect.arrayContaining([
				"/api/video-studio/projects/{id}/save-template",
				"/api/video-studio/templates",
				"/api/video-studio/template-instances",
				"/api/video-studio/templates/{id}/instantiate",
			])
		);
	});
});
