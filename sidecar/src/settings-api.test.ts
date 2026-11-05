import type { z } from "zod";

type StudioRequestBody = z.infer<ReturnType<typeof z.json>>;

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSchema } from "../../shared/project.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("HTTP settings patches preserve an omitted preset and reject an empty update", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-settings-patch-"))
	);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		let project = store.create("Review export");
		project = store.save({ ...project, exportPreset: "review" });
		const url = `http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/settings`;
		const patch = (body: StudioRequestBody) =>
			fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		const response = await patch({ revision: project.revision, fps: 60 });
		expect(response.status).toBe(200);
		project = projectSchema.parse(await response.json());
		expect(project).toMatchObject({ fps: 60, exportPreset: "review" });
		expect((await patch({ revision: project.revision })).status).toBe(400);
		const reset = await patch({
			revision: project.revision,
			exportPreset: "master",
		});
		expect(reset.status).toBe(200);
		expect(projectSchema.parse(await reset.json()).exportPreset).toBe("master");
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
