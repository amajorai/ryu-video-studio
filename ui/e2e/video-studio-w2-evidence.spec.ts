import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	expect,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";

// Wave 2 (part b) evidence: the preview chrome, audio inspector, mixer,
// export panel, stickers, recorder and soundtrack surfaces render in a real
// browser against the real sidecar host. Part of the default
// `bun run test:e2e` run (the interactions host config).

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

async function capture(page: Page, name: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidenceDirectory, name),
	});
}

test("W2 preview, audio, export and media surfaces render with a clip", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w2-evidence-")
	);
	const videoPath = path.join(fixtureDirectory, "w2-clip.webm");
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
			.getByRole("button", { name: "Add w2-clip.webm to timeline" })
			.click();
		const clip = page
			.getByRole("button", { name: /Select w2-clip\.webm at/ })
			.first();
		await expect(clip).toBeVisible();

		// Preview chrome with title-safe and thirds guides drawn.
		const toolbar = page.locator('[aria-label="Preview controls"]');
		await expect(toolbar.getByLabel("Preview zoom")).toBeVisible();
		await toolbar.getByRole("button", { name: /^Guides/ }).click();
		await page.getByRole("checkbox", { name: "Title safe (80%)" }).check();
		await page.getByRole("checkbox", { name: "Rule of thirds" }).check();
		await page.getByRole("checkbox", { name: "Action safe (90%)" }).check();
		await page.keyboard.press("Escape");
		await expect(
			toolbar.getByRole("button", { name: /^Guides \(\d+\)$/ })
		).toBeVisible();
		await capture(page, "video-studio-w2-preview-guides.png");

		// Clip inspector: speed, audio chain, pan and media tools.
		await clip.click();
		const speed = page.getByLabel("Preserve pitch");
		await speed.scrollIntoViewIfNeeded();
		await capture(page, "video-studio-w2-inspector-speed.png");
		const cleanup = page.getByLabel("Audio cleanup");
		await cleanup.scrollIntoViewIfNeeded();
		await expect(page.getByLabel("Channels")).toBeVisible();
		await capture(page, "video-studio-w2-inspector-audio.png");

		await openTab(page, "Mixer", "mixer");
		await expect(
			page.getByText("Mixer", { exact: true }).first()
		).toBeVisible();
		await capture(page, "video-studio-w2-mixer.png");

		await openTab(page, "Exports", "exports");
		const exportHeading = page.getByText("Export", { exact: true }).first();
		await exportHeading.scrollIntoViewIfNeeded();
		await capture(page, "video-studio-w2-export-panel.png");

		await openTab(page, "Stickers", "stickers");
		await expect(
			page.getByText("Stickers", { exact: true }).first()
		).toBeVisible();
		await capture(page, "video-studio-w2-stickers.png");

		await openTab(page, "Record", "record");
		await expect(
			page.getByText("Voiceover", { exact: true }).first()
		).toBeVisible();
		await capture(page, "video-studio-w2-recorder.png");

		await openTab(page, "Media", "media");
		const soundtrack = page.getByLabel("Soundtrack style");
		await soundtrack.scrollIntoViewIfNeeded();
		await expect(page.getByLabel("Sound effect kind")).toBeVisible();
		await capture(page, "video-studio-w2-soundtrack-sfx.png");

		expect(pageErrors).toEqual([]);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});
