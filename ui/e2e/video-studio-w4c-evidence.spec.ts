import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	expect,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";

// Wave 4 (part c) evidence: Script to video (Plan tab) and AutoCut plus
// vertical shorts (Highlights tab) render in a real browser against the real
// sidecar host. The interactions host exposes no generation bridges
// (`model.complete`, `media.tts`, `media.image`, `media.transcribe`), so this
// also proves the panel plans locally and fails visibly instead of faking
// generated media. Part of the default `bun run test:e2e` run
// (the interactions host config).

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

test("W4 part c script to video, AutoCut and shorts render; missing bridges fail visibly", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.setViewportSize({ height: 1400, width: 1440 });
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w4c-evidence-")
	);
	const videoPath = path.join(fixtureDirectory, "w4c-clip.webm");
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
			.getByRole("button", { name: "Add w4c-clip.webm to timeline" })
			.click();
		await expect(
			page.getByRole("button", { name: /Select w4c-clip\.webm at/ }).first()
		).toBeVisible();

		// Script to video: without `model.complete` the script is split
		// locally and labelled as such.
		await openTab(page, "Plan", "storyboard");
		await page
			.getByRole("textbox", { exact: true, name: "Script" })
			.fill(
				"Morning light spills over the harbour. Fishing boats head out past the lighthouse. By noon the market is full of the day's catch."
			);
		await page.getByRole("button", { name: "Split into scenes" }).click();
		await expect(page.getByRole("status")).toContainText(
			"locally (Ryu's model is unavailable)"
		);
		await captureSection(
			page,
			"Script to video",
			"video-studio-w4-script-to-video.png"
		);

		// Producing needs `media.tts`; the host has none, so every scene fails
		// with a readable reason and nothing is added to the library.
		await page
			.getByRole("button", { name: "Produce narration and visuals" })
			.click();
		await expect(
			page.getByText(
				/Failed while making narration: Generation is unavailable/i
			)
		).not.toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Assemble timeline" })
		).toBeDisabled();
		// Show the failed scene rows rather than the section header.
		await page
			.getByRole("button", { name: "Assemble timeline" })
			.scrollIntoViewIfNeeded();
		await mkdir(evidenceDirectory, { recursive: true });
		await page.locator(".studio-library").screenshot({
			animations: "disabled",
			path: path.join(
				evidenceDirectory,
				"video-studio-w4-script-to-video-no-bridge.png"
			),
		});

		await openTab(page, "Highlights", "highlights");
		await captureSection(page, "AutoCut", "video-studio-w4-autocut.png");
		await captureSection(
			page,
			"Vertical shorts",
			"video-studio-w4-vertical-shorts.png"
		);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
	expect(pageErrors).toEqual([]);
});
