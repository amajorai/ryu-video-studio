import path from "node:path";
import {
	defineConfig,
	devices,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";

const appDirectory = path.resolve(import.meta.dirname, "..");
const port = 5198;

/**
 * Blend compositor parity: the preview's WebGL2 compositor against the
 * server's `inspect-frame` export, per blend mode. Headless Chromium draws
 * WebGL2 with SwiftShader, so no GPU is needed.
 */
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "blend-parity.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	reporter: "list",
	outputDir: "/tmp/ryu-video-studio-blend-parity-results",
	use: {
		...devices["Desktop Chrome"],
		baseURL: `http://127.0.0.1:${port}`,
		launchOptions: {
			args: [
				"--enable-unsafe-swiftshader",
				"--ignore-gpu-blocklist",
				"--use-angle=swiftshader",
			],
		},
	},
	webServer: {
		command: "bun run e2e/blend-parity.host.ts",
		cwd: appDirectory,
		env: { RYU_BLEND_PARITY_PORT: String(port) },
		// SIGTERM lets the host remove its temporary store.
		gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
		url: `http://127.0.0.1:${port}/__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
