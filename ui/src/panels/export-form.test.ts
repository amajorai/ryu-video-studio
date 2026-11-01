import { describe, expect, test } from "bun:test";
import { newProject, type Project } from "../../../shared/project.ts";
import { resolveRenderPlan } from "../../../shared/render-options.ts";
import {
	alphaApplies,
	capabilityGap,
	codecApplies,
	type ExportForm,
	exportFileName,
	exportOverridesOf,
	exportRequestOf,
	formContainer,
	initialExportForm,
	jobFileFormat,
	jobMetadata,
	outputResolutionChoiceOf,
	outputResolutionOptions,
	planSummary,
	previewExport,
	projectExportSettingsOf,
	withOutputResolution,
} from "./export-form.ts";

const project = (patch: Partial<Project> = {}): Project => ({
	...newProject("Launch"),
	width: 1920,
	height: 1080,
	fps: 30,
	...patch,
});
const range = { start: 2, end: 6 };
const form = (patch: Partial<ExportForm> = {}): ExportForm => ({
	...initialExportForm(),
	...patch,
});

describe("export form", () => {
	test("the initial form overrides nothing, so it matches a body-less render", () => {
		expect(initialExportForm()).toEqual({
			rangeOnly: false,
			saveAsAsset: false,
		});
		expect(exportRequestOf(project(), form(), range)).toEqual({});
		const stored = project({
			exportSettings: {
				container: "mp4",
				crf: 18,
				platformPreset: "youtube-1080p",
				rateControl: "crf",
			},
		});
		const request = exportRequestOf(stored, form(), range);
		expect(request).toEqual({});
		const panel = resolveRenderPlan(stored, request, { timelineDuration: 10 });
		const bodyless = resolveRenderPlan(stored, {}, { timelineDuration: 10 });
		expect(panel.settings).toEqual(bodyless.settings);
		expect(panel.settings).toMatchObject({ crf: 18, rateControl: "crf" });
	});
	test("the request carries range, codec, library and only relevant overrides", () => {
		expect(
			exportRequestOf(
				project(),
				form({
					bitrateKbps: 4000,
					codec: "h265",
					container: "mp4",
					crf: 18,
					gifFps: 10,
					outputWidth: 1280,
					rangeOnly: true,
					rateControl: "vbr",
					saveAsAsset: true,
				}),
				range,
				7
			)
		).toEqual({
			codec: "h265",
			overrides: { bitrateKbps: 4000, container: "mp4", rateControl: "vbr" },
			range: { start: 2, end: 6 },
			revision: 7,
			saveAsAsset: true,
		});
		expect(
			exportOverridesOf(
				form({
					alpha: true,
					container: "gif",
					gifFps: 10,
					gifWidth: 320,
					hdr: true,
					includeAudio: false,
					outputHeight: 720,
					outputWidth: 1280,
				}),
				"gif"
			)
		).toEqual({
			container: "gif",
			gifFps: 10,
			gifWidth: 320,
			hdr: "auto",
			outputHeight: 720,
			outputWidth: 1280,
		});
		expect(
			exportOverridesOf(
				form({ alpha: false, hdr: false, includeAudio: true }),
				"mov"
			)
		).toEqual({ alpha: false, hdr: "off", includeAudio: true });
	});
	test("toggles hidden for the chosen format are not sent", () => {
		const alphaThenMp4 = form({ alpha: true, container: "mp4" });
		expect(exportRequestOf(project(), alphaThenMp4, range)).toEqual({
			overrides: { container: "mp4" },
		});
		expect("plan" in previewExport(project(), alphaThenMp4, range, 10)).toBe(
			true
		);
		const silentThenWav = form({ container: "wav", includeAudio: false });
		expect(exportRequestOf(project(), silentThenWav, range)).toEqual({
			overrides: { container: "wav" },
		});
		expect("plan" in previewExport(project(), silentThenWav, range, 10)).toBe(
			true
		);
		// The project's own container decides when the form keeps the default.
		const movProject = project({ exportSettings: { container: "mov" } });
		expect(formContainer(movProject, form())).toBe("mov");
		expect(
			exportRequestOf(movProject, form({ alpha: true }), range).overrides
		).toEqual({ alpha: true });
		expect(formContainer(project(), form({ platformPreset: "nope" }))).toBe(
			"mp4"
		);
	});
	test("saving as the project default keeps stored values the form inherits", () => {
		const stored = project({
			exportSettings: {
				alpha: true,
				container: "mov",
				crf: 18,
				includeAudio: false,
				rateControl: "crf",
			},
		});
		expect(
			projectExportSettingsOf(stored, form({ encoderPreset: "slow" }))
		).toEqual({
			alpha: true,
			container: "mov",
			crf: 18,
			encoderPreset: "slow",
			includeAudio: false,
			rateControl: "crf",
		});
		expect(
			projectExportSettingsOf(stored, form({ alpha: true, container: "wav" }))
		).toEqual({ container: "wav", crf: 18, rateControl: "crf" });
	});
	test("the preview resolves the plan or explains the problem", () => {
		const ok = previewExport(project(), form({ rangeOnly: true }), range, 10);
		expect("plan" in ok && ok.plan.duration).toBe(4);
		expect(
			previewExport(
				project(),
				form({ rangeOnly: true }),
				{ start: 3, end: 3 },
				10
			)
		).toEqual({
			error: "Set an In point before the Out point to export a range.",
		});
		expect(previewExport(project(), form(), range, 0)).toEqual({
			error: "Add media, graphics, or an avatar before exporting.",
		});
		expect(
			previewExport(
				project(),
				form({ container: "gif", saveAsAsset: true }),
				range,
				10
			)
		).toEqual({
			error: "Only video and audio exports can be saved to the library.",
		});
	});
	test("capability gaps name the missing encoders", () => {
		const plan = resolveRenderPlan(
			project(),
			{ codec: "h265-10bit" },
			{ timelineDuration: 4 }
		);
		expect(capabilityGap(plan, undefined)).toBeUndefined();
		expect(
			capabilityGap(plan, {
				encoders: { aac: true, libx265: true },
				renderer: true,
				x265TenBit: false,
			})
		).toBe("Requires an FFmpeg build with libx265 (10-bit).");
		const webm = resolveRenderPlan(
			project(),
			{ codec: "vp9" },
			{ timelineDuration: 4 }
		);
		expect(
			capabilityGap(webm, {
				encoders: { "libvpx-vp9": false, libopus: false },
				renderer: true,
				x265TenBit: true,
			})
		).toBe("Requires an FFmpeg build with libopus, libvpx-vp9.");
		expect(
			capabilityGap(webm, { encoders: {}, renderer: false, x265TenBit: false })
		).toBeUndefined();
	});
	test("picker applicability", () => {
		expect(codecApplies("mp4")).toBe(true);
		expect(codecApplies("webm")).toBe(false);
		expect(alphaApplies("png-sequence")).toBe(true);
		expect(alphaApplies("jpeg-sequence")).toBe(false);
	});
});

