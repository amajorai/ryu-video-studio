import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { projectPackage } from "../../shared/package.ts";
import { type Asset, newSegment } from "../../shared/project.ts";
import * as media from "./media.ts";
import { createStudioServer } from "./server.ts";
import {
	importArchiveVideo,
	importNasaVideo,
	importOpenverseAudio,
} from "./stock.ts";
import { StudioStore } from "./store.ts";

test("approval policy route uses the separate approval authority", async () => {
	const manifest = z
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
	const route = manifest.sidecars
		.flatMap((sidecar) => sidecar.http.routes)
		.find((route) => route.path === "/projects/:id/approval-policy");
	expect(route).toEqual({
		path: "/projects/:id/approval-policy",
		method: "POST",
		permission: "video-studio.approve",
	});
});

test("all stock imports reject full libraries and custom downloads reserve quota before metadata", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-stock-quota-"))
	);
	const fetcher = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Network must not start")
	);
	const assets = spyOn(store, "assets").mockReturnValue(
		Array.from(
			{ length: 2000 },
			(): Asset => ({
				id: crypto.randomUUID(),
				name: "Capacity fixture",
				kind: "video",
				duration: 1,
				width: 2,
				height: 2,
				hasAudio: false,
				createdAt: new Date().toISOString(),
			})
		)
	);
	try {
		await expect(importArchiveVideo(store, "valid-item")).rejects.toThrow(
			"asset limit"
		);
		await expect(
			importOpenverseAudio(store, "valid-audio-identifier")
		).rejects.toThrow("asset limit");
		expect(fetcher).not.toHaveBeenCalled();
		assets.mockReturnValue([]);
		spyOn(store, "reserveMediaStorage").mockImplementation(() => {
			throw new Error("Media storage quota reached.");
		});
		await expect(importArchiveVideo(store, "valid-item")).rejects.toThrow(
			"storage quota"
		);
		expect(fetcher).not.toHaveBeenCalled();
	} finally {
		mock.restore();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("direct stock imports share admission across factories and recover after closed requests", async () => {
	const stores = await Promise.all(
		[1, 2].map(
			async () =>
				new StudioStore(await mkdtemp(join(tmpdir(), "ryu-stock-active-")))
		)
	);
	const held: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () => {
				const done = Promise.withResolvers<Response>();
				held.push(done);
				return await done.promise;
			},
			{ preconnect: fetch.preconnect }
		)
	);
	const first = importArchiveVideo(stores[0]!, "item-one").catch(
		(error) => error
	);
	const second = importArchiveVideo(stores[1]!, "item-two").catch(
		(error) => error
	);
	try {
		await expect(importArchiveVideo(stores[0]!, "item-three")).rejects.toThrow(
			"Two media operations"
		);
		expect(held).toHaveLength(2);
		for (const done of held) {
			done.resolve(Response.json({ files: [] }));
		}
		await Promise.all([first, second]);
		spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("Provider recovered")
		);
		// An admitted request reaches the provider again after cleanup.
		await expect(importArchiveVideo(stores[0]!, "item-three")).rejects.toThrow(
			"Provider recovered"
		);
	} finally {
		for (const done of held) {
			done.resolve(Response.json({ files: [] }));
		}
		await Promise.all([first, second]);
		mock.restore();
		for (const store of stores) {
			store.close();
			await rm(store.directory, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		}
	}
});

