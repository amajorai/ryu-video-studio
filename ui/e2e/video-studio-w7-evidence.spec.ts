import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	expect,
	type Locator,
	type Page,
	test,
} from "../../../../apps/desktop/node_modules/@playwright/test/index.mjs";
import { assetSchema, projectSchema } from "../../shared/project.ts";

// Reference-input AI evidence (G74, G78; the G46, G79, G80 and G86 controls
// render): the real app against the real sidecar, with the host's
// `media.video` and `media.audio` STUBBED in the page. The stubs return small
// FFmpeg-made files and record what the app sent, so this proves the request
// shape, the sidecar extracts and the placement, never a provider result.

const evidenceDirectory = path.resolve(import.meta.dirname, "evidence");

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
	const clip = path.join(directory, "w7-clip.webm");
	const edited = path.join(directory, "edited.mp4");
	const music = path.join(directory, "music.wav");
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
		"-c:v",
		"libvpx-vp9",
		"-deadline",
		"realtime",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"libopus",
		"-y",
		clip,
	]);
	// What the stubbed video model "returns": a 2 s clip.
	await run("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=c=0x2266ff:s=640x360:r=24:d=2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		"-y",
		edited,
	]);
	// What the stubbed music model "returns": 3 s of tone.
	await run("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=220:sample_rate=48000:duration=3",
		"-y",
		music,
	]);
	const dataUrl = async (file: string, mime: string) =>
		`data:${mime};base64,${(await readFile(file)).toString("base64")}`;
	return {
		clip,
		edited: await dataUrl(edited, "video/mp4"),
		music: await dataUrl(music, "audio/wav"),
	};
}

/** Add stubbed generation bridges to the page's `window.ryu` and log calls. */
async function installStubs(
	page: Page,
	media: { edited: string; music: string }
) {
	await page.evaluate(({ edited, music }) => {
		const calls: unknown[] = [];
		const target = window as unknown as {
			__w7Calls: unknown[];
			ryu: Record<string, unknown>;
		};
		target.__w7Calls = calls;
		const summary = (method: string, input: Record<string, unknown>) => ({
			duration_s: input.duration_s,
			input_video:
				typeof input.input_video === "string"
					? input.input_video.slice(0, 40)
					: undefined,
			input_video_length:
				typeof input.input_video === "string" ? input.input_video.length : 0,
			kind: input.kind,
			method,
			model: input.model,
			provider: input.provider,
			provider_input: input.provider_input,
		});
		target.ryu.host = {
			capabilities: async () => ({
				bridge: {
					"media.audio": true,
					"media.video.inputs": true,
					"model.vision": false,
				},
			}),
		};
		target.ryu.media = {
			audio: async (input: Record<string, unknown>) => {
				calls.push(summary("media.audio", input));
				return [{ mediaType: "audio/wav", url: music }];
			},
			video: async (input: Record<string, unknown>) => {
				calls.push(summary("media.video", input));
				return [{ mediaType: "video/mp4", url: edited }];
			},
		};
	}, media);
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
				`video-studio-w7-${name}-${variant.suffix}.png`
			),
		});
	}
	await page.setViewportSize({ height: 1000, width: 1440 });
	await setTheme(page, "light");
}

async function savedProject(page: Page, projectId: string) {
	const response = await page.request.get(
		`/__studio/projects/${encodeURIComponent(projectId)}`
	);
	expect(response.ok()).toBe(true);
	return projectSchema.parse(await response.json());
}

async function libraryAssets(page: Page) {
	const response = await page.request.get("/__studio/assets");
	expect(response.ok()).toBe(true);
	const body = (await response.json()) as { assets: unknown[] };
	return body.assets.map((asset) => assetSchema.parse(asset));
}

async function settleAutosave(page: Page) {
	await expect(page.locator('[data-autosave-status="saved"]')).toBeVisible({
		timeout: 15_000,
	});
}

