import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	expect,
	type Locator,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";
import { projectSchema } from "../../shared/project.ts";

// W5-I2 evidence: every surface mounted in the final integration renders in
// the real app against the real sidecar host (light, dark and phone width),
// and its interaction works: the media mismatch banner, autosave, the
// shortcuts dialog with a persisted rebind, the timeline action toolbar
// (razor, snapping magnet), Ask agent, the relink dialog, AI gap fill in the
// clip inspector, AutoCut and shorts in Highlights, auto reframe, motion
// tracking with its region drawn on the preview, the preview toolbar and a
// transition dropped on a cut.

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

async function setTheme(page: Page, theme: "dark" | "light") {
	await page.emulateMedia({ colorScheme: theme });
	await page.evaluate((dark) => {
		const root = document.documentElement;
		root.classList.toggle("dark", dark);
		root.style.colorScheme = dark ? "dark" : "light";
	}, theme === "dark");
}

const VARIANTS = [
	{ suffix: "light", theme: "light", width: 1440 },
	{ suffix: "dark", theme: "dark", width: 1440 },
	{ suffix: "narrow", theme: "light", width: 390 },
] as const;

/**
 * Screenshot `target` in light and dark at desktop width and at phone width
 * (where the page must not scroll sideways), then restore desktop light.
 */
async function captureVariants(
	page: Page,
	name: string,
	target: () => Locator,
	prepare?: () => Promise<void>
) {
	await mkdir(evidenceDirectory, { recursive: true });
	for (const variant of VARIANTS) {
		await page.setViewportSize({ height: 1000, width: variant.width });
		await setTheme(page, variant.theme);
		await prepare?.();
		const locator = target();
		await expect(locator).toBeVisible();
		await locator.scrollIntoViewIfNeeded();
		if (variant.width < 600) {
			expect(
				await page.evaluate(
					() =>
						document.documentElement.scrollWidth <=
						document.documentElement.clientWidth
				)
			).toBe(true);
		}
		await locator.screenshot({
			animations: "disabled",
			path: path.join(
				evidenceDirectory,
				`video-studio-w5-${name}-${variant.suffix}.png`
			),
		});
	}
	await page.setViewportSize({ height: 1000, width: 1440 });
	await setTheme(page, "light");
}

/** Section of the library column with this heading. */
const librarySection = (page: Page, heading: string) =>
	page
		.locator(".studio-library section.ryu-app-section")
		.filter({ has: page.getByRole("heading", { exact: true, name: heading }) })
		.first();

/** Focus the stage heading so editor shortcuts reach the window. */
async function focusEditor(page: Page) {
	await page.locator(".studio-stage-heading").click();
}

async function savedProject(page: Page, projectId: string) {
	const response = await page.request.get(
		`/__studio/projects/${encodeURIComponent(projectId)}`
	);
	expect(response.ok()).toBe(true);
	return projectSchema.parse(await response.json());
}

/**
 * Wait until autosave has written every pending edit: the chip reads Saved
 * and the Save button (shown only while edits are pending) is gone.
 */
async function settleAutosave(page: Page) {
	await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible({
		timeout: 15_000,
	});
	await expect(
		page.getByRole("button", { exact: true, name: "Save changes" })
	).toBeHidden();
}

/** Width and right edge of `locator`, which must be laid out. */
async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) {
		throw new Error("Element is not laid out.");
	}
	return { right: box.x + box.width, width: box.width };
}

/**
 * At laptop and tablet sizes the timeline keeps a visible track row, a
 * usable Playhead field and zoom select inside the viewport, and every edit
 * tool reachable (the tools row scrolls sideways instead of wrapping).
 */
