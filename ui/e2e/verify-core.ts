import { Database } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";

const root = new URL("../../../../", import.meta.url).pathname;
const directory = "/tmp/ryu-video-studio-core-proof";
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
		RYU_RTK_BIN: `${directory}/disabled-rtk`,
		RYU_VIDEO_STUDIO_BIN: `${root}apps-store/video-studio/sidecar/dist/ryu-video-studio`,
		RYU_GATEWAY_BIN: `${root}target/debug/ryu-gateway`,
	},
	stdout: log,
	stderr: log,
});
const base = "http://127.0.0.1:27980";
async function call(path: string, method = "GET", body?: unknown) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30_000),
	});
	const result = await response.json();
	if (!response.ok) {
		throw new Error(
			`${method} ${path}: ${response.status} ${JSON.stringify(result).slice(0, 1000)}`
		);
	}
	return result;
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
	const bundle = await Bun.file(
		`${root}apps-store/video-studio/dist/plugin.bundle.json`
	).json();
	const installed = await call("/api/plugins");
	const entries = Array.isArray(installed)
		? installed
		: (installed.apps ?? installed.plugins ?? []);
	const exists = entries.some(
		(entry: { id?: string }) => entry.id === bundle.id
	);
	await call("/api/plugins/install-bundle", "POST", {
		...bundle,
		...(exists ? { update: true } : {}),
	});
	process.stdout.write("Video Studio bundle installed.\n");
	await call("/api/plugins/%40ryu%2Fvideo-studio/enable", "POST", {});
	process.stdout.write("Video Studio enabled through Core.\n");
	let projects: unknown;
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			projects = await call("/api/ext/@ryu/video-studio/projects");
			break;
		} catch (error) {
			if (attempt === 59) {
				throw error;
			}
			await Bun.sleep(500);
		}
	}
	if (!projects || typeof projects !== "object" || !("projects" in projects)) {
		throw new Error("Invalid proxied project library response.");
	}
	process.stdout.write("Authenticated Core extension proxy verified.\n");
	const project = await call("/api/ext/@ryu/video-studio/projects", "POST", {
		title: "Native Core lifecycle proof",
	});
	if (typeof project.id !== "string") {
		throw new Error("Project creation failed through Core.");
	}
	const reloaded = await call(
		`/api/ext/@ryu/video-studio/projects/${project.id}`
	);
	if (reloaded.title !== project.title) {
		throw new Error("Core project round-trip mismatch.");
	}
	process.stdout.write(
		"PASS: native Core install, enable, proxy, create and reload.\n"
	);
} finally {
	core.kill();
	await core.exited;
	closeSync(log);
}