describe("downloads", () => {
	test("job formats come from the export summary, else the legacy codec", () => {
		expect(jobFileFormat({ codec: "h264" }).extension).toBe("mp4");
		expect(jobFileFormat({ codec: "prores" }).extension).toBe("mov");
		const exported = {
			codec: "vp9",
			export: {
				alpha: false,
				container: "webm",
				duration: 2,
				extension: "webm",
				height: 1080,
				includeAudio: true,
				kind: "video",
				label: "WebM",
				metadata: "Title: Launch\n",
				mime: "video/webm",
				warnings: [],
				width: 1920,
			},
		};
		expect(jobFileFormat(exported)).toEqual({
			extension: "webm",
			label: "WebM",
			mime: "video/webm",
		});
		expect(jobMetadata(exported)).toBe("Title: Launch\n");
		expect(jobMetadata({ codec: "h264" })).toBeUndefined();
	});
	test("file names are safe and carry the range", () => {
		const format = { extension: "gif", label: "GIF", mime: "image/gif" };
		expect(exportFileName('My: "cut"/v2', format)).toBe("My- -cut-v2.gif");
		expect(exportFileName("  ", format)).toBe("export.gif");
		expect(exportFileName("Clip", format, { start: 1, end: 2.25 })).toBe(
			"Clip 1.0-2.3s.gif"
		);
	});
	test("plan summaries", () => {
		const plan = resolveRenderPlan(
			project(),
			{ overrides: { container: "mov", alpha: true } },
			{ timelineDuration: 4 }
		);
		expect(planSummary(plan)).toBe(
			"MOV · ProRes 4444 · 1920 × 1080 · 4.0 s · with audio · transparent"
		);
		expect(
			planSummary(
				resolveRenderPlan(
					project(),
					{ audioOnly: true },
					{ timelineDuration: 4 }
				)
			)
		).toBe("WAV · 4.0 s");
	});
});

