import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	expect,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";

// Wave 4 (part a) evidence: keyframe lanes, the graph editor, the volume
// rubber band, the nested sequences controls and the Templates tab render in
// a real browser against the real sidecar host. Part of the default
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

async function setPlayhead(page: Page, seconds: string) {
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill(seconds);
	await playhead.press("Tab");
}

test("W4 keyframe lanes, volume line, nesting and templates render", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w4-evidence-")
	);
	const videoPath = path.join(fixtureDirectory, "w4-clip.webm");
	try {
		await createSyntheticVideo(videoPath);
		await page.goto("/");
		await expect(page.getByRole("status")).toContainText(
			"Project library connected."
		);
		await page.getByRole("button", { name: "New project" }).click();
		await expect(page.getByRole("status")).toContainText("Project created.");
		const tour = page.getByRole("button", { name: "Skip tour" });
		if (await tour.isVisible().catch(() => false)) {
			await tour.click();
			await expect(tour).toBeHidden();
		}

		const chooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import media" }).click();
		await (await chooser).setFiles(videoPath);
		await expect(page.getByRole("status")).toContainText("Media imported.", {
			timeout: 30_000,
		});
		await page
			.getByRole("button", { name: "Add w4-clip.webm to timeline" })
			.click();
		const clip = page
			.getByRole("button", { name: /Select w4-clip\.webm at/ })
			.first();
		await expect(clip).toBeVisible();

		// Two opacity keyframes so the clip has an animated property with a
		// curve segment between them.
		await clip.click();
		await setPlayhead(page, "0.5");
		const addKeyframe = page.getByRole("button", {
			name: "Add keyframe",
			exact: true,
		});
		await addKeyframe.scrollIntoViewIfNeeded();
		await addKeyframe.click();
		await setPlayhead(page, "2.5");
		await addKeyframe.click();
		await expect(
			page.getByRole("checkbox", { name: /^Select keyframe at/ })
		).toHaveCount(2);

		// Volume rubber band: the amber handle sits on the selected clip.
		await expect(page.locator("[data-volume-handle]").first()).toBeVisible();

		// Keyframe lanes: expand, then the graph view, then the curve editor.
		// A taller window leaves room for the lanes under the clip.
		await page.setViewportSize({ height: 1400, width: 1440 });
		await page
			.getByRole("button", { name: "Show keyframe lanes" })
			.first()
			.click();
		const lanes = page.getByRole("group", { name: "Keyframe lanes" });
		await expect(lanes).toBeVisible();
		await lanes.scrollIntoViewIfNeeded();
		await capture(page, "video-studio-w4-keyframe-lanes.png");

		await lanes.getByRole("button", { name: "Graph", exact: true }).click();
		await capture(page, "video-studio-w4-keyframe-graph.png");

		await lanes
			.getByRole("button", { name: / keyframe at / })
			.first()
			.click();
		await lanes.getByRole("button", { name: "Curve", exact: true }).click();
		await expect(
			page.getByRole("group", { name: "Easing presets" })
		).toBeVisible();
		await capture(page, "video-studio-w4-graph-editor.png");
		await page.keyboard.press("Escape");
		await page.setViewportSize({ height: 1000, width: 1440 });

		// Nested sequences controls in the Media tab with the clip selected.
		await openTab(page, "Media", "media");
		await clip.click();
		const nestedTitle = page.getByRole("textbox", {
			name: "Nested sequence title",
		});
		await nestedTitle.scrollIntoViewIfNeeded();
		await expect(
			page.getByRole("button", { name: /^Nest (selection|\d+ clips)$/ })
		).toBeEnabled();
		await capture(page, "video-studio-w4-nested-sequences.png");

		// Templates tab: built-ins listed, then the fill form for one.
		await openTab(page, "Templates", "templates");
		const templates = page.getByRole("list", { name: "Templates" });
		await expect(templates).toBeVisible();
		await capture(page, "video-studio-w4-templates.png");
		await templates
			.getByRole("button", { name: "Use template", exact: true })
			.first()
			.click();
		await expect(
			page.getByRole("list", { name: "Template media" })
		).toBeVisible();
		await page.getByRole("group", { name: /^Fill / }).scrollIntoViewIfNeeded();
		await capture(page, "video-studio-w4-template-fill.png");

		expect(pageErrors).toEqual([]);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});
