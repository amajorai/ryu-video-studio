import path from "node:path";
import {
	defineConfig,
	devices,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";

const appDirectory = path.resolve(import.meta.dirname, "..");
const baseURL = "http://127.0.0.1:5197";

export default defineConfig({
	testDir: import.meta.dirname,
	// Every package spec: the interactions suite and each wave's evidence spec.
	testMatch: "video-studio-*.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 180_000,
	reporter: "list",
	outputDir: "/tmp/ryu-video-studio-interactions-playwright-results",
	use: {
		...devices["Desktop Chrome"],
		acceptDownloads: true,
		baseURL,
		viewport: { width: 1440, height: 1000 },
	},
	webServer: {
		command: "bun run e2e/video-studio-interactions.host.ts",
		cwd: appDirectory,
		url: `${baseURL}/__ready`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
