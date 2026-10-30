import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Asset } from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { studioRoutes } from "./index.ts";
import {
	findRouteCollisions,
	matchStudioRoute,
	mergeRouteOperations,
	type StudioRoute,
	studioRoutePath,
} from "./registry.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-routes-"));
	const store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	return store;
}

function asset(): Asset {
	return {
		id: crypto.randomUUID(),
		name: "Footage",
		kind: "video",
		duration: 10,
		width: 640,
		height: 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

const echoBodySchema = z.object({ value: z.string() }).strict();

const injected: StudioRoute[] = [
	{
		scope: "project",
		action: "echo",
		method: "POST",
		operation: {
			id: "video_studio_test_echo",
			description: "Echo a value with the project id.",
			body: echoBodySchema,
		},
		handle: async ({ id, json, request }) =>
			json({ id, ...echoBodySchema.parse(await request.json()) }),
	},
	{
		scope: "project",
		action: "echo",
		subaction: "nested",
		method: "POST",
		operation: { id: "video_studio_test_echo_nested", description: "Nested." },
		handle: ({ json }) => json({ nested: true }),
	},
	{
		scope: "asset",
		action: "name",
		method: "GET",
		operation: { id: "video_studio_test_asset_name", description: "Name." },
		handle: ({ asset, json }) => json({ name: asset.name }),
	},
	{
		scope: "root",
		path: "ping",
		method: "GET",
		operation: {
			id: "video_studio_test_ping",
			description: "Ping.",
			query: [{ name: "q", schema: { type: "string" } }],
		},
		handle: ({ json, url }) => json({ q: url.searchParams.get("q") }),
	},
	{
		scope: "root",
		path: "conflict",
		method: "GET",
		operation: { id: "video_studio_test_conflict", description: "Throw." },
		handle: () => {
			throw new Error("Route failed.");
		},
	},
];

test("route matching respects scope, method, action, and subaction", () => {
	const id = crypto.randomUUID();
	const match = (target: Parameters<typeof matchStudioRoute>[1]) =>
		matchStudioRoute(injected, target)?.operation.id;
	expect(
		match({ resource: "projects", id, action: "echo", method: "POST" })
	).toBe("video_studio_test_echo");
	expect(
		match({
			resource: "projects",
			id,
			action: "echo",
			subaction: "nested",
			method: "POST",
		})
	).toBe("video_studio_test_echo_nested");
	expect(
		match({
			resource: "projects",
			id,
			action: "echo",
			subaction: "other",
			method: "POST",
		})
	).toBeUndefined();
	expect(
		match({ resource: "projects", id, action: "echo", method: "GET" })
	).toBeUndefined();
	expect(
		match({ resource: "assets", id, action: "echo", method: "POST" })
	).toBeUndefined();
	expect(match({ resource: "ping", method: "GET" })).toBe(
		"video_studio_test_ping"
	);
	expect(match({ resource: "ping", id, method: "GET" })).toBeUndefined();
	expect(
		match({ resource: "projects", action: "echo", method: "POST" })
	).toBeUndefined();
});

test("injected routes dispatch after built-ins and unmatched requests 404", async () => {
	const store = await setup();
	const source = asset();
	store.putAsset(source);
	const project = store.create("Registry");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes: injected });
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	try {
		const echo = await fetch(`${base}/projects/${project.id}/echo`, {
			body: JSON.stringify({ value: "hello" }),
			headers,
			method: "POST",
		});
		expect(echo.status).toBe(200);
		expect(echo.headers.get("cache-control")).toBe("no-store");
		expect(await echo.json()).toEqual({ id: project.id, value: "hello" });

		const nested = await fetch(`${base}/projects/${project.id}/echo/nested`, {
			headers,
			method: "POST",
		});
		expect(await nested.json()).toEqual({ nested: true });

		const named = await fetch(`${base}/assets/${source.id}/name`, { headers });
		expect(await named.json()).toEqual({ name: "Footage" });

		const missingAsset = await fetch(
			`${base}/assets/${crypto.randomUUID()}/name`,
			{ headers }
		);
		expect(missingAsset.status).toBe(404);

		const ping = await fetch(`${base}/ping?q=x`, { headers });
		expect(await ping.json()).toEqual({ q: "x" });

		const invalid = await fetch(`${base}/projects/${project.id}/echo`, {
			body: JSON.stringify({ value: 4 }),
			headers,
			method: "POST",
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ code: "INVALID_REQUEST" });

		const failed = await fetch(`${base}/conflict`, { headers });
		expect(failed.status).toBe(400);
		expect(await failed.json()).toMatchObject({ message: "Route failed." });

		// Injected routes replace the default registry, so a moved route 404s.
		const render = await fetch(`${base}/projects/${project.id}/render`, {
			headers,
			method: "POST",
		});
		expect(render.status).toBe(404);
		expect(await render.json()).toMatchObject({ code: "NOT_FOUND" });

		const unknown = await fetch(`${base}/projects/${project.id}/unknown`, {
			headers,
			method: "POST",
		});
		expect(unknown.status).toBe(404);

		const unauthorized = await fetch(`${base}/ping`);
		expect(unauthorized.status).toBe(401);

		// Built-in handlers still win over the registry.
		const read = await fetch(`${base}/projects/${project.id}`, { headers });
		expect(read.status).toBe(200);

		const document = await fetch(
			`http://127.0.0.1:${app.server.port}/openapi.json`,
			{ headers }
		);
		const paths = z
			.record(z.string(), z.record(z.string(), z.json()))
			.parse((await document.json()).paths);
		expect(paths["/api/video-studio/projects/{id}/echo"]?.post).toBeDefined();
		expect(paths["/api/video-studio/projects/{id}/render"]).toBeUndefined();
	} finally {
		app.stop();
	}
});

