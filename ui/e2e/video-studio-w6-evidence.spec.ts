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

// Closing-wave evidence: the surfaces added for the final audit gaps render
// in the real app against the real sidecar host (light, dark and phone width)
// and work: the drawn I/O range and Clear range, a custom canvas size, an
// agent save applied live as an undoable "Agent edit", the Generate panel's
// cost estimate and @ mentions, importing a font for a title, and the UI in
// the host language.

const evidenceDirectory = path.resolve(import.meta.dirname, "evidence");
const lobster = path.resolve(
	import.meta.dirname,
	"../../sidecar/assets/fonts/Lobster-Regular.ttf"
);

async function run(command: string, args: string[]) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-2000);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(stderr || `${command} exited with ${code}.`));
			}
		});
	});
}

async function createFixtures(directory: string) {
	const video = path.join(directory, "w6-clip.webm");
	const still = path.join(directory, "Hero shot.png");
	await run("ffmpeg", [
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
		video,
	]);
	await run("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180",
		"-frames:v",
		"1",
		"-y",
		still,
	]);
	return { still, video };
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
				`video-studio-w6-${name}-${variant.suffix}.png`
			),
		});
	}
	await page.setViewportSize({ height: 1000, width: 1440 });
	await setTheme(page, "light");
}

const librarySection = (page: Page, heading: string) =>
	page
		.locator(".studio-library section.ryu-app-section")
		.filter({ has: page.getByRole("heading", { exact: true, name: heading }) })
		.first();

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

async function settleAutosave(page: Page) {
	await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible({
		timeout: 15_000,
	});
	await expect(
		page.getByRole("button", { exact: true, name: "Save changes" })
	).toBeHidden();
}

async function newProjectWithClip(page: Page, video: string) {
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
	await (await chooser).setFiles(video);
	await expect(page.getByRole("status")).toContainText("Media imported.", {
		timeout: 30_000,
	});
	await page
		.getByRole("button", { name: "Add w6-clip.webm to timeline" })
		.click();
	const banner = page.getByRole("region", { name: "Media settings" });
	await expect(banner).toContainText("Media settings differ");
	await banner.getByRole("button", { name: "Keep project settings" }).click();
	await settleAutosave(page);
	return projectId;
}

