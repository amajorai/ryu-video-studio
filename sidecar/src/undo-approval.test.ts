type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;
type UndoRequestInput = Pick<Project, "revision"> & {
	historyRevision?: number;
};

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newSegment,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
const proxies: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
	for (const proxy of proxies.splice(0)) {
		proxy.stop(true);
	}
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function fixture() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-undo-approval-"))
	);
	stores.push(store);
	const asset: Asset = {
		id: crypto.randomUUID(),
		name: "Reviewed take",
		kind: "video",
		duration: 10,
		width: 1920,
		height: 1080,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	store.putAsset(asset);
	let project = store.create("Editorial history");
	project = store.save({
		...project,
		requireApproval: true,
		scenes: [
			{
				id: crypto.randomUUID(),
				title: "Opening",
				script: "Original script",
				prompt: "Original direction",
				assetIds: [asset.id],
				duration: 5,
				sourceIn: 0,
				approved: false,
				reviewStatus: "in-review",
			},
		],
		segments: [newSegment(asset)],
	});
	project = store.setApprovalRequirement(project.id, project.revision, true);
	const original = structuredClone(project);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	servers.push(app);
	const parsed = z
		.object({
			sidecars: z.array(
				z.object({
					http: z.object({
						routes: z.array(
							z.object({
								path: z.string(),
								method: z.string(),
								permission: z.string(),
							})
						),
					}),
				})
			),
		})
		.parse(
			await Bun.file(new URL("../../manifest.json", import.meta.url)).json()
		);
	const routes = parsed.sidecars.flatMap((sidecar) => sidecar.http.routes);
	// Permission-bearing host is an explicit fixture; its policy comes from the real manifest.
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const role = request.headers.get("authorization");
			const grants =
				role === "Bearer reviewer"
					? new Set([
							"video-studio.view",
							"video-studio.edit",
							"video-studio.approve",
							"video-studio.export",
						])
					: role === "Bearer editor"
						? new Set([
								"video-studio.view",
								"video-studio.edit",
								"video-studio.export",
							])
						: new Set<string>();
			const path = url.pathname.slice("/api/video-studio".length);
			const route = routes.find(
				(candidate) =>
					candidate.method === request.method &&
					new RegExp(
						`^${candidate.path.replaceAll(/:[^/]+/gu, "[^/]+")}$`
					).test(path)
			);
			if (!(route && grants.has(route.permission))) {
				return Response.json({ code: "FORBIDDEN" }, { status: 403 });
			}
			return await fetch(
				`http://127.0.0.1:${app.server.port}${url.pathname}${url.search}`,
				{
					method: request.method,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: request.method === "GET" ? undefined : await request.text(),
				}
			);
		},
	});
	proxies.push(proxy);
	return {
		store,
		original,
		asset,
		serviceToken: token,
		directUrl: `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}`,
		url: `http://127.0.0.1:${proxy.port}/api/video-studio/projects/${project.id}`,
	};
}

