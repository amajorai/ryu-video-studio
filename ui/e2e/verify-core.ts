import { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { projectSchema } from "../../shared/project.ts";
import { type StudioRequestBody, studioResponseSchema } from "../src/bridge.ts";
import {
	descendantPids,
	escapeRegExp,
	processTable,
	proofDirectory,
} from "./proof-processes.ts";

const root = new URL("../../../../", import.meta.url).pathname;

if (import.meta.main) {
	await runProof();
}

async function runProof() {
	const directory = proofDirectory(
		Bun.env.VIDEO_STUDIO_PROOF_DIR ?? Bun.env.RYU_DIR
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const preferences = new Database(`${directory}/preferences.db`, {
		create: true,
	});
	preferences.exec(
		"CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)"
	);
	preferences
		.query(
			"INSERT OR REPLACE INTO preferences (key,value,updated_at) VALUES (?,?,?)"
		)
		.run("skills.sync-system", "false", Date.now());
	preferences.close();
	const token = crypto.randomUUID();
	const log = openSync(`${directory}/core.log`, "a", 0o600);
	const core = Bun.spawn([`${root}target/debug/ryu-core`], {
		cwd: root,
		env: {
			...process.env,
			RYU_PROFILE: "dev",
			RYU_KEYCHAIN: "off",
			RYU_DIR: directory,
			RYU_BIND: "127.0.0.1:27980",
			RYU_GATEWAY_URL: "http://127.0.0.1:27981",
			RYU_PORT_OFFSET: "20000",
			RYU_TOKEN: token,
			RYU_MESH_ENABLED: "0",
			// The proof needs no local models; skip the first-run model downloads.
			RYU_SKIP_LOCAL_STACK_INSTALL: "1",
			RYU_RTK_BIN: `${directory}/disabled-rtk`,
			RYU_VIDEO_STUDIO_BIN: `${root}apps-store/video-studio/sidecar/dist/ryu-video-studio`,
			RYU_GATEWAY_BIN: `${root}target/debug/ryu-gateway`,
		},
		stdout: log,
		stderr: log,
	});
	const base = "http://127.0.0.1:27980";
	const VIDEO_STUDIO_ID = "@ryu/video-studio";
	const VIDEO_STUDIO_PATH_ID = encodeURIComponent(VIDEO_STUDIO_ID);
	const projectLibrarySchema = z.object({ projects: z.array(projectSchema) });
	const pluginEntrySchema = z
		.object({ id: z.string().optional() })
		.catchall(z.json());
	const installedPluginsSchema = z.union([
		z.array(pluginEntrySchema),
		z
			.object({
				apps: z.array(pluginEntrySchema).optional(),
				plugins: z.array(pluginEntrySchema).optional(),
			})
			.transform((value) => value.apps ?? value.plugins ?? []),
	]);
	const pluginBundleSchema = z.object({ id: z.string() }).catchall(z.json());
	const catalogSchema = z.object({
		entries: z.array(
			z
				.object({
					built_in: z.boolean().optional().catch(undefined),
					id: z.string().optional(),
					source: z.string().optional().catch(undefined),
				})
				.catchall(z.json())
		),
	});
	async function call<T>(
		schema: z.ZodType<T>,
		path: string,
		method = "GET",
		body?: StudioRequestBody
	) {
		const options: RequestInit = {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			signal: AbortSignal.timeout(30_000),
		};
		if (body !== undefined) {
			options.body = JSON.stringify(body);
		}
		const response = await fetch(`${base}${path}`, options);
		const result = z.json().parse(await response.json());
		if (!response.ok) {
			throw new Error(
				`${method} ${path}: ${response.status} ${JSON.stringify(result).slice(0, 1000)}`
			);
		}
		return schema.parse(result);
	}
	try {
		let healthy = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			healthy = await fetch(`${base}/api/health`, {
				signal: AbortSignal.timeout(1000),
			}).then(
				(r) => r.ok,
				() => false
			);
			if (healthy) {
				break;
			}
			if (core.exitCode !== null) {
				throw new Error(
					`Core exited: ${core.exitCode}. Inspect the isolated core log.`
				);
			}
			await Bun.sleep(500);
		}
		if (!healthy) {
			throw new Error("Isolated Core did not become healthy.");
		}
		process.stdout.write("Core health verified.\n");
		// Video Studio is a compiled-in Core-tier builtin (`plugins/builtins.rs`):
		// Core tier may run its sidecar without a signed bundle (and without a
		// `sidecar:process` grant, which Core tier bypasses). When Core lists
		// it, install the builtin record and enable it directly; the unsigned
		// `plugin.bundle.json` goes through the Community-tier path, which Gateway
		// correctly refuses for a sidecar app. The release-signed marketplace
		// bundle can only be verified in the release pipeline.
		const entries = await call(installedPluginsSchema, "/api/plugins");
		const installed = entries.find((entry) => entry.id === VIDEO_STUDIO_ID);
		// Opt-in builtins stay out of the runtime list until installed; Core's
		// catalog lists them with their built-in source.
		const catalog = await call(catalogSchema, "/api/plugins/catalog");
		const builtin = catalog.entries.find(
			(entry) =>
				entry.id === VIDEO_STUDIO_ID &&
				(entry.source === "built-in" || entry.built_in === true)
		);
		const listed = Boolean(installed || builtin);
		// An install left by an older build keeps that build's manifest copy;
		// reinstall it through the lifecycle so the compiled manifest is enabled.
		const compiled = z
			.object({ permission_grants: z.array(z.string()) })
			.loose()
			.parse(
				await Bun.file(`${root}apps-store/video-studio/manifest.json`).json()
			);
		const stale =
			installed !== undefined &&
			JSON.stringify(installed.permission_grants) !==
				JSON.stringify(compiled.permission_grants);
		if (stale) {
			await call(
				studioResponseSchema,
				`/api/plugins/${VIDEO_STUDIO_PATH_ID}/uninstall`,
				"POST",
				{}
			);
			process.stdout.write("Removed a stale Video Studio install.\n");
		}
		if (installed && !stale) {
			process.stdout.write("Video Studio builtin already installed.\n");
		} else if (builtin || stale) {
			await call(
				studioResponseSchema,
				`/api/plugins/${VIDEO_STUDIO_PATH_ID}/install`,
				"POST",
				{}
			);
			process.stdout.write("Video Studio builtin installed through Core.\n");
		} else {
			const bundle = pluginBundleSchema.parse(
				await Bun.file(
					`${root}apps-store/video-studio/dist/plugin.bundle.json`
				).json()
			);
			await call(
				studioResponseSchema,
				"/api/plugins/install-bundle",
				"POST",
				bundle
			);
			process.stdout.write("Video Studio bundle installed.\n");
		}
		await call(
			studioResponseSchema,
			`/api/plugins/${VIDEO_STUDIO_PATH_ID}/enable`,
			"POST",
			{}
		);
		process.stdout.write("Video Studio enabled through Core.\n");
		const enabled = (await call(installedPluginsSchema, "/api/plugins")).find(
			(entry) => entry.id === VIDEO_STUDIO_ID
		);
		if (enabled?.enabled !== true) {
			throw new Error("Core does not report Video Studio as enabled.");
		}
		let projects: z.infer<typeof projectLibrarySchema> | undefined;
		for (let attempt = 0; attempt < 60; attempt++) {
			try {
				projects = await call(
					projectLibrarySchema,
					"/api/ext/@ryu/video-studio/projects"
				);
				break;
			} catch (error) {
				if (attempt === 59) {
					throw error;
				}
				await Bun.sleep(500);
			}
		}
		if (!projects) {
			throw new Error("Invalid proxied project library response.");
		}
		process.stdout.write(
			"Video Studio sidecar spawned; authenticated Core extension proxy verified.\n"
		);
		const project = await call(
			projectSchema,
			"/api/ext/@ryu/video-studio/projects",
			"POST",
			{
				title: "Native Core lifecycle proof",
			}
		);

		const reloaded = await call(
			projectSchema,
			`/api/ext/@ryu/video-studio/projects/${project.id}`
		);
		if (reloaded.title !== project.title) {
			throw new Error("Core project round-trip mismatch.");
		}
		process.stdout.write(
			`PASS: native Core install, enable, proxy, create and reload (${listed ? "compiled-in Core-tier builtin" : "plugin bundle"}).\n`
		);
	} finally {
		// Core's managed children (its execution host, the local Gateway and the
		// Video Studio sidecar) can outlive a killed Core; stop exactly the
		// processes this run's Core started, read from the process tree before
		// Core goes, so a rerun gets free ports and no other Core is touched.
		const children = descendantPids(core.pid, processTable());
		core.kill();
		await core.exited;
		closeSync(log);
		for (const pid of children.reverse()) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already exited with Core.
			}
		}
		// A child that detached from Core's tree is matched only by what is
		// unique to this run: its data directory and the isolated Gateway port.
		for (const pattern of [
			`^${escapeRegExp(directory)}/dev-execution/`,
			`^${escapeRegExp(root)}target/debug/ryu-gateway --bind=127\\.0\\.0\\.1:27981( |$)`,
		]) {
			Bun.spawnSync(["pkill", "-f", pattern]);
		}
	}
}