test("closing-wave surfaces render in light, dark and narrow layouts and work", async ({
	page,
}) => {
	test.setTimeout(300_000);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w6-evidence-")
	);
	try {
		const fixtures = await createFixtures(fixtureDirectory);
		const projectId = await newProjectWithClip(page, fixtures.video);

		// I/O range: I at 0 s, two one-second steps, O. The range is drawn on
		// the timeline with draggable edges, and Clear range removes it.
		await focusEditor(page);
		await page.keyboard.press("i");
		await page.keyboard.press("Shift+ArrowRight");
		await page.keyboard.press("Shift+ArrowRight");
		await page.keyboard.press("o");
		const range = page.locator("[data-timeline-range]").first();
		await expect(range).toBeVisible();
		await expect(page.getByRole("slider", { name: "Range in" })).toBeVisible();
		await expect(page.getByRole("slider", { name: "Range out" })).toBeVisible();
		const clearRange = page.getByRole("button", { name: /Clear range/ });
		await expect(clearRange).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Score this range" })
		).toBeVisible();
		await captureVariants(page, "range", () =>
			page.locator(".studio-timeline")
		);
		await clearRange.click();
		await expect(page.locator("[data-timeline-range]")).toHaveCount(0);

		// Custom canvas size from Project settings (no clip selected).
		await page.keyboard.press("Escape");
		const format = page.getByRole("combobox", { name: "Output format" });
		await expect(format).toBeVisible();
		await format.selectOption({ label: "Custom size…" });
		const canvasWidth = page.getByLabel("Canvas width (px)");
		await canvasWidth.fill("1440");
		await canvasWidth.press("Enter");
		const canvasHeight = page.getByLabel("Canvas height (px)");
		await canvasHeight.fill("1080");
		await canvasHeight.press("Enter");
		await settleAutosave(page);
		await expect
			.poll(async () => {
				const saved = await savedProject(page, projectId);
				return `${saved.width}x${saved.height}`;
			})
			.toBe("1440x1080");
		await captureVariants(
			page,
			"canvas",
			() => page.locator(".studio-inspector"),
			async () => {
				await format.scrollIntoViewIfNeeded();
			}
		);

		// An agent (any client of the sidecar) saves a change; the editor
		// applies it live, and Undo reverts it.
		const before = await savedProject(page, projectId);
		const put = await page.request.put(`/__studio/projects/${projectId}`, {
			data: { ...before, title: "Renamed by the agent" },
		});
		expect(put.ok()).toBe(true);
		await expect(page.getByRole("status")).toContainText(
			"Applied an edit saved outside this editor",
			{ timeout: 15_000 }
		);
		await expect(page.getByLabel("Project", { exact: true })).toContainText(
			"Renamed by the agent"
		);
		await focusEditor(page);
		await page.keyboard.press("ControlOrMeta+z");
		await settleAutosave(page);
		await expect
			.poll(async () => (await savedProject(page, projectId)).title)
			.toBe(before.title);

		// Generate: the planning estimate and @ mentions of a library image.
		const stillChooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import media" }).click();
		await (await stillChooser).setFiles(fixtures.still);
		await expect(page.getByRole("status")).toContainText("Media imported.", {
			timeout: 30_000,
		});
		await openTab(page, "Generate", "generate");
		const generate = librarySection(page, "Generate with Ryu");
		await expect(generate.locator("[data-generation-cost]")).toContainText(
			"Planning estimate: $0.25 per image"
		);
		const direction = generate.getByRole("textbox", { name: "Direction" });
		await direction.fill("A poster featuring @He");
		await generate.getByRole("button", { name: "@Hero-shot" }).click();
		await expect(direction).toHaveValue("A poster featuring @Hero-shot ");
		await generate.getByRole("button", { name: "Save draft" }).click();
		await expect(
			generate.getByRole("combobox", { name: "Prompt drafts" })
		).toBeVisible();
		// The library column scrolls; capture it with the prompt tools in view.
		await captureVariants(
			page,
			"generate",
			() => page.locator(".studio-library"),
			async () => {
				await librarySection(page, "Generate with Ryu")
					.getByRole("button", { name: "Save draft" })
					.scrollIntoViewIfNeeded();
			}
		);

		// Import a font for a title.
		await openTab(page, "Titles", "titles");
		await page.getByRole("button", { name: "Add title" }).click();
		const styleToggle = page.locator("[data-title-style] summary").first();
		await styleToggle.click();
		const fontChooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import font…" }).first().click();
		await (await fontChooser).setFiles(lobster);
		await expect(page.getByText("Imported Lobster.")).toBeVisible({
			timeout: 15_000,
		});
		const imported = page
			.getByRole("combobox", { name: "Title 1 Imported or system font" })
			.first();
		await expect(imported.locator("option:checked")).toHaveText("Lobster");
		await settleAutosave(page);
		await expect
			.poll(
				async () =>
					(await savedProject(page, projectId)).titles[0]?.customFont?.family
			)
			.toBe("Lobster");
		await captureVariants(
			page,
			"imported-font",
			() => page.locator(".studio-library"),
			async () => {
				const details = page.locator("[data-title-style]").first();
				if (
					!(await details.evaluate((element) => element.hasAttribute("open")))
				) {
					await details.locator("summary").click();
				}
				await page
					.getByRole("combobox", { name: "Title 1 Imported or system font" })
					.first()
					.scrollIntoViewIfNeeded();
			}
		);
		expect(pageErrors).toEqual([]);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});

test.describe("in the host language", () => {
	test.use({ locale: "de-DE" });

	test("Video Studio copy follows a German host", async ({ page }) => {
		await page.goto("/");
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Neues Projekt" })
		).toBeVisible();
		await page.getByRole("button", { name: "Neues Projekt" }).click();
		await expect(page.getByRole("tab", { name: "Medien" })).toBeVisible();
		await expect(
			page.getByRole("toolbar", { name: "Timeline-Werkzeuge" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Video exportieren" })
		).toBeVisible();
		await captureVariants(page, "german", () => page.locator(".studio-app"));
	});
});
