import type { z } from "zod";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSchema } from "../../shared/project.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("only decision append can change the current log, including across undo", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-decision-log-"))
	);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		let project = store.create("Decision history");
		const originalRevision = project.revision;
		const url = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}`;
		const send = (path: string, method: string, body: StudioRequestBody) =>
			fetch(url + path, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		let response = await send("/decisions", "POST", {
			revision: project.revision,
			category: "Creative",
			decision: "Use the original take",
			subject: "Opening",
		});
		expect(response.status).toBe(200);
		project = projectSchema.parse(await response.json());
		const original = structuredClone(project.decisions);
		for (const decisions of [
			[],
			[
				{
					...original[0],
					decision: "Rewritten",
					createdAt: "2020-01-01T00:00:00.000Z",
				},
			],
			[...original, { ...original[0], id: crypto.randomUUID() }],
		]) {
			response = await send("", "PUT", {
				...project,
				title: "Ordinary edit",
				decisions,
			});
			expect(response.status).toBe(200);
			project = projectSchema.parse(await response.json());
			expect(project.decisions).toEqual(original);
		}
		response = await send("/undo", "POST", {
			revision: project.revision,
			historyRevision: originalRevision,
		});
		expect(response.status).toBe(200);
		project = projectSchema.parse(await response.json());
		expect(project.decisions).toEqual(original);
		const revision = project.revision;
		response = await send("/decisions", "POST", {
			revision,
			category: "Runtime",
			decision: "Keep local rendering",
			subject: "Execution",
		});
		expect(response.status).toBe(200);
		project = projectSchema.parse(await response.json());
		expect(project.decisions.slice(0, 1)).toEqual(original);
		expect(project.decisions).toHaveLength(2);
		response = await send("/decisions", "POST", {
			revision,
			category: "Runtime",
			decision: "Stale append",
			subject: "Execution",
		});
		expect(response.status).toBe(409);
		expect(store.project(project.id).decisions).toEqual(project.decisions);
		const restored = store.restoreHistory(
			project.id,
			project.revision,
			originalRevision
		);
		expect(restored.decisions).toEqual(project.decisions);
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