async function expectTimelineFits(page: Page, width: number, height: number) {
	await page.setViewportSize({ height, width });
	const toolbar = page.locator(".studio-timeline-toolbar");
	const playhead = toolbar.getByLabel("Playhead", { exact: true });
	const zoom = toolbar.getByRole("combobox", { name: "Timeline zoom" });
	await expect(playhead).toBeVisible();
	const playheadBox = await boxOf(playhead);
	expect(playheadBox.width).toBeGreaterThanOrEqual(80);
	expect(playheadBox.right).toBeLessThanOrEqual(width);
	const zoomBox = await boxOf(zoom);
	expect(zoomBox.width).toBeGreaterThanOrEqual(120);
	expect(zoomBox.right).toBeLessThanOrEqual(width);
	expect(
		await zoom.evaluate((select) => select.scrollWidth)
	).toBeLessThanOrEqual(
		await zoom.evaluate((select) => select.clientWidth + 1)
	);
	// The tools stay on one row, so the toolbar leaves the panel for tracks;
	// the first track row scrolls into view inside the timeline panel.
	expect((await toolbar.boundingBox())?.height ?? 999).toBeLessThanOrEqual(96);
	const track = page.locator(".studio-track").first();
	await track.scrollIntoViewIfNeeded();
	const visibleTrack = await track.evaluate((row) => {
		const panel = row.closest(".studio-timeline");
		if (!panel) {
			return 0;
		}
		const outer = panel.getBoundingClientRect();
		const inner = row.getBoundingClientRect();
		const top = Math.max(outer.top, inner.top, 0);
		const bottom = Math.min(outer.bottom, inner.bottom, window.innerHeight);
		return bottom - top;
	});
	expect(visibleTrack).toBeGreaterThanOrEqual(24);
	const addMarker = toolbar.getByRole("button", { name: "Add marker" });
	await addMarker.scrollIntoViewIfNeeded();
	const markerBox = await boxOf(addMarker);
	expect(markerBox.right).toBeLessThanOrEqual(width);
	expect(
		await page.evaluate(
			() =>
				document.documentElement.scrollWidth <=
				document.documentElement.clientWidth
		)
	).toBe(true);
}

/** Drop a gallery transition onto the cut at the left edge of `clip`. */
async function dropTransitionOnCut(clip: Locator, type: string) {
	await clip.evaluate((element, transition) => {
		const box = element.getBoundingClientRect();
		const transfer = new DataTransfer();
		transfer.setData("application/x-ryu-video-transition", transition);
		const init = {
			bubbles: true,
			cancelable: true,
			clientX: box.left + 1,
			clientY: box.top + box.height / 2,
			dataTransfer: transfer,
		};
		element.dispatchEvent(new DragEvent("dragover", init));
		element.dispatchEvent(new DragEvent("drop", init));
	}, type);
}