test("reference-input AI controls send the right inputs to stubbed bridges and place results", async ({
	page,
}) => {
	test.setTimeout(300_000);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const fixtureDirectory = await mkdtemp(
		path.join(os.tmpdir(), "ryu-video-studio-w7-evidence-")
	);
	try {
		const fixtures = await createFixtures(fixtureDirectory);
		await page.goto("/");
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		await expect(page.getByRole("status")).toContainText(
			"Project library connected."
		);
		await installStubs(page, fixtures);
		await page.getByRole("button", { name: "New project" }).click();
		await expect(page.getByRole("status")).toContainText("Project created.");
		const projectId = await page
			.getByLabel("Project", { exact: true })
			.inputValue();
		const chooser = page.waitForEvent("filechooser");
		await page.getByRole("button", { name: "Import media" }).click();
		await (await chooser).setFiles(fixtures.clip);
		await expect(page.getByRole("status")).toContainText("Media imported.", {
			timeout: 30_000,
		});
		await page
			.getByRole("button", { name: "Add w7-clip.webm to timeline" })
			.click();
		const banner = page.getByRole("region", { name: "Media settings" });
		await expect(banner).toContainText("Media settings differ");
		await banner.getByRole("button", { name: "Keep project settings" }).click();
		await settleAutosave(page);

		// AI edit → Video: the clip goes to the stubbed media.video as a bounded
		// H.264 input_video with the preset field map; the result is a take.
		const clip = page.getByRole("button", { name: /Select w7-clip\.webm at/ });
		await clip.first().click();
		const inspector = page.locator(".studio-inspector");
		const direction = inspector.getByRole("textbox", {
			name: "AI video edit direction",
		});
		await direction.scrollIntoViewIfNeeded();
		await direction.fill("Turn the scene blue");
		await expect(
			inspector.getByRole("combobox", {
				name: "Video-to-video edit model preset",
			})
		).toHaveValue("fal:fal-ai/wan-vace-14b");
		await captureVariants(
			page,
			"ai-video-tools",
			() => inspector,
			async () => {
				await direction.scrollIntoViewIfNeeded();
			}
		);
		// Layout changes for the screenshots remount the inspector; fill last.
		await direction.fill("Turn the scene blue");
		// The status line is shared: headless Chromium cannot decode the H.264
		// take, so the preview's "could not be previewed" can replace the
		// success line at once. Record every status text and look for it there.
		await page.evaluate(() => {
			const seen: string[] = [];
			(window as unknown as { __w7Statuses: string[] }).__w7Statuses = seen;
			new MutationObserver(() => {
				for (const status of document.querySelectorAll('[role="status"]')) {
					const text = status.textContent ?? "";
					if (text && seen.at(-1) !== text) {
						seen.push(text);
					}
				}
			}).observe(document.body, {
				characterData: true,
				childList: true,
				subtree: true,
			});
		});
		await inspector.getByRole("button", { name: "AI edit → Video" }).click();
		await expect
			.poll(
				async () =>
					(
						(await page.evaluate(
							() =>
								(window as unknown as { __w7Statuses: string[] }).__w7Statuses
						)) as string[]
					).some((text) => text.includes("Placed the AI video edit as a take")),
				{ timeout: 60_000 }
			)
			.toBe(true);
		const videoCalls = (await page.evaluate(
			() => (window as unknown as { __w7Calls: unknown[] }).__w7Calls
		)) as Record<string, unknown>[];
		expect(videoCalls[0]).toMatchObject({
			input_video: expect.stringMatching(/^data:video\/mp4;base64,/),
			method: "media.video",
			model: "fal-ai/wan-vace-14b",
			provider: "fal",
			provider_input: { video_url: "$input_video" },
		});
		expect(Number(videoCalls[0]?.input_video_length)).toBeGreaterThan(1000);
		const edited = (await libraryAssets(page)).find(
			(asset) => asset.generation?.task === "v2v"
		);
		expect(edited?.derivation).toBe("ai-edit");
		expect(edited?.generation).toMatchObject({
			model: "fal-ai/wan-vace-14b",
			provider: "fal",
		});
		await expect
			.poll(async () =>
				(await savedProject(page, projectId)).segments.some(
					(segment) => segment.assetId === edited?.id
				)
			)
			.toBe(true);

		// Generate motion and AI matte render in the same inspector.
		await expect(
			inspector.getByRole("button", { name: "AI matte" })
		).toBeVisible();

		// Generated music: the stubbed media.audio gets kind music with the
		// duration mapped, and the sidecar fits the result.
		await openTab(page, "Media", "media");
		const source = page.getByRole("combobox", { name: "Music source" });
		await source.scrollIntoViewIfNeeded();
		await source.selectOption("generate");
		await expect(
			page.getByRole("combobox", { name: "Music model preset" })
		).toHaveValue("fal:fal-ai/stable-audio");
		await captureVariants(
			page,
			"generated-music",
			() => page.locator(".studio-library"),
			async () => {
				// Layout changes remount the panel, so the source is chosen again.
				await source.selectOption("generate");
				await page
					.getByRole("button", { name: "Generate music" })
					.scrollIntoViewIfNeeded();
			}
		);
		await source.selectOption("generate");
		await page.getByRole("button", { name: "Generate music" }).click();
		await expect(page.getByRole("status")).toContainText(
			"Generated music fitted to",
			{
				timeout: 60_000,
			}
		);
		const audioCall = (
			(await page.evaluate(
				() => (window as unknown as { __w7Calls: unknown[] }).__w7Calls
			)) as Record<string, unknown>[]
		).find((call) => call.method === "media.audio");
		expect(audioCall).toMatchObject({
			duration_s: 15,
			kind: "music",
			model: "fal-ai/stable-audio",
			provider_input: { seconds_total: "$duration_s" },
		});
		const fitted = (await libraryAssets(page)).filter(
			(asset) => asset.kind === "audio" && asset.generation?.task === "music"
		);
		expect(fitted.some((asset) => Math.abs(asset.duration - 3) < 0.1)).toBe(
			true
		);

		expect(pageErrors).toEqual([]);
	} finally {
		await rm(fixtureDirectory, { force: true, recursive: true });
	}
});