describe("output resolution", () => {
	test("16:9: tiers fill the standard sizes and post them as overrides", () => {
		const canvas = project();
		const chosen = withOutputResolution(canvas, form(), "2k");
		expect(chosen).toMatchObject({ outputWidth: 2560, outputHeight: 1440 });
		expect(outputResolutionChoiceOf(canvas, chosen)).toBe("2k");
		expect(exportRequestOf(canvas, chosen, range).overrides).toEqual({
			outputWidth: 2560,
			outputHeight: 1440,
		});
		const preview = previewExport(canvas, chosen, range, 10);
		expect("plan" in preview && preview.plan.output).toEqual({
			width: 2560,
			height: 1440,
		});
	});

	test("9:16: the short side is the width", () => {
		const canvas = project({ width: 1080, height: 1920 });
		expect(withOutputResolution(canvas, form(), "720p")).toMatchObject({
			outputWidth: 720,
			outputHeight: 1280,
		});
		expect(withOutputResolution(canvas, form(), "4k")).toMatchObject({
			outputWidth: 2160,
			outputHeight: 3840,
		});
	});

	test("odd custom canvases keep the aspect with even sizes", () => {
		const canvas = project({ width: 1000, height: 618 });
		const chosen = withOutputResolution(canvas, form(), "1080p");
		expect(chosen).toMatchObject({ outputWidth: 1748, outputHeight: 1080 });
		const preview = previewExport(canvas, chosen, range, 10);
		expect(
			"plan" in preview &&
				preview.plan.warnings.some((warning) => warning.includes("letterbox"))
		).toBe(false);
		const fourFive = project({ width: 1080, height: 1350 });
		expect(
			outputResolutionOptions(fourFive).map((option) => option.label)
		).toEqual([
			"720p · 720 × 900",
			"1080p · 1080 × 1350",
			"2K (1440p) · 1440 × 1800",
			"4K (2160p) · 2160 × 2700",
		]);
	});

	test("Match timeline clears the size and Custom keeps editable fields", () => {
		const canvas = project();
		const tiered = withOutputResolution(canvas, form(), "4k");
		const matched = withOutputResolution(canvas, tiered, "");
		expect(matched.outputWidth).toBeUndefined();
		expect(matched.outputHeight).toBeUndefined();
		expect(outputResolutionChoiceOf(canvas, matched)).toBe("");
		expect(exportRequestOf(canvas, matched, range)).toEqual({});
		const custom = withOutputResolution(canvas, tiered, "custom");
		expect(custom).toMatchObject({
			customOutputSize: true,
			outputWidth: 3840,
			outputHeight: 2160,
		});
		expect(outputResolutionChoiceOf(canvas, custom)).toBe("custom");
		expect(exportOverridesOf(custom, "mp4")).toEqual({
			outputWidth: 3840,
			outputHeight: 2160,
		});
		const fresh = withOutputResolution(canvas, form(), "custom", {
			width: 1080,
			height: 1920,
		});
		expect(fresh).toMatchObject({ outputWidth: 1080, outputHeight: 1920 });
		expect(
			outputResolutionChoiceOf(
				canvas,
				form({ outputWidth: 640, outputHeight: 640 })
			)
		).toBe("custom");
	});

	test("tiers past the frame limit are disabled", () => {
		const wide = project({ width: 8192, height: 1024 });
		expect(
			outputResolutionOptions(wide).map((option) => option.disabled)
		).toEqual([false, true, true, true]);
	});
});