function request(
	url: string,
	role: "editor" | "reviewer",
	action: string,
	body?: StudioRequestBody
) {
	return fetch(`${url}/${action}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${role}`,
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

for (const explicit of [false, true]) {
	test(`edit-only ${explicit ? "explicit" : "default"} undo cannot reverse a reviewer's reopening`, async () => {
		const { store, original, url } = await fixture();
		const sceneId = original.scenes[0]!.id;
		const approvedResponse = await request(url, "reviewer", "approve-scene", {
			revision: original.revision,
			sceneId,
			approved: true,
		});
		expect(approvedResponse.status).toBe(200);
		const approved = projectSchema.parse(await approvedResponse.json());
		const reopenedResponse = await request(url, "reviewer", "approve-scene", {
			revision: approved.revision,
			sceneId,
			approved: false,
		});
		const reopened = projectSchema.parse(await reopenedResponse.json());
		expect(
			(
				await request(url, "editor", "approve-scene", {
					revision: reopened.revision,
					sceneId,
					approved: true,
				})
			).status
		).toBe(403);
		const undoInput: UndoRequestInput = { revision: reopened.revision };
		if (explicit) {
			undoInput.historyRevision = approved.revision;
		}
		const undo = await request(url, "editor", "undo", undoInput);
		expect(undo.status).toBe(200);
		const restored = projectSchema.parse(await undo.json());
		expect(restored.scenes[0]).toMatchObject({
			approved: false,
			reviewStatus: "in-review",
			script: original.scenes[0]!.script,
		});
		expect(restored.revision).toBe(reopened.revision + 1);
		const preflight = await request(url, "editor", "preflight");
		expect(await preflight.json()).toMatchObject({
			exportReady: false,
			blockers: expect.arrayContaining([
				expect.objectContaining({ id: "approval", status: "blocked" }),
			]),
		});
		const rejectedExport = await request(url, "editor", "render", {});
		expect(rejectedExport.status).toBe(400);
		expect(store.jobs()).toEqual([]);
		const reviewed = await request(url, "reviewer", "approve-scene", {
			revision: restored.revision,
			sceneId,
			approved: true,
		});
		expect(reviewed.status).toBe(200);
		expect(projectSchema.parse(await reviewed.json()).scenes[0]).toMatchObject({
			approved: true,
			reviewStatus: "approved",
		});
		const ready = await request(url, "editor", "preflight");
		const snapshot = z
			.object({ blockers: z.array(z.object({ id: z.string() })) })
			.parse(await ready.json());
		expect(snapshot.blockers.some((blocker) => blocker.id === "approval")).toBe(
			false
		);
	});
}

test("history restore and undo retain editorial content but invalidate stale or removed scene approvals", async () => {
	const { store, original, url } = await fixture();
	const approved = store.approveScene(
		original.id,
		original.revision,
		original.scenes[0]!.id,
		true
	);
	const changed = store.save({
		...approved,
		title: "Later project title",
		scenes: [{ ...approved.scenes[0]!, script: "Changed script" }],
	});
	const restored = store.restoreHistory(
		changed.id,
		changed.revision,
		approved.revision
	);
	expect(restored.title).toBe(approved.title);
	expect(restored.scenes[0]).toMatchObject({
		script: "Original script",
		approved: false,
		reviewStatus: "in-review",
	});
	const currentApproved = store.approveScene(
		restored.id,
		restored.revision,
		restored.scenes[0]!.id,
		true
	);
	const removed = store.save({ ...currentApproved, scenes: [] });
	// History POST is not exposed by the manifest, but its shared direct store boundary is protected too.
	const returned = store.restoreHistory(
		removed.id,
		removed.revision,
		currentApproved.revision
	);
	expect(returned.scenes[0]).toMatchObject({
		approved: false,
		reviewStatus: "in-review",
	});
	expect(
		(await request(url, "editor", "undo", { revision: removed.revision }))
			.status
	).toBe(409);
});

test("unchanged current approvals survive editorial undo even when historical approval was false", async () => {
	const { store, original } = await fixture();
	const approved = store.approveScene(
		original.id,
		original.revision,
		original.scenes[0]!.id,
		true
	);
	const edited = store.save({ ...approved, title: "Editorial title" });
	const restored = store.restoreHistory(
		edited.id,
		edited.revision,
		original.revision
	);
	expect(restored.title).toBe(original.title);
	expect(restored.segments).toEqual(original.segments);
	expect(restored.scenes[0]).toMatchObject({
		approved: true,
		reviewStatus: "approved",
	});
});

test("ordinary save and authenticated direct history POST cannot manufacture or reinstate approvals", async () => {
	const { store, original, serviceToken, directUrl } = await fixture();
	const forged = store.save({
		...original,
		scenes: [
			{ ...original.scenes[0]!, approved: true, reviewStatus: "approved" },
		],
	});
	expect(forged.scenes[0]).toMatchObject({
		approved: false,
		reviewStatus: "in-review",
	});
	const approved = store.approveScene(
		forged.id,
		forged.revision,
		forged.scenes[0]!.id,
		true
	);
	const changed = store.save({
		...approved,
		scenes: [{ ...approved.scenes[0]!, script: "Edited after approval" }],
	});
	expect(changed.scenes[0]).toMatchObject({
		approved: false,
		reviewStatus: "in-review",
	});
	const response = await fetch(`${directUrl}/history`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${serviceToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			revision: changed.revision,
			historyRevision: approved.revision,
		}),
	});
	expect(response.status).toBe(200);
	expect(projectSchema.parse(await response.json()).scenes[0]).toMatchObject({
		approved: false,
		reviewStatus: "in-review",
		script: "Original script",
	});
});