test("OpenAPI merges registry operations with body, path, and query parameters", () => {
	const paths = mergeRouteOperations(
		{
			"/api/video-studio/ping": {
				post: {
					operationId: "built_in",
					description: "Built in.",
					responses: {},
				},
			},
		},
		injected
	);
	const echo = paths["/api/video-studio/projects/{id}/echo"]?.post;
	expect(echo?.operationId).toBe("video_studio_test_echo");
	expect(echo?.parameters).toEqual([
		{
			name: "id",
			in: "path",
			required: true,
			schema: { type: "string", format: "uuid" },
		},
	]);
	expect(echo?.requestBody?.content["application/json"].schema).toEqual(
		z.toJSONSchema(echoBodySchema)
	);
	expect(
		paths["/api/video-studio/projects/{id}/echo/nested"]?.post?.requestBody
	).toBeUndefined();
	expect(
		paths["/api/video-studio/assets/{id}/name"]?.get?.parameters?.[0]?.name
	).toBe("id");
	const ping = paths["/api/video-studio/ping"];
	expect(ping?.post?.operationId).toBe("built_in");
	expect(ping?.get?.parameters).toEqual([
		{ name: "q", in: "query", required: false, schema: { type: "string" } },
	]);
});

test("default registry routes are unique and published in OpenAPI", () => {
	const document = openapi();
	const seen = new Set<string>();
	const operationIds = new Set<string>();
	for (const route of studioRoutes) {
		const key = `${route.method} ${studioRoutePath(route)}`;
		expect(seen.has(key)).toBe(false);
		seen.add(key);
		expect(operationIds.has(route.operation.id)).toBe(false);
		operationIds.add(route.operation.id);
		expect(
			document.paths[studioRoutePath(route)]?.[route.method.toLowerCase()]
				?.operationId
		).toBe(route.operation.id);
	}
	for (const moved of [
		"POST /api/video-studio/projects/{id}/render",
		"POST /api/video-studio/projects/{id}/tracks",
		"POST /api/video-studio/projects/{id}/tracks/reorder",
		"POST /api/video-studio/projects/{id}/markers",
		"GET /api/video-studio/assets/{id}/beats",
		"GET /api/video-studio/assets/{id}/silence",
		"POST /api/video-studio/projects/{id}/dead-air-plan",
		"POST /api/video-studio/assets/{id}/transcript",
		"PUT /api/video-studio/assets/{id}/transcript",
		"POST /api/video-studio/projects/{id}/settings",
		"POST /api/video-studio/projects/{id}/sync",
		"GET /api/video-studio/projects/{id}/multicam",
		"POST /api/video-studio/projects/{id}/multicam",
		"POST /api/video-studio/assets/{id}/upscale",
		"POST /api/video-studio/soundtrack",
		"GET /api/video-studio/assets/{id}/scopes",
		"GET /api/video-studio/projects/{id}/history",
		"POST /api/video-studio/projects/{id}/history",
		"POST /api/video-studio/projects/{id}/split",
		"POST /api/video-studio/projects/{id}/remove",
		"GET /api/video-studio/capabilities",
	]) {
		expect(seen.has(moved)).toBe(true);
	}
	// The built-in transcript read stays beside the moved write operations.
	expect(
		document.paths["/api/video-studio/assets/{id}/transcript"]?.get?.operationId
	).toBe("video_studio_read_transcript");
});

const shadowTimeline: StudioRoute = {
	scope: "project",
	action: "timeline",
	method: "GET",
	operation: { id: "video_studio_test_shadow", description: "Shadow." },
	handle: ({ json }) => json({ fromRegistry: true }),
};

test("default registry routes never share a path and method with a built-in", () => {
	const builtIns = openapi([]).paths;
	expect(findRouteCollisions(builtIns, studioRoutes)).toEqual([]);
	// The built-in timeline read exists, so the shadow fixture is a real clash.
	expect(
		builtIns["/api/video-studio/projects/{id}/timeline"]?.get
	).toBeDefined();
});

test("a registry route shadowed by a built-in or earlier route fails loudly", async () => {
	expect(findRouteCollisions(openapi([]).paths, [shadowTimeline])).toEqual([
		"GET /api/video-studio/projects/{id}/timeline",
	]);
	expect(() => openapi([shadowTimeline])).toThrow(
		"GET /api/video-studio/projects/{id}/timeline"
	);
	const duplicate = injected[0];
	if (!duplicate) {
		throw new Error("missing fixture");
	}
	expect(() => mergeRouteOperations({}, [duplicate, duplicate])).toThrow(
		"POST /api/video-studio/projects/{id}/echo"
	);
	const store = await setup();
	expect(() =>
		createStudioServer({
			store,
			token: crypto.randomUUID(),
			port: 0,
			routes: [shadowTimeline],
		})
	).toThrow("shadowed");
});

test("moved track route accepts the shared track bound", async () => {
	const store = await setup();
	const project = store.create("Tracks");
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const url = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/tracks`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	try {
		const updated = await fetch(url, {
			body: JSON.stringify({
				muted: true,
				revision: project.revision,
				track: 20,
			}),
			headers,
			method: "POST",
		});
		expect(updated.status).toBe(200);
		expect(
			(await updated.json()).trackSettings.some(
				(setting: { muted: boolean; track: number }) =>
					setting.track === 20 && setting.muted
			)
		).toBe(true);
		const outOfRange = await fetch(url, {
			body: JSON.stringify({ revision: project.revision + 1, track: 32 }),
			headers,
			method: "POST",
		});
		expect(outOfRange.status).toBe(400);
	} finally {
		app.stop();
	}
});