test("W5 mounted surfaces render in light, dark and narrow layouts and work", async ({
	page,
}) => {
	test.setTimeout(300_000);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w5-evidence-")
	);
	const videoPath = path.join(fixtureDirectory, "w5-clip.webm");
	try {
		await createSyntheticVideo(videoPath);
		await page.goto("/");
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await expect(page.getByRole("status")).toContainText(
			"Project library connected."
		);
		await page.getByRole("button", { name: "New project" }).click();
		await expect(page.getByRole("status")).toContainText("Project created.");
		const projectId = await page
			.getByLabel("Project", { exact: true })
			.inputValue();

		const chooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import media" }).click();
		await (await chooser).setFiles(videoPath);
		await expect(page.getByRole("status")).toContainText("Media imported.", {
			timeout: 30_000,
		});
		await page
			.getByRole("button", { name: "Add w5-clip.webm to timeline" })
			.click();

		// The first clip differs from the 1920×1080 canvas, so the global
		// media mismatch banner appears under the toolbar and project tabs.
		const banner = page.getByRole("region", { name: "Media settings" });
		await expect(banner).toContainText("Media settings differ");
		await expect(
			page.getByRole("navigation", { name: "Open projects" })
		).toBeVisible();
		await captureVariants(page, "toolbar-banner", () =>
			page.locator(".studio-app")
		);
		await banner.getByRole("button", { name: "Keep project settings" }).click();
		await expect(banner).toBeHidden();

		// Autosave writes the edit without pressing Save.
		await settleAutosave(page);
		await expect
			.poll(async () => (await savedProject(page, projectId)).segments.length)
			.toBe(1);

		// A second clip makes a cut for gap fill and the transition drop.
		await page
			.getByRole("button", { name: "Add w5-clip.webm to timeline" })
			.click();
		const clips = page.getByRole("button", { name: /Select w5-clip\.webm at/ });
		await expect(clips).toHaveCount(2);

		// Timeline action toolbar: C picks the razor, N toggles the magnet.
		const tools = page.getByRole("toolbar", { name: "Timeline tools" });
		await focusEditor(page);
		await page.keyboard.press("c");
		await expect(
			tools.getByRole("button", { name: "Razor tool" })
		).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.press("v");
		const magnet = tools.getByRole("button", { name: "Snapping" });
		await expect(magnet).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.press("n");
		await expect(page.getByRole("status")).toContainText("Snapping off.");
		await expect(magnet).toHaveAttribute("aria-pressed", "false");
		await magnet.click();
		await expect(magnet).toHaveAttribute("aria-pressed", "true");
		await captureVariants(page, "timeline-toolbar", () =>
			page.locator(".studio-timeline-toolbar")
		);
		await expectTimelineFits(page, 1440, 1000);
		await expectTimelineFits(page, 1024, 768);
		await expectTimelineFits(page, 768, 900);
		await page.setViewportSize({ height: 1000, width: 1440 });

		// Q ripple-trims the second clip's start to the playhead, which leaves
		// it media before its in point for a transition to overlap.
		await clips.nth(1).click();
		const playhead = page
			.locator(".studio-timeline-toolbar")
			.getByLabel("Playhead", { exact: true });
		await playhead.fill("5");
		await playhead.press("Enter");
		await focusEditor(page);
		await page.keyboard.press("q");
		await expect
			.poll(async () =>
				Number(
					(await clips.nth(1).getAttribute("aria-label"))?.match(
						/at ([\d.]+) seconds/
					)?.[1]
				)
			)
			.toBeCloseTo(4, 1);

		// AI gap fill in the clip inspector; without an image bridge the
		// action explains itself instead of failing.
		await clips.first().click();
		const gapFill = page
			.locator(".studio-inspector")
			.getByText("AI transition", { exact: true });
		await expect(gapFill).toBeVisible();
		await captureVariants(
			page,
			"gap-fill",
			() => page.locator(".studio-inspector"),
			async () => {
				await gapFill.scrollIntoViewIfNeeded();
			}
		);

		// A transition dropped on the cut sets the incoming clip's reveal.
		await dropTransitionOnCut(clips.nth(1), "wipe-left");
		await expect(page.getByRole("status")).toContainText("added to the cut.");

		// Shortcuts dialog: lists every action and keeps a rebind.
		await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
		const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
		await expect(shortcuts).toContainText("Export range");
		await captureVariants(page, "shortcuts-dialog", () => shortcuts);
		await shortcuts
			.getByRole("searchbox", { name: "Search shortcuts" })
			.fill("Snapping");
		await shortcuts
			.getByRole("button", { name: "Change shortcut for Snapping" })
			.click();
		await page.keyboard.press("g");
		await expect(
			shortcuts.getByRole("button", { name: "Reset Snapping to its default" })
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(shortcuts).toBeHidden();
		await focusEditor(page);
		await page.keyboard.press("g");
		await expect(page.getByRole("status")).toContainText("Snapping off.");
		await settleAutosave(page);
		await page.reload();
		await expect(page.getByRole("status")).toContainText(
			"Project library connected."
		);
		await page.getByLabel("Project", { exact: true }).selectOption(projectId);
		await focusEditor(page);
		await page.keyboard.press("g");
		await expect(page.getByRole("status")).toContainText("Snapping off.");

		// Ask agent: Alt+A opens the handoff; this host grants no chat access.
		await page.keyboard.press("Alt+a");
		const agent = page.getByRole("dialog", { name: "Ask agent" });
		await expect(agent).toContainText("Ask agent needs chat access.");
		await captureVariants(page, "ask-agent", () => agent);
		await page.keyboard.press("Escape");
		await expect(agent).toBeHidden();

		// Relink offline media from the Media tab.
		await openTab(page, "Media", "media");
		await page.getByRole("button", { name: /^Relink offline media/ }).click();
		const relink = page.getByRole("dialog", { name: "Relink offline media" });
		await expect(relink).toBeVisible();
		// The phone-width layout remounts the library column, so reopen.
		await captureVariants(
			page,
			"relink-dialog",
			() => relink,
			async () => {
				if (!(await relink.isVisible())) {
					await page
						.getByRole("button", { name: /^Relink offline media/ })
						.click();
				}
			}
		);
		await page.keyboard.press("Escape");
		await expect(relink).toBeHidden();

		// AutoCut and shorts in Highlights; auto reframe in Layouts.
		await openTab(page, "Highlights", "highlights");
		await captureVariants(
			page,
			"autocut",
			() => librarySection(page, "AutoCut"),
			async () => {
				await librarySection(page, "AutoCut").scrollIntoViewIfNeeded();
			}
		);
		await captureVariants(page, "vertical-shorts", () =>
			librarySection(page, "Vertical shorts")
		);
		await openTab(page, "Layouts", "layouts");
		await captureVariants(page, "reframe", () =>
			librarySection(page, "Auto reframe")
		);

		// Motion tracking: draw the region on the preview over the subject.
		await clips.first().click();
		await openTab(page, "Vector graphics", "graphics");
		const tracking = librarySection(page, "Motion tracking");
		await tracking
			.getByRole("button", { name: "Draw region on preview" })
			.click();
		const frame = page.locator(".studio-preview-frame");
		const box = await frame.boundingBox();
		if (!box) {
			throw new Error("The preview frame is not visible.");
		}
		await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.6, {
			steps: 6,
		});
		await page.mouse.up();
		const region = page.getByTestId("preview-tracking-region");
		await expect(region).toBeVisible();
		await expect(tracking.getByLabel("Left (%)")).toHaveValue("10");
		await expect(tracking.getByLabel("Width (%)")).toHaveValue("30");
		await captureVariants(page, "tracking-region", () =>
			page.locator(".studio-stage")
		);
		await captureVariants(page, "tracking-panel", () => tracking);

		// Preview toolbar: playback rate, quality and the proxies toggle.
		const previewTools = page.getByRole("toolbar", {
			name: "Preview controls",
		});
		await expect(
			previewTools.getByRole("combobox", { name: "Playback rate" })
		).toBeVisible();
		await expect(
			previewTools.getByRole("combobox", { name: "Preview quality" })
		).toBeVisible();
		await previewTools.getByRole("button", { name: "Use proxies" }).click();
		await expect(
			previewTools.getByRole("button", { name: "Use proxies" })
		).toHaveAttribute("aria-pressed", "true");
		await captureVariants(page, "preview-toolbar", () => previewTools);

		const saved = await savedProject(page, projectId);
		expect(saved.segments.some((segment) => segment.transitionIn)).toBe(true);

		// One Saved indicator: the chip. The Save button shows only while
		// edits are pending, and secondary actions fold into a menu on phones.
		await settleAutosave(page);
		const appToolbar = page.locator(".studio-toolbar");
		await expect(appToolbar.getByText("Saved", { exact: true })).toHaveCount(1);
		await page.setViewportSize({ height: 900, width: 390 });
		await expect(
			appToolbar.getByRole("button", { name: "More actions" })
		).toBeVisible();
		await expect(
			appToolbar.getByRole("button", { name: "Capture frame" })
		).toBeHidden();
		expect((await appToolbar.boundingBox())?.height ?? 999).toBeLessThan(160);
		await page.setViewportSize({ height: 1000, width: 1440 });

		// A save from elsewhere is three-way merged with unsaved local edits,
		// and only an overlapping change pauses autosave. The real host
		// resolves a 409 with its error body; this test host's bridge throws
		// instead, so the 409 is passed through as a 200 carrying the
		// CONFLICT body.
		//
		// The editor adopts external revisions while it has nothing unsaved
		// (`useRevisionWatch` polls every 2 s), so each local edit is made
		// first and its autosave is held until the external save lands;
		// otherwise a poll between the two adopts the external change and
		// no merge happens.
		let releaseEditorSave: () => void = () => undefined;
		let externalSaved = Promise.resolve();
		const holdEditorSave = () => {
			externalSaved = new Promise<void>((resolve) => {
				releaseEditorSave = resolve;
			});
		};
		const saveElsewhere = async (
			change: (project: Awaited<ReturnType<typeof savedProject>>) => object
		) => {
			const external = await page.request.put(
				`/__studio/projects/${encodeURIComponent(projectId)}`,
				{ data: change(await savedProject(page, projectId)) }
			);
			expect(external.ok()).toBe(true);
			releaseEditorSave();
		};
		await page.route("**/__studio/projects/*", async (route) => {
			if (route.request().method() === "PUT") {
				await externalSaved;
			}
			const response = await route.fetch();
			if (response.status() === 409) {
				await route.fulfill({
					body: await response.text(),
					contentType: "application/json",
					status: 200,
				});
				return;
			}
			await route.fulfill({ response });
		});
		const unsavedOrSaving = page.locator(
			'[data-autosave-status="unsaved"], [data-autosave-status="saving"]'
		);

		// A change that does not overlap the local edit merges: the local
		// duplicate and the external title both reach the saved project.
		const clipCountBefore = (await savedProject(page, projectId)).segments
			.length;
		holdEditorSave();
		await clips.first().click();
		await focusEditor(page);
		await page.keyboard.press("d");
		await expect(unsavedOrSaving).toBeVisible();
		await saveElsewhere((project) => ({
			...project,
			title: "Changed elsewhere",
		}));
		await expect
			.poll(
				async () => {
					const project = await savedProject(page, projectId);
					return [project.title, project.segments.length];
				},
				{ timeout: 15_000 }
			)
			.toEqual(["Changed elsewhere", clipCountBefore + 1]);
		await settleAutosave(page);
		await expect(page.locator("[data-autosave-conflict]")).toHaveCount(0);

		// Deleting a clip locally while it was edited elsewhere overlaps, so
		// autosave pauses behind the "Changed elsewhere" banner.
		holdEditorSave();
		await clips.first().click();
		await focusEditor(page);
		await page.keyboard.press("Delete");
		await expect(unsavedOrSaving).toBeVisible();
		await saveElsewhere((project) => ({
			...project,
			segments: project.segments.map((segment) => ({
				...segment,
				opacity: 0.5,
			})),
		}));
		await expect(page.locator('[data-autosave-status="conflict"]')).toBeVisible(
			{ timeout: 15_000 }
		);
		const conflict = page.locator("[data-autosave-conflict]");
		await expect(conflict).toContainText("autosave paused");
		// The notice is a full-width banner, not part of the toolbar row.
		await expect(appToolbar.locator("[data-autosave-conflict]")).toHaveCount(0);
		const toolbarHeight = (await appToolbar.boundingBox())?.height ?? 999;
		expect(toolbarHeight).toBeLessThan(100);
		await captureVariants(page, "autosave-conflict", () =>
			page.locator(".studio-app")
		);
		await page.setViewportSize({ height: 900, width: 390 });
		const narrowConflict = await conflict.boundingBox();
		expect(narrowConflict?.width ?? 0).toBeGreaterThan(300);
		await page.setViewportSize({ height: 1000, width: 1440 });
		await conflict.getByRole("button", { name: "Reload project" }).click();
		await expect(conflict).toBeHidden();
		await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible();
		await page.unroute("**/__studio/projects/*");
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
	expect(pageErrors).toEqual([]);
});

