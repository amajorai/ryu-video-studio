import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	expect,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";

// Wave 4 (part b) evidence: the auto reframe and motion tracking panels
// render against the real sidecar host, and a reframe changes the canvas.
// Part of the default `bun run test:e2e` run (the interactions host config).

const evidenceDirectory = path.resolve(import.meta.dirname, "evidence");

async function createSyntheticVideo(outputPath: string) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=640x360:r=24:d=4",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=4",
			"-shortest",
			// VP9/Opus so the open-source Chromium build can decode the preview.
			"-c:v",
			"libvpx-vp9",
			"-deadline",
			"realtime",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"libopus",
			"-y",
			outputPath,
		]);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-2000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderr || `FFmpeg exited with ${code}.`));
			}
		});
	});
}

async function openTab(page: Page, label: string, value: string) {
	const visibleTab = page.getByRole("tab", { name: label, exact: true });
	if (await visibleTab.isVisible().catch(() => false)) {
		await visibleTab.click();
		return;
	}
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

async function captureSection(page: Page, heading: string, name: string) {
	const section = page
		.locator(".studio-library section.ryu-app-section")
		.filter({ has: page.getByRole("heading", { exact: true, name: heading }) })
		.first();
	await expect(section).toBeVisible();
	await section.evaluate((element) =>
		element.scrollIntoView({ block: "start" })
	);
	await mkdir(evidenceDirectory, { recursive: true });
	await page.locator(".studio-library").screenshot({
		animations: "disabled",
		path: path.join(evidenceDirectory, name),
	});
}

test("W4 reframe and motion tracking panels render and reframe the canvas", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w4b-evidence-")
	);
	const videoPath = path.join(fixtureDirectory, "w4b-clip.webm");
	try {
		await createSyntheticVideo(videoPath);
		await page.goto("/");
		await expect(page.getByRole("status")).toContainText(
			"Project library connected."
		);
		await page.getByRole("button", { name: "New project" }).click();
		await expect(page.getByRole("status")).toContainText("Project created.");

		const chooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import media" }).click();
		await (await chooser).setFiles(videoPath);
		await expect(page.getByRole("status")).toContainText("Media imported.", {
			timeout: 30_000,
		});
		await page
			.getByRole("button", { name: "Add w4b-clip.webm to timeline" })
			.click();
		const clip = page
			.getByRole("button", { name: /Select w4b-clip\.webm at/ })
			.first();
		await expect(clip).toBeVisible();
		await clip.click();

		// Motion tracking with a selected video clip: region, follower and
		// the enabled Track motion action.
		await openTab(page, "Vector graphics", "graphics");
		await expect(
			page.getByRole("button", { name: "Track motion" })
		).toBeEnabled();
		await captureSection(
			page,
			"Motion tracking",
			"video-studio-w4-motion-tracking.png"
		);

		// Auto reframe in Layouts, then a real subject-tracked reframe to 9:16.
		await openTab(page, "Layouts", "layouts");
		await captureSection(page, "Auto reframe", "video-studio-w4-reframe.png");
		await page.getByRole("button", { name: "Reframe to 9:16" }).click();
		await expect(page.getByRole("status")).toContainText("1 tracked", {
			timeout: 60_000,
		});
		await mkdir(evidenceDirectory, { recursive: true });
		await page.screenshot({
			animations: "disabled",
			path: path.join(evidenceDirectory, "video-studio-w4-reframed-9x16.png"),
		});
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
	expect(pageErrors).toEqual([]);
});