test("NASA metadata refuses rejected URL representations before fetch and disables redirects", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-nasa-metadata-"))
	);
	const fetcher = spyOn(globalThis, "fetch");
	try {
		for (const url of [
			"http://127.0.0.1:8080/private#/metadata.json",
			"https://evil.invalid/metadata.json",
			"https://images-assets.nasa.gov:8080/metadata.json",
			"https://user@images-assets.nasa.gov/metadata.json",
		]) {
			fetcher.mockClear();
			fetcher.mockResolvedValue(Response.json([url]));
			await expect(importNasaVideo(store, "valid-item")).rejects.toThrow(
				/untrusted|trusted HTTPS/
			);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
		}
	} finally {
		mock.restore();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("a legitimate stock import retains provenance and releases storage admission", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-stock-valid-"))
	);
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0]) =>
				String(input).includes("/metadata/")
					? Response.json({
							files: [{ name: "clip.mp4", size: "4" }],
							metadata: { title: "Safe clip" },
						})
					: new Response(new Uint8Array([1, 2, 3, 4])),
			{ preconnect: fetch.preconnect }
		)
	);
	spyOn(media, "probe").mockResolvedValue({
		kind: "video",
		width: 320,
		height: 180,
		duration: 1,
		hasAudio: false,
	});
	spyOn(media, "thumbnail").mockResolvedValue();
	try {
		const asset = await importArchiveVideo(store, "valid-item");
		expect(asset.origin?.provider).toBe("archive.org");
		expect(store.assets()).toHaveLength(1);
		expect(await Bun.file(store.mediaPath(asset.id)).arrayBuffer()).toEqual(
			new Uint8Array([1, 2, 3, 4]).buffer
		);
		expect(
			(await readdir(join(store.directory, "media"))).filter((name) =>
				name.endsWith(".stock")
			)
		).toEqual([]);
		store.reserveMediaStorage(1).release();
	} finally {
		mock.restore();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("thumbnail failure removes partial output before its storage reservation can be released", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-thumbnail-cleanup-"));
	const id = crypto.randomUUID();
	const output = join(directory, `${id}.jpg`);
	try {
		await Bun.write(output, "partial thumbnail");
		await expect(
			media.thumbnail(
				join(directory, "missing-source"),
				directory,
				id,
				AbortSignal.abort()
			)
		).rejects.toThrow();
		expect(await Bun.file(output).exists()).toBe(false);
	} finally {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("generation budget retains every older reservation while the history display stays bounded", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-budget-history-"))
	);
	let project = store.create("Budget history");
	project = store.save({
		...project,
		productionBudget: {
			...project.productionBudget,
			limitMicroUsd: 25_250_000,
		},
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	try {
		for (let index = 0; index < 105; index++) {
			const response = await fetch(`${base}/generations`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					id: crypto.randomUUID(),
					projectId: project.id,
					kind: "image",
					prompt: "A measured reservation",
				}),
			});
			expect(response.status).toBe(index < 101 ? 200 : 402);
		}
		expect(store.generationJobs(project.id)).toHaveLength(100);
		expect([...store.generationBudgetJobs(project.id)]).toHaveLength(101);
		const status = await (
			await fetch(`${base}/projects/${project.id}/budget`, { headers })
		).json();
		expect(status.reservedMicroUsd).toBe(25_250_000);
		expect(status.availableMicroUsd).toBe(0);
	} finally {
		app.stop();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("ordinary saves and undo preserve approval policy and approved notes; policy endpoint and reopen remain legal", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-review-policy-"))
	);
	const asset: Asset = {
		id: crypto.randomUUID(),
		name: "Reviewed take",
		kind: "image",
		width: 320,
		height: 180,
		duration: 5,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	store.putAsset(asset);
	let project = store.save({
		...store.create("Review authority"),
		segments: [newSegment(asset)],
		scenes: [
			{
				id: crypto.randomUUID(),
				title: "Opening",
				script: "",
				prompt: "",
				assetIds: [asset.id],
				duration: 5,
				sourceIn: 0,
				approved: false,
				reviewNotes: "Trusted review",
			},
		],
	});
	project = store.setApprovalRequirement(project.id, project.revision, true);
	project = store.approveScene(
		project.id,
		project.revision,
		project.scenes[0]!.id,
		true
	);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}`;
	try {
		project = await (
			await fetch(base, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					...project,
					requireApproval: false,
					scenes: project.scenes.map((scene) => ({
						...scene,
						reviewNotes: "Replaced without review",
					})),
				}),
			})
		).json();
		expect(project.requireApproval).toBe(true);
		expect(project.scenes[0]?.approved).toBe(true);
		expect(project.scenes[0]?.reviewNotes).toBe("Trusted review");
		const copied = store.duplicate(project.id);
		expect(copied.requireApproval).toBe(true);
		const importedResponse = await fetch(
			`${base.replace(`/projects/${project.id}`, "")}/projects/package`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(projectPackage(project, store.assets())),
			}
		);
		expect(importedResponse.status).toBe(200);
		const imported = await importedResponse.json();
		expect(imported.requireApproval).toBe(true);
		expect(imported.scenes[0]?.approved).toBe(false);
		const changed = await fetch(`${base}/approval-policy`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				revision: project.revision,
				requireApproval: false,
			}),
		});
		expect(changed.status).toBe(200);
		project = await changed.json();
		expect(project.requireApproval).toBe(false);
		expect(
			(
				await fetch(`${base}/approval-policy`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						revision: project.revision - 1,
						requireApproval: true,
					}),
				})
			).status
		).toBe(409);
		project = store.approveScene(
			project.id,
			project.revision,
			project.scenes[0]!.id,
			false
		);
		project = store.save({
			...project,
			scenes: project.scenes.map((scene) => ({
				...scene,
				reviewNotes: "Reopened note",
			})),
		});
		expect(project.scenes[0]?.reviewNotes).toBe("Reopened note");
		project = await (
			await fetch(`${base}/undo`, {
				method: "POST",
				headers,
				body: JSON.stringify({ revision: project.revision }),
			})
		).json();
		expect(project.requireApproval).toBe(false);
		expect(project.scenes[0]?.approved).toBe(false);
	} finally {
		app.stop();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