test("W2 sticker, record, mixer and export controls respond in the app", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");

	// Stickers: searching narrows the catalog to matching stickers.
	await openTab(page, "Stickers", "stickers");
	const stickers = page.getByRole("list", { name: "Stickers" });
	const all = await stickers.getByRole("button").count();
	await page.getByLabel("Search stickers").fill("heart");
	await expect
		.poll(async () => await stickers.getByRole("button").count())
		.toBeLessThan(all);
	await expect(
		stickers.getByRole("button", { name: /heart/i }).first()
	).toBeVisible();

	// Record: this host grants no microphone, and the panel says so.
	await openTab(page, "Record", "record");
	const recordVoiceover = page.getByRole("button", {
		name: "Record voiceover",
	});
	if (await recordVoiceover.isVisible().catch(() => false)) {
		await recordVoiceover.click();
	}
	await expect(
		page.getByText(/has not granted Video Studio microphone capture/)
	).toBeVisible();

	// Mixer: the scrub-audio switch flips and stays per viewer.
	await openTab(page, "Mixer", "mixer");
	const scrub = page.getByRole("switch", {
		name: "Play audio while scrubbing",
	});
	const before = await scrub.getAttribute("aria-checked");
	await scrub.click();
	await expect(scrub).not.toHaveAttribute("aria-checked", before ?? "");

	// Export: choosing a format replaces the project default.
	await openTab(page, "Exports", "exports");
	const format = page.getByLabel("Export format");
	await format.scrollIntoViewIfNeeded();
	await expect(format).toHaveValue("");
	await format.selectOption({ index: 2 });
	await expect(format).not.toHaveValue("");
	expect(pageErrors).toEqual([]);
});
