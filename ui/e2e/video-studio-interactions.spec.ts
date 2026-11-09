import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	expect,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";
import { projectSchema } from "../../shared/project.ts";
import type { StudioResponse } from "../src/bridge.ts";

// The package scanner recognizes browser specs by `from "@playwright/test"`; use the Desktop-pinned runner below to avoid adding a second dependency or lockfile change.

interface StudioRequest {
	body?: StudioResponse;
	method: string;
	path: string;
}

const evidenceDirectory = path.resolve(import.meta.dirname, "evidence");
const execFileAsync = promisify(execFile);

function uniqueTitle(prefix: string) {
	return `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
}

function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/__studio/")) {
			return;
		}
		const body = request.postData();
		let parsedBody: StudioResponse;
		if (body) {
			try {
				parsedBody = z.json().parse(JSON.parse(body));
			} catch {
				parsedBody = body;
			}
		}
		const observed: StudioRequest = {
			method: request.method(),
			path: url.pathname.slice("/__studio".length),
		};
		if (parsedBody !== undefined) {
			observed.body = parsedBody;
		}
		requests.push(observed);
	});
	return requests;
}

async function projectTitleField(page: Page) {
	return page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
}

async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = await projectTitleField(page);
	await expect(titleField).toBeVisible();
	await titleField.fill(title);
	await saveProject(page);
	return await page.getByLabel("Project", { exact: true }).inputValue();
}

async function makePng(page: Page, label: string): Promise<Buffer> {
	const bytes = await page.evaluate(async (text) => {
		const canvas = document.createElement("canvas");
		canvas.width = 640;
		canvas.height = 360;
		const context = canvas.getContext("2d");
		if (!context) {
			throw new Error("Canvas rendering is unavailable.");
		}
		context.fillStyle = "#0c2340";
		context.fillRect(0, 0, 640, 360);
		context.fillStyle = "#f97316";
		context.fillRect(80, 60, 480, 240);
		context.fillStyle = "#ffffff";
		context.font = "600 28px sans-serif";
		context.fillText(text, 96, 185);
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((result) => {
				if (result) {
					resolve(result);
				} else {
					reject(new Error("Could not create the image fixture."));
				}
			}, "image/png");
		});
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	}, label);
	return Buffer.from(bytes);
}

async function importImage(page: Page, fileName: string) {
	const requests = recordStudioRequests(page);
	const finishedUpload = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			/^\/__studio\/uploads\/[^/]+\/finish$/.test(
				new URL(response.url()).pathname
			),
		{ timeout: 30_000 }
	);
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles({
		buffer: await makePng(page, fileName),
		mimeType: "image/png",
		name: fileName,
	});
	expect((await finishedUpload).status()).toBe(201);
	expect(
		requests.filter(
			(request) =>
				request.method === "POST" &&
				/^\/uploads\/[^/]+\/finish$/.test(request.path)
		)
	).toHaveLength(1);
	await expect(page.getByRole("status")).toContainText("Media imported.");
}

async function createSyntheticVideo(outputPath: string) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x235a83:s=320x180:r=24:d=4",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=4",
			"-shortest",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
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

async function importVideo(page: Page, filePath: string, fileName: string) {
	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import media" }).click();
	await (await fileChooserPromise).setFiles(filePath);
	await expect(page.getByRole("status")).toContainText("Media imported.", {
		timeout: 30_000,
	});
	await expect(
		page.getByRole("button", { name: `Add ${fileName} to timeline` })
	).toBeVisible();
}

async function addToTimeline(page: Page, fileName: string) {
	await page
		.getByRole("button", { name: `Add ${fileName} to timeline` })
		.click();
	await expect
		.poll(async () =>
			page
				.getByRole("button", { name: new RegExp(`Select ${fileName} at`) })
				.count()
		)
		.toBeGreaterThan(0);
}

async function openOverflowTab(page: Page, label: string, value: string) {
	const visibleTab = page.getByRole("tab", { name: label, exact: true });
	// The strip re-measures its overflow after each panel opens, so a tab seen
	// as visible can move into the overflow menu before the click lands; a
	// short click timeout falls back to the menu instead of waiting forever.
	if (await visibleTab.isVisible().catch(() => false)) {
		const clicked = await visibleTab
			.click({ timeout: 3000 })
			.then(() => true)
			.catch(() => false);
		if (clicked) {
			return;
		}
	}
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tabItem = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tabItem).toBeVisible();
	await tabItem.click();
}

/**
 * Save pending edits. Autosave may already have written them (the Save
 * button then is gone and the chip reads Saved), so a manual save is best
 * effort; either way the project ends saved with nothing pending.
 */
async function saveProject(page: Page) {
	const save = page.getByRole("button", { exact: true, name: "Save changes" });
	await save.click({ timeout: 2000 }).catch(() => undefined);
	await expect(save).toBeHidden();
	await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
}

async function getSavedProject(page: Page, projectId: string) {
	const response = await page.request.get(
		`/__studio/projects/${encodeURIComponent(projectId)}`
	);
	expect(response.ok()).toBe(true);
	return projectSchema.parse(await response.json());
}

async function setColor(page: Page, triggerName: string, value: string) {
	await page.getByRole("button", { name: triggerName, exact: true }).click();
	const input = page.getByRole("textbox", { name: "Hex color value" }).last();
	await expect(input).toBeVisible();
	await input.fill(value);
	await expect(input).toHaveValue(value.toUpperCase());
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: triggerName, exact: true })
	).toContainText(value.toUpperCase());
}

async function saveScreenshot(page: Page, name: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDirectory, name),
	});
}

test("all Video Studio category tabs open their real panels", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await createProject(page, uniqueTitle("Category tabs"));

	const categories = [
		["Media", "media", "Media library"],
		["Find footage", "search", "Find footage by meaning"],
		["Stock", "stock", "Open media"],
		["Reference", "reference", "Reference study"],
		["Plan", "storyboard", "Production plan"],
		["Recipes", "recipes", "Production recipes"],
		["Layouts", "layouts", "Layouts"],
		["Sync", "sync", "Sync clips"],
		["Multicam", "multicam", "Multicam sessions"],
		["J/L cuts", "split-edits", "Auto J/L cuts"],
		["Cleanup", "cleanup", "Cleanup"],
		["Highlights", "highlights", "Highlights"],
		["Speed & beat", "tempo", "Speed curve"],
		["Generate", "generate", "Generate with Ryu"],
		["Captions", "captions", "Timed captions"],
		["Transcript", "transcript", "Source transcript"],
		["Titles", "titles", "Titles and lower thirds"],
		["Vector graphics", "graphics", "Vector graphics"],
		["Avatars", "avatars", "Avatars"],
		["3D stage", "stage", "3D stage"],
		["Meshes", "meshes", "Meshes"],
		["Credits", "credits", "Credits and provenance"],
		["Exports", "exports", "Export history"],
	] as const;

	for (const [label, value, heading] of categories) {
		await openOverflowTab(page, label, value);
		await expect(
			page.getByRole("heading", { name: heading, exact: true })
		).toBeVisible();
	}
	expect(pageErrors).toEqual([]);
	await saveScreenshot(page, "video-studio-category-tabs.png");
});

test("NumberField, keyboard, and pointer timeline edits save and read back", async ({
	page,
}) => {
	const title = uniqueTitle("Timeline interaction");
	const requests = recordStudioRequests(page);
	const projectId = await createProject(page, title);
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-clip-fixture-")
	);
	const videoPath = path.join(fixtureDirectory, "timeline-control.mp4");
	try {
		await createSyntheticVideo(videoPath);
		const importStarted = Date.now();
		const finishedUpload = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				/^\/__studio\/uploads\/[^/]+\/finish$/.test(
					new URL(response.url()).pathname
				),
			{ timeout: 30_000 }
		);
		await importVideo(page, videoPath, "timeline-control.mp4");
		expect((await finishedUpload).status()).toBe(201);
		// The test host delays the first real ffprobe invocation by 11s.
		// Prove the pending HTTP response survives rather than retrying finish.
		expect(Date.now() - importStarted).toBeGreaterThan(10_000);
		expect(
			requests.filter(
				(request) =>
					request.method === "POST" &&
					/^\/uploads\/[^/]+\/finish$/.test(request.path)
			)
		).toHaveLength(1);
		await addToTimeline(page, "timeline-control.mp4");
		await addToTimeline(page, "timeline-control.mp4");

		const start = page.getByRole("spinbutton", { name: "Timeline start" });
		await page
			.getByRole("button", {
				name: "Select timeline-control.mp4 at 4.00 seconds",
			})
			.click();
		await expect(start).toHaveValue("4");
		// An invalid expression is reverted on blur.
		await start.fill("4/0");
		await start.press("Tab");
		await expect(start).toHaveValue("4");

		const track = page.getByRole("spinbutton", {
			name: "Track",
			exact: true,
		});
		// Out-of-range values clamp to the field's limit.
		await track.fill("17");
		await track.press("Tab");
		await expect(track).toHaveValue("16");
		await track.fill("1");
		await track.press("Tab");
		await expect(track).toHaveValue("1");

		// Typed arithmetic is evaluated.
		await start.fill("10.5/2");
		await start.press("Tab");
		await expect(start).toHaveValue("5.25");
		await saveProject(page);
		const numberFieldProject = await getSavedProject(page, projectId);
		expect(
			numberFieldProject.segments.find((segment) => segment.start === 5.25)
				?.start
		).toBe(5.25);

		let clip = page.getByRole("button", {
			name: `Select timeline-control.mp4 at ${Number(await start.inputValue()).toFixed(2)} seconds`,
			exact: true,
		});
		await clip.focus();
		const beforeKeyboardMove = Number(await start.inputValue());
		await page.keyboard.press("Alt+ArrowRight");
		await expect
			.poll(async () => Number(await start.inputValue()))
			.toBeGreaterThan(beforeKeyboardMove);
		const afterKeyboardMove = Number(await start.inputValue());
		expect(afterKeyboardMove - beforeKeyboardMove).toBeLessThan(0.1);

		clip = page.getByRole("button", {
			name: `Select timeline-control.mp4 at ${Number(await start.inputValue()).toFixed(2)} seconds`,
			exact: true,
		});
		await clip.scrollIntoViewIfNeeded();
		const bounds = await clip.boundingBox();
		if (!bounds) {
			throw new Error("The timeline clip has no visible pointer target.");
		}
		const beforePointerMove = Number(await start.inputValue());
		const sourceIn = page.getByRole("spinbutton", { name: "Source in" });
		const beforeTrim = Number(await sourceIn.inputValue());
		const centerX = bounds.x + bounds.width / 2;
		const centerY = bounds.y + bounds.height / 2;
		await page.mouse.move(centerX, centerY);
		await page.mouse.down();
		await page.mouse.move(centerX + 35, centerY + 54, { steps: 3 });
		await page.mouse.up();
		await expect
			.poll(async () => Number(await start.inputValue()))
			.toBeGreaterThan(beforePointerMove + 0.3);
		await expect(track).toHaveValue("2");

		clip = page.getByRole("button", {
			name: `Select timeline-control.mp4 at ${Number(await start.inputValue()).toFixed(2)} seconds`,
			exact: true,
		});
		await clip.scrollIntoViewIfNeeded();
		const trimBounds = await clip.boundingBox();
		if (!trimBounds) {
			throw new Error(
				"The timeline clip lost its pointer target after moving."
			);
		}
		const trimY = trimBounds.y + trimBounds.height / 2;
		await page.mouse.move(trimBounds.x + 4, trimY);
		await page.mouse.down();
		await page.mouse.move(trimBounds.x + 18, trimY, { steps: 2 });
		await page.mouse.up();
		await expect
			.poll(async () => Number(await sourceIn.inputValue()))
			.toBeGreaterThan(beforeTrim);

		await saveProject(page);
		const saved = await getSavedProject(page, projectId);
		expect(saved.segments).toHaveLength(2);
		const pointerEditedSegment = saved.segments.find(
			(segment) => segment.track === 1
		);
		expect(pointerEditedSegment).toBeDefined();
		expect(pointerEditedSegment?.start).toBeCloseTo(
			Number(await start.inputValue()),
			3
		);
		expect(pointerEditedSegment?.sourceIn).toBeGreaterThan(0);
		await saveScreenshot(
			page,
			"video-studio-timeline-pointer-keyboard-readback.png"
		);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});

test("detached audio, manual and shortcut J/L cuts, trim tools, auto plan, and linked delete", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const projectId = await createProject(page, uniqueTitle("Split edits"));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-split-fixture-")
	);
	const videoPath = path.join(fixtureDirectory, "split-take.mp4");
	const status = page.getByRole("status");
	const clipButton = (start: string) =>
		page.getByRole("button", {
			name: `Select split-take.mp4 at ${start} seconds`,
			exact: true,
		});
	const setField = async (name: string, value: string) => {
		const field = page.getByRole("spinbutton", { name, exact: true });
		await field.fill(value);
		await field.press("Tab");
		await expect(field).toHaveValue(value);
	};
	try {
		await createSyntheticVideo(videoPath);
		await importVideo(page, videoPath, "split-take.mp4");
		await addToTimeline(page, "split-take.mp4");
		await addToTimeline(page, "split-take.mp4");

		// Leave one second of source on each side of the cut at 3s.
		await clipButton("0.00").click();
		await setField("Source out", "3");
		await clipButton("4.00").click();
		await setField("Source in", "1");
		await setField("Timeline start", "3");

		for (const start of ["0.00", "3.00"]) {
			await clipButton(start).click();
			await page.getByRole("button", { name: "Detach audio" }).click();
			// The status line can be replaced by the host's preview codec notice,
			// so wait for the inspector to show the new link instead.
			await expect(
				page.getByRole("button", { name: "Unlink audio/video" })
			).toBeVisible({ timeout: 60_000 });
		}

		await clipButton("0.00").click();
		const splitGroup = page.getByRole("group", { name: "Split edit" });
		await expect(splitGroup).toContainText("straight cut");
		await splitGroup.getByRole("button", { name: "L-cut" }).click();
		await expect(status).toContainText("L-cut applied · L +0.50s");
		await expect(
			// Each audio edge carries half of the 0.08s crossfade past the edit point.
			page.getByRole("button", { name: /split edit L \+0\.\d\ds/ }).first()
		).toBeVisible();

		await page.locator("body").press("Alt+J");
		await expect(status).toContainText("J-cut applied · J \u22120.50s");
		await saveProject(page);
		const jCut = await getSavedProject(page, projectId);
		const incomingVideo = jCut.segments.find(
			(segment) => segment.start === 3 && segment.volume === 0
		);
		const incomingAudio = jCut.segments.find(
			(segment) =>
				segment.linkGroupId === incomingVideo?.linkGroupId &&
				segment.id !== incomingVideo?.id
		);
		expect(incomingAudio?.start).toBeCloseTo(2.5, 1);
		expect(incomingAudio?.sourceIn).toBeCloseTo(0.5, 1);
		expect(incomingAudio?.start ?? 3).toBeLessThan(2.55);

		await page.locator("body").press("r");
		await expect(
			page.getByRole("button", { name: "Roll tool (R)" })
		).toHaveAttribute("aria-pressed", "true");
		await page.locator("body").press("v");
		await expect(
			page.getByRole("button", { name: "Pointer tool (V)" })
		).toHaveAttribute("aria-pressed", "true");

		await page.locator("body").press("Shift+Alt+J");
		await expect(
			page.getByRole("heading", { name: "Auto J/L cuts", exact: true })
		).toBeVisible();
		await page.getByRole("button", { name: "Analyze cuts" }).click();
		const proposals = page.getByRole("table", { name: "Proposed split edits" });
		await expect(proposals).toBeVisible({ timeout: 30_000 });
		await expect(proposals).toContainText("0:03.0");
		await saveScreenshot(page, "video-studio-split-edits.png");

		await clipButton("0.00").click();
		await page.locator("body").press("Delete");
		await saveProject(page);
		const afterDelete = await getSavedProject(page, projectId);
		expect(afterDelete.segments).toHaveLength(2);
		expect(
			afterDelete.segments.every(
				(segment) => segment.linkGroupId === incomingVideo?.linkGroupId
			)
		).toBe(true);

		await clipButton("3.00").click();
		await setField("Playhead", "4");
		await page
			.getByRole("button", { name: "Freeze frame at playhead" })
			.click();
		await expect
			.poll(
				async () => (await getSavedProject(page, projectId)).segments.length,
				{ timeout: 60_000 }
			)
			.toBe(5);
		await expect(
			page.getByRole("button", { name: /^Select .* freeze/ }).first()
		).toBeVisible();

		await openOverflowTab(page, "Cleanup", "cleanup");
		await page.getByRole("button", { name: "Find dead air" }).click();
		await expect(
			page
				.getByText(/No pauses longer than/)
				.or(page.getByRole("table", { name: "Pauses found" }))
		).toBeVisible();
		await openOverflowTab(page, "Highlights", "highlights");
		await page.getByRole("button", { name: "Find highlights" }).click();
		await expect(
			page
				.getByText(/No highlights fit those lengths/)
				.or(page.getByRole("list", { name: "Ranked highlights" }))
		).toBeVisible();
		await openOverflowTab(page, "Speed & beat", "tempo");
		await expect(
			page.getByRole("img", { name: /Montage speed curve/ })
		).toBeVisible();
		await saveScreenshot(page, "video-studio-freeze-cleanup-tempo.png");
		expect(pageErrors).toEqual([]);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});

test("Vector graphics color and bounded number inputs persist and update preview", async ({
	page,
}) => {
	const projectId = await createProject(
		page,
		uniqueTitle("Graphics interaction")
	);
	await openOverflowTab(page, "Vector graphics", "graphics");
	await page.getByRole("button", { name: "Add vector shape" }).click();
	await expect(page.getByText("Vector shape 1", { exact: true })).toBeVisible();

	const graphicKind = page.getByLabel("Vector shape 1 shape");
	await graphicKind.selectOption("triangle");
	const preview = page.locator(".studio-preview-frame .studio-graphic");
	await expect(preview).toHaveCSS(
		"clip-path",
		"polygon(50% 0%, 100% 100%, 0% 100%)"
	);

	const left = page.getByLabel("Graphic 1 Left");
	await left.fill("1.2");
	await left.press("Tab");
	await expect(left).toHaveValue("1");
	await left.fill("0.44 / 2");
	await left.press("Tab");
	await expect(left).toHaveValue("0.22");

	const strokeWidth = page.getByLabel("Vector shape 1 stroke width");
	await strokeWidth.fill("0.1");
	await strokeWidth.press("Tab");
	await expect(strokeWidth).toHaveValue("0.08");
	await strokeWidth.fill("0.025");
	await strokeWidth.press("Tab");
	await expect(strokeWidth).toHaveValue("0.025");

	await setColor(page, "Graphic 1 fill color", "#E74795");
	await expect(preview).toHaveCSS("background-color", "rgb(231, 71, 149)");
	await saveProject(page);
	const saved = await getSavedProject(page, projectId);
	expect(saved.graphics).toHaveLength(1);
	expect(saved.graphics[0]).toMatchObject({
		fill: "#E74795",
		shape: "triangle",
		strokeWidth: 0.025,
		x: 0.22,
	});
	await saveScreenshot(page, "video-studio-graphics-color-number-readback.png");
});

test("production recipe and layout save an editable project and render it locally", async ({
	page,
}) => {
	const requests = recordStudioRequests(page);
	const projectId = await createProject(page, uniqueTitle("Recipe and layout"));
	await importImage(page, "recipe-first.png");
	await importImage(page, "recipe-second.png");
	await openOverflowTab(page, "Recipes", "recipes");
	const applyRecipe = page.getByRole("button", { name: "Apply recipe" });
	await expect(applyRecipe).toBeDisabled();
	await page.getByLabel("Production recipe").selectOption("cinematic");
	await page
		.getByRole("button", { name: "recipe-first.png", exact: true })
		.click();
	await page
		.getByRole("button", { name: "recipe-second.png", exact: true })
		.click();
	await page.getByLabel("Recipe shot duration").fill("2.5");
	await page.getByLabel("Recipe title").fill("Two-shot local export");
	await page.getByLabel("Recipe format").selectOption("landscape");
	await expect(applyRecipe).toBeEnabled();
	await applyRecipe.click();
	await expect(page.getByRole("status")).toContainText(
		"Recipe applied and saved. Review the timeline before exporting."
	);
	const recipeRequest = requests.find(
		(request) => request.path === `/projects/${projectId}/recipe`
	);
	expect(recipeRequest).toMatchObject({
		method: "POST",
		body: {
			audioId: null,
			format: "landscape",
			kind: "cinematic",
			shotDuration: 2.5,
			title: "Two-shot local export",
		},
	});
	const recipeAssetIds = z
		.object({ assetIds: z.array(z.string()) })
		.parse(recipeRequest?.body).assetIds;
	expect(recipeAssetIds).toHaveLength(2);
	const recipeProject = await getSavedProject(page, projectId);
	expect(recipeProject.segments.map((segment) => segment.assetId)).toEqual(
		recipeAssetIds
	);
	const firstRecipePreview = page.getByRole("img", {
		name: "recipe-first.png",
		exact: true,
	});
	await expect(firstRecipePreview).toBeVisible();
	await expect
		.poll(() => firstRecipePreview.evaluate((image) => image.naturalWidth))
		.toBe(640);
	const secondRecipePreview = page.getByRole("img", {
		name: "recipe-second.png",
		exact: true,
	});
	await expect
		.poll(() => secondRecipePreview.evaluate((image) => image.naturalWidth))
		.toBe(640);
	expect(recipeProject.titles).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ text: "Two-shot local export" }),
		])
	);

	await openOverflowTab(page, "Layouts", "layouts");
	await page.getByLabel("Layout preset").selectOption("grid-2x2");
	await page
		.getByRole("button", { name: /recipe-first\.png · Track 1/ })
		.click();
	await page
		.getByRole("button", { name: /recipe-second\.png · Track 1/ })
		.click();
	const applyLayout = page.getByRole("button", { name: "Apply layout" });
	await expect(applyLayout).toBeEnabled();
	await applyLayout.click();
	await expect(page.getByRole("status")).toContainText(
		"grid-2x2 layout applied to 2 clips."
	);
	await saveProject(page);
	const layoutProject = await getSavedProject(page, projectId);
	expect(
		layoutProject.segments.map(({ scale, x, y }) => ({ scale, x, y }))
	).toEqual([
		{ scale: 0.5, x: -0.5, y: -0.5 },
		{ scale: 0.5, x: 0.5, y: -0.5 },
	]);
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("1");
	await playhead.press("Tab");
	const firstPreview = page.getByRole("img", {
		name: "recipe-first.png",
		exact: true,
	});
	await expect(firstPreview).toBeVisible();
	await expect
		.poll(() => firstPreview.evaluate((image) => image.naturalWidth))
		.toBe(640);
	await expect
		.poll(() =>
			firstPreview.evaluate((image) =>
				Number.parseFloat(getComputedStyle(image).opacity)
			)
		)
		.toBeGreaterThan(0.9);
	await saveScreenshot(page, "video-studio-recipe-layout-saved.png");
	await openOverflowTab(page, "Captions", "captions");
	const captionChooser = page.waitForEvent("filechooser");
	await page
		.getByRole("button", { exact: true, name: "Import SRT / VTT" })
		.click();
	await (await captionChooser).setFiles({
		name: "delivery.srt",
		mimeType: "application/x-subrip",
		buffer: Buffer.from(
			"1\n00:00:00,500 --> 00:00:02,000\nVerified subtitle delivery\n"
		),
	});
	await expect(page.locator(".studio-preview")).toContainText(
		"Verified subtitle delivery"
	);
	await saveProject(page);
	const captionedProject = await getSavedProject(page, projectId);
	expect(captionedProject.captions).toEqual([
		expect.objectContaining({
			start: 0.5,
			end: 2,
			text: "Verified subtitle delivery",
		}),
	]);

	await page.getByRole("button", { name: "Export video" }).click();
	await expect(
		page.getByRole("heading", { name: "Export history", exact: true })
	).toBeVisible();
	// Export history's download; the Export panel's queue also lists "Download version …".
	const downloadButton = page.getByRole("button", {
		name: /^Download (MP4|MOV)$/,
	});
	const retryButton = page.getByRole("button", { name: "Retry export" });
	await expect
		.poll(
			async () => (await downloadButton.count()) + (await retryButton.count()),
			{
				timeout: 60_000,
			}
		)
		.toBeGreaterThan(0);
	if (process.env.RYU_VIDEO_STUDIO_E2E_REQUIRE_BURN_IN === "1") {
		await expect(downloadButton).toBeVisible();
	}
	if (await downloadButton.isVisible()) {
		const downloadPromise = page.waitForEvent("download");
		await downloadButton.click();
		const download = await downloadPromise;
		const outputPath = await download.path();
		if (!outputPath) {
			throw new Error("Playwright did not preserve the rendered MP4.");
		}
		expect((await stat(outputPath)).size).toBeGreaterThan(10_000);
		await download.saveAs(
			path.join(evidenceDirectory, "video-studio-title-caption-delivery.mp4")
		);
		await execFileAsync("ffmpeg", [
			"-v",
			"error",
			"-i",
			outputPath,
			"-f",
			"null",
			"-",
		]);
		await execFileAsync("ffmpeg", [
			"-v",
			"error",
			"-ss",
			"1",
			"-i",
			outputPath,
			"-frames:v",
			"1",
			"-y",
			path.join(
				evidenceDirectory,
				"video-studio-title-caption-encoded-frame.png"
			),
		]);
		await expect(page.getByRole("status")).toContainText(
			"Rendered video downloaded."
		);
		await saveScreenshot(page, "video-studio-local-export-downloaded.png");
	} else {
		await expect(page.locator(".studio-status")).toContainText(
			"Render encode failed: FFmpeg is missing the subtitles filter (libass), required to render titles and captions. Install a full build."
		);
		await expect(retryButton).toBeEnabled();
		await saveScreenshot(
			page,
			"video-studio-export-ffmpeg-filter-boundary.png"
		);
	}
});

test("plain media export completes, downloads, and decodes with the installed renderer", async ({
	page,
}) => {
	await createProject(page, uniqueTitle("Local export delivery"));
	await importImage(page, "delivery-frame.png");
	await addToTimeline(page, "delivery-frame.png");
	await saveProject(page);
	await page.getByRole("button", { name: "Export video" }).click();
	// Export history's download; the Export panel's queue also lists "Download version …".
	const downloadButton = page.getByRole("button", {
		name: /^Download (MP4|MOV)$/,
	});
	await expect(downloadButton).toBeVisible({ timeout: 60_000 });
	const downloadPromise = page.waitForEvent("download");
	await downloadButton.click();
	const download = await downloadPromise;
	const outputPath = await download.path();
	if (!outputPath) {
		throw new Error("The completed export did not produce a local download.");
	}
	expect((await stat(outputPath)).size).toBeGreaterThan(10_000);
	const { stdout } = await execFileAsync("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"stream=codec_name,width,height:format=duration",
		"-of",
		"json",
		outputPath,
	]);
	const metadata = z
		.object({
			format: z.object({ duration: z.string() }),
			streams: z.array(
				z.object({
					codec_name: z.string(),
					width: z.number(),
					height: z.number(),
				})
			),
		})
		.parse(JSON.parse(stdout));
	expect(metadata.streams[0]?.codec_name).toBe("h264");
	expect(metadata.streams[0]?.width).toBeGreaterThan(0);
	expect(metadata.streams[0]?.height).toBeGreaterThan(0);
	expect(Number(metadata.format.duration)).toBeGreaterThanOrEqual(5);
	await execFileAsync("ffmpeg", [
		"-v",
		"error",
		"-i",
		outputPath,
		"-f",
		"null",
		"-",
	]);
	await expect(page.getByRole("status")).toContainText(
		"Rendered video downloaded."
	);
	await saveScreenshot(page, "video-studio-plain-export-delivery-verified.png");
});

test("mesh import rejects external glTF buffers and recovers with a local OBJ", async ({
	page,
}) => {
	const projectId = await createProject(page, uniqueTitle("Mesh import"));
	const externalRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().startsWith("https://example.test/")) {
			externalRequests.push(request.url());
		}
	});
	await openOverflowTab(page, "Meshes", "meshes");

	const invalidFileChooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import 3D mesh" }).click();
	await (await invalidFileChooser).setFiles({
		buffer: Buffer.from(
			JSON.stringify({
				asset: { version: "2.0" },
				buffers: [{ byteLength: 36, uri: "https://example.test/mesh.bin" }],
			})
		),
		mimeType: "model/gltf+json",
		name: "external-buffer.gltf",
	});
	await expect(page.getByRole("status")).toContainText(
		"External glTF buffers are not accepted."
	);
	expect(externalRequests).toEqual([]);
	await expect(page.getByText("Mesh 1", { exact: true })).toHaveCount(0);

	const validFileChooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import 3D mesh" }).click();
	await (await validFileChooser).setFiles({
		buffer: Buffer.from(
			"o Local triangle\nv -0.5 -0.5 0\nv 0.5 -0.5 0\nv 0 0.5 0\nf 1 2 3\n"
		),
		mimeType: "text/plain",
		name: "local-triangle.obj",
	});
	await expect(page.getByRole("status")).toContainText(
		"Imported local-triangle.obj as 1 editable mesh."
	);
	await expect(page.getByText("Mesh 1", { exact: true })).toBeVisible();
	await expect(
		page.getByText("3 vertices · 1 faces", { exact: true })
	).toBeVisible();
	const playhead = page.getByRole("spinbutton", { name: "Playhead" });
	await playhead.fill("0.5");
	await playhead.press("Tab");
	const meshPreview = page.locator(
		".studio-preview-frame svg[aria-label='Imported 3D mesh']"
	);
	await expect(meshPreview).toBeVisible();
	await expect(meshPreview.locator("polygon")).toHaveCount(1);
	await expect(meshPreview.locator("polygon")).toHaveAttribute(
		"fill",
		"#a855f7"
	);
	await saveProject(page);
	const saved = await getSavedProject(page, projectId);
	expect(saved.meshes).toHaveLength(1);
	expect(saved.meshes[0]).toMatchObject({
		faces: [[0, 1, 2]],
		vertices: [
			[-0.5, -0.5, 0],
			[0.5, -0.5, 0],
			[0, 0.5, 0],
		],
	});
	await saveScreenshot(page, "video-studio-mesh-local-import-readback.png");
});

test("Wave 1 editing surfaces render: tour, layout bar, track header, clip menu, markers, history, projects", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await createProject(page, uniqueTitle("Wave one surfaces"));
	const tour = page.getByRole("button", { name: "Skip tour" });
	await expect(tour).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Workspace layout" })
	).toBeVisible();
	await saveScreenshot(page, "video-studio-w1-workspace-tour.png");
	await tour.click();
	await expect(tour).toBeHidden();

	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w1-fixture-")
	);
	try {
		const videoPath = path.join(fixtureDirectory, "wave-one.mp4");
		await createSyntheticVideo(videoPath);
		await importVideo(page, videoPath, "wave-one.mp4");
		await addToTimeline(page, "wave-one.mp4");
		await addToTimeline(page, "wave-one.mp4");
		const second = page.getByRole("button", {
			name: "Select wave-one.mp4 at 4.00 seconds",
			exact: true,
		});
		await second.click();
		await page.keyboard.press("m");
		await second.click({ button: "right" });
		const split = page.locator('[data-menu-item="split"]');
		await expect(split).toBeVisible();
		await saveScreenshot(page, "video-studio-w1-clip-context-menu.png");
		await page.keyboard.press("Escape");
		await expect(split).toBeHidden();

		await openOverflowTab(page, "Markers", "markers");
		await expect(page.getByLabel("Marker status filter")).toBeVisible();
		await expect(
			page.getByRole("list", { name: "Timeline markers" }).getByRole("listitem")
		).toHaveCount(1);
		await saveScreenshot(page, "video-studio-w1-markers-panel.png");

		await openOverflowTab(page, "History", "history");
		await expect(page.getByText("Edits this session")).toBeVisible();
		await saveScreenshot(page, "video-studio-w1-history-panel.png");

		await openOverflowTab(page, "Projects", "projects");
		await expect(page.getByLabel("Search projects")).toBeVisible();
		await saveScreenshot(page, "video-studio-w1-projects-dashboard.png");
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
	expect(pageErrors).toEqual([]);
});

async function saveLibrarySection(page: Page, heading: string, name: string) {
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

test("parity W3 analysis, caption, title, and search panels render", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.setViewportSize({ height: 1400, width: 1440 });
	await createProject(page, uniqueTitle("Parity W3"));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w3-fixture-")
	);
	try {
		const videoPath = path.join(fixtureDirectory, "w3-interview.mp4");
		await createSyntheticVideo(videoPath);
		await importVideo(page, videoPath, "w3-interview.mp4");
		// Two audio-bearing clips unlock the sync drift and multicam controls.
		await addToTimeline(page, "w3-interview.mp4");
		await addToTimeline(page, "w3-interview.mp4");
		await saveProject(page);

		const shots = [
			[
				"Captions",
				"captions",
				"Caption style",
				"video-studio-w3-caption-style.png",
			],
			[
				"Transcript",
				"transcript",
				"Timeline transcript",
				"video-studio-w3-transcript-speakers.png",
			],
			[
				"Titles",
				"titles",
				"Text templates",
				"video-studio-w3-text-templates.png",
			],
			["Cleanup", "cleanup", "Dead air", "video-studio-w3-dead-air-vad.png"],
			[
				"Find footage",
				"search",
				"Find footage by look",
				"video-studio-w3-visual-search.png",
			],
			["Sync", "sync", "Sync clips", "video-studio-w3-sync-drift.png"],
			[
				"Multicam",
				"multicam",
				"Multicam sessions",
				"video-studio-w3-multicam.png",
			],
		] as const;
		for (const [label, value, heading, name] of shots) {
			await openOverflowTab(page, label, value);
			await saveLibrarySection(page, heading, name);
		}
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
	expect(pageErrors).toEqual([]);
});

test("the media library opens at the top at 1440 × 900 and the import notice clears after an edit", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await createProject(page, uniqueTitle("Library scroll"));
	const names = ["scroll-a.png", "scroll-b.png", "scroll-c.png"];
	for (const name of names) {
		await importImage(page, name);
	}
	// The import notice clears on the next timeline edit (adding the media).
	await expect(page.getByRole("status")).toContainText("Media imported.");
	await addToTimeline(page, "scroll-a.png");
	await expect(page.getByRole("status")).not.toContainText("Media imported.");

	// A first visit in a fresh browser profile (tour, stored layout and
	// library preferences all at their defaults), sampled from the first
	// paint while tiles and panels size themselves.
	const fresh = await page
		.context()
		.browser()
		?.newContext({
			viewport: { height: 900, width: 1440 },
		});
	const firstVisit = await fresh?.newPage();
	expect(firstVisit).toBeDefined();
	if (firstVisit) {
		await firstVisit.goto("/");
		const firstScrollTops: number[] = [];
		for (let sample = 0; sample < 12; sample++) {
			firstScrollTops.push(
				await firstVisit
					.locator("aside.studio-library")
					.evaluate((element) => element.scrollTop)
			);
			await firstVisit.waitForTimeout(150);
		}
		expect(firstScrollTops.every((value) => value === 0)).toBe(true);
		await fresh?.close();
	}
	await page.reload();
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	const library = page.locator("aside.studio-library");
	await expect(library).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add scroll-c.png to timeline" })
	).toBeVisible();
	const scrollTops: number[] = [];
	for (let sample = 0; sample < 6; sample++) {
		scrollTops.push(await library.evaluate((element) => element.scrollTop));
		await page.waitForTimeout(250);
	}
	expect(scrollTops).toEqual([0, 0, 0, 0, 0, 0]);
});
