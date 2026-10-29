import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const appDirectory = path.resolve(import.meta.dirname, "..");
const sidecarDirectory = path.resolve(import.meta.dirname, "../../sidecar");
const sidecarExecutable = path.join(sidecarDirectory, "dist/ryu-video-studio");
const appHtmlPath = path.join(appDirectory, "dist/index.html");
const dataDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-video-studio-interactions-")
);

async function buildPackage(directory: string, name: string) {
	const build = Bun.spawn(["bun", "run", "build"], {
		cwd: directory,
		stderr: "inherit",
		stdout: "inherit",
	});
	const exitCode = await build.exited;
	if (exitCode !== 0) {
		throw new Error(`${name} build failed with exit code ${exitCode}.`);
	}
}

// A source-identical previously verified build can be reused for test-host/spec
// changes while another worker holds the shared heavy-build lease.
if (Bun.env.RYU_VIDEO_STUDIO_E2E_PREBUILT !== "1") {
	await buildPackage(sidecarDirectory, "Video Studio sidecar");
	await buildPackage(appDirectory, "Video Studio Companion");
}

const token = crypto.randomUUID();
// Keep one genuine probe pending past Bun's default 10s HTTP idle timeout.
// The wrapper only delays startup; metadata still comes from installed ffprobe.
const probeBinary = Bun.env.RYU_VIDEO_STUDIO_FFPROBE || Bun.which("ffprobe");
if (!probeBinary) {
	throw new Error("Video Studio interaction coverage requires ffprobe.");
}
const probeLauncher = path.join(dataDirectory, "slow-first-probe");
const probeMarker = path.join(dataDirectory, "probe-started");
await Bun.write(
	probeLauncher,
	`#!/usr/bin/env bun\nconst marker = Bun.file(${JSON.stringify(probeMarker)});\nif (!(await marker.exists())) {\n await Bun.write(marker, "started");\n await Bun.sleep(11_000);\n}\nconst child = Bun.spawn([${JSON.stringify(probeBinary)}, ...process.argv.slice(2)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });\nprocess.exit(await child.exited);\n`
);
await chmod(probeLauncher, 0o700);
const reservation = Bun.serve({
	fetch: () => new Response("reserved"),
	hostname: "127.0.0.1",
	port: 0,
});
const sidecarPort = reservation.port;
reservation.stop();

const sidecar = Bun.spawn([sidecarExecutable], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_EXT_PLUGIN_ID: "@ryu/video-studio",
		RYU_CORE_PORT: "27980",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: dataDirectory,
		RYU_VIDEO_STUDIO_PORT: String(sidecarPort),
		RYU_VIDEO_STUDIO_FFPROBE: probeLauncher,
	},
	stderr: "inherit",
	stdout: "inherit",
});

let sidecarReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
	if (sidecar.exitCode !== null) {
		throw new Error("The Video Studio test sidecar exited during startup.");
	}
	sidecarReady = await fetch(
		`http://127.0.0.1:${sidecarPort}/api/video-studio/projects`,
		{ headers: { authorization: `Bearer ${token}` } }
	).then(
		(response) => response.ok,
		() => false
	);
	if (sidecarReady) {
		break;
	}
	await Bun.sleep(100);
}
if (!sidecarReady) {
	sidecar.kill();
	await rm(dataDirectory, { force: true, recursive: true });
	throw new Error("The Video Studio test sidecar did not become ready.");
}

const bridge = `<script>window.ryu={app:{request:async(input)=>{const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Request failed');return result;}}};</script>`;
const html = (await Bun.file(appHtmlPath).text()).replace(
	"<head>",
	`<head>${bridge}`
);

const host = Bun.serve({
	hostname: "127.0.0.1",
	// Match the sidecar while synchronous media probing is still in flight.
	idleTimeout: 120,
	maxRequestBodySize: 16 * 1024 * 1024,
	port: 5197,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname.startsWith("/__studio/")) {
			const options: RequestInit = {
				method: request.method,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
			};
			if (!["GET", "HEAD"].includes(request.method)) {
				options.body = await request.arrayBuffer();
			}
			return fetch(
				`http://127.0.0.1:${sidecarPort}/api/video-studio${url.pathname.slice("/__studio".length)}${url.search}`,
				options
			);
		}
		return new Response(html, { headers: { "content-type": "text/html" } });
	},
});

let stopping = false;
const stop = async () => {
	if (stopping) {
		return;
	}
	stopping = true;
	host.stop();
	sidecar.kill();
	await sidecar.exited;
	await rm(dataDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
