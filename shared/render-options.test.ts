import { describe, expect, test } from "bun:test";
import { newProject, type Project } from "./project.ts";
import {
	defaultBitrateKbps,
	EXPORT_FILE_FORMATS,
	exportJobOutputOf,
	exportKindOf,
	exportOverridesSchema,
	exportSupportsAlpha,
	importableExport,
	MAX_SEQUENCE_FRAMES,
	needsOutputScale,
	rateControlArgs,
	renderRequestSchema,
	requestedExportContainer,
	requiredEncoders,
	resolveRenderPlan,
} from "./render-options.ts";
import { exportContainerSchema } from "./schema/export.ts";

function project(patch: Partial<Project> = {}): Project {
	return {
		...newProject("Export"),
		width: 1920,
		height: 1080,
		fps: 30,
		...patch,
	};
}

const facts = { timelineDuration: 10 };

describe("render request schema", () => {
	test("an empty body is valid and every field is optional", () => {
		expect(renderRequestSchema.parse({})).toEqual({});
		expect(
			renderRequestSchema.parse({
				revision: 3,
				range: { start: 1, end: 2 },
				audioOnly: true,
				saveAsAsset: true,
				codec: "vp9",
				overrides: { container: "webm", crf: 30 },
			})
		).toMatchObject({ revision: 3, codec: "vp9" });
	});
	test("rejects unknown keys, inverted ranges and lone output dimensions", () => {
		expect(renderRequestSchema.safeParse({ format: "mp4" }).success).toBe(
			false
		);
		expect(
			renderRequestSchema.safeParse({ range: { start: 2, end: 2 } }).success
		).toBe(false);
		expect(exportOverridesSchema.safeParse({ outputWidth: 1280 }).success).toBe(
			false
		);
		expect(
			exportOverridesSchema.safeParse({ outputWidth: 1280, outputHeight: 720 })
				.success
		).toBe(true);
		expect(exportOverridesSchema.safeParse({ bogus: 1 }).success).toBe(false);
	});
});

describe("resolveRenderPlan", () => {
	test("the empty request is the legacy H.264 MP4 export", () => {
		const plan = resolveRenderPlan(project(), {}, facts);
		expect(plan).toMatchObject({
			alpha: false,
			container: "mp4",
			duration: 10,
			includeAudio: true,
			kind: "video",
			output: { width: 1920, height: 1080 },
			start: 0,
			videoCodec: "h264",
			warnings: [],
		});
		expect(plan.range).toBeUndefined();
		expect(plan.bitrateKbps).toBeUndefined();
		expect(plan.settings.crf).toBe(20);
		expect(plan.settings.encoderPreset).toBe("fast");
	});
	test("legacy ProRes resolves to MOV", () => {
		const plan = resolveRenderPlan(
			project({ exportCodec: "prores" }),
			{},
			facts
		);
		expect(plan.container).toBe("mov");
		expect(plan.videoCodec).toBe("prores");
		expect(plan.file.extension).toBe("mov");
	});
	test("a request codec drives the derived container", () => {
		expect(resolveRenderPlan(project(), { codec: "vp9" }, facts)).toMatchObject(
			{
				container: "webm",
				videoCodec: "vp9",
			}
		);
		expect(
			resolveRenderPlan(project(), { codec: "prores-4444" }, facts)
		).toMatchObject({
			alpha: true,
			container: "mov",
			videoCodec: "prores-4444",
		});
		expect(
			resolveRenderPlan(project(), { codec: "h265-10bit" }, facts)
		).toMatchObject({ container: "mp4", videoCodec: "h265-10bit" });
	});
	test("ranges clamp to the timeline and refuse a start past the end", () => {
		const plan = resolveRenderPlan(
			project(),
			{ range: { start: 4, end: 30 } },
			facts
		);
		expect(plan.range).toEqual({ start: 4, end: 10 });
		expect(plan.start).toBe(4);
		expect(plan.duration).toBe(6);
		expect(() =>
			resolveRenderPlan(project(), { range: { start: 10, end: 12 } }, facts)
		).toThrow("starts after the end");
	});
	test("audio-only picks WAV unless an audio container is chosen", () => {
		expect(
			resolveRenderPlan(project(), { audioOnly: true }, facts)
		).toMatchObject({
			container: "wav",
			kind: "audio",
		});
		expect(
			resolveRenderPlan(
				project(),
				{ audioOnly: true, overrides: { container: "mp3" } },
				facts
			).container
		).toBe("mp3");
		expect(() =>
			resolveRenderPlan(
				project(),
				{ audioOnly: true, overrides: { container: "mov" } },
				facts
			)
		).toThrow("Audio-only exports use");
		expect(() =>
			resolveRenderPlan(
				project(),
				{ overrides: { container: "aac", includeAudio: false } },
				facts
			)
		).toThrow("cannot leave out the audio");
		const plan = resolveRenderPlan(
			project(),
			{ overrides: { container: "aac" } },
			facts
		);
		expect(plan.kind).toBe("audio");
		expect(plan.videoCodec).toBeUndefined();
		expect(plan.file.extension).toBe("m4a");
	});
	test("container and codec combinations are validated", () => {
		expect(() =>
			resolveRenderPlan(
				project(),
				{ codec: "h264", overrides: { container: "webm" } },
				facts
			)
		).toThrow("WebM exports are encoded with VP9");
		expect(() =>
			resolveRenderPlan(
				project(),
				{ codec: "prores", overrides: { container: "mp4" } },
				facts
			)
		).toThrow("ProRes exports use the MOV container");
		expect(() =>
			resolveRenderPlan(
				project(),
				{ codec: "vp9", overrides: { container: "mov" } },
				facts
			)
		).toThrow("VP9 exports use the WebM container");
		expect(
			resolveRenderPlan(
				project(),
				{ codec: "h264", overrides: { container: "mov" } },
				facts
			).videoCodec
		).toBe("h264");
	});
	test("alpha needs MOV ProRes 4444, WebM VP9 or PNG frames", () => {
		expect(
			resolveRenderPlan(
				project(),
				{ overrides: { container: "mov", alpha: true } },
				facts
			).videoCodec
		).toBe("prores-4444");
		expect(
			resolveRenderPlan(
				project(),
				{ overrides: { container: "webm", alpha: true } },
				facts
			)
		).toMatchObject({ alpha: true, videoCodec: "vp9" });
		expect(
			resolveRenderPlan(
				project(),
				{
					range: { start: 0, end: 2 },
					overrides: { container: "png-sequence", alpha: true },
				},
				facts
			).alpha
		).toBe(true);
		for (const container of ["mp4", "gif", "jpeg-sequence", "wav"] as const) {
			expect(() =>
				resolveRenderPlan(
					project(),
					{ overrides: { container, alpha: true } },
					facts
				)
			).toThrow();
		}
		expect(() =>
			resolveRenderPlan(
				project(),
				{ codec: "prores", overrides: { container: "mov", alpha: true } },
				facts
			)
		).toThrow("ProRes 4444");
	});
	test("GIF size follows the canvas aspect and the fps never exceeds the project", () => {
		const plan = resolveRenderPlan(
			project({ fps: 24 }),
			{ overrides: { container: "gif", gifFps: 30, gifWidth: 480 } },
			facts
		);
		expect(plan.gif).toEqual({ fps: 24, width: 480, height: 270 });
		expect(plan.output).toEqual({ width: 480, height: 270 });
		expect(
			resolveRenderPlan(
				project({ width: 320, height: 240 }),
				{ overrides: { container: "gif" } },
				facts
			).gif
		).toEqual({ fps: 15, width: 320, height: 240 });
		expect(needsOutputScale(plan, project())).toBe(false);
	});
	test("image sequences are bounded", () => {
		expect(() =>
			resolveRenderPlan(
				project({ fps: 30 }),
				{ overrides: { container: "png-sequence" } },
				{ timelineDuration: MAX_SEQUENCE_FRAMES / 30 + 1 }
			)
		).toThrow("at most");
		expect(
			resolveRenderPlan(
				project(),
				{ overrides: { container: "jpeg-sequence" } },
				facts
			).kind
		).toBe("sequence");
	});
	test("output size and CBR/VBR bitrates", () => {
		const plan = resolveRenderPlan(
			project(),
			{
				overrides: { outputWidth: 1280, outputHeight: 720, rateControl: "cbr" },
			},
			facts
		);
		expect(plan.output).toEqual({ width: 1280, height: 720 });
		expect(needsOutputScale(plan, project())).toBe(true);
		expect(plan.bitrateKbps).toBe(defaultBitrateKbps(1280, 720, 30));
		expect(
			resolveRenderPlan(
				project(),
				{ overrides: { rateControl: "vbr", bitrateKbps: 5000 } },
				facts
			).bitrateKbps
		).toBe(5000);
		expect(defaultBitrateKbps(1920, 1080, 30)).toBe(4400);
		expect(defaultBitrateKbps(128, 128, 1)).toBe(1000);
		expect(defaultBitrateKbps(8192, 8192, 120)).toBe(200_000);
	});
	test("ProRes warns that rate control is ignored", () => {
		expect(
			resolveRenderPlan(
				project({ exportCodec: "prores" }),
				{ overrides: { rateControl: "cbr" } },
				facts
			).warnings
		).toEqual([
			"ProRes has a fixed quality profile; rate control and encoder speed are ignored.",
		]);
	});
	test("HDR tags only for 10-bit HEVC with hdr auto and a PQ or HLG source", () => {
		const hdr = (
			transfers: ("pq" | "hlg" | "bt709")[],
			hdrMode: "auto" | "off"
		) =>
			resolveRenderPlan(
				project(),
				{ codec: "h265-10bit", overrides: { hdr: hdrMode } },
				{ ...facts, sourceTransfers: transfers }
			).hdr;
		expect(hdr(["pq"], "auto")).toBe("smpte2084");
		expect(hdr(["hlg"], "auto")).toBe("arib-std-b67");
		expect(hdr(["bt709", "hlg", "pq"], "auto")).toBe("smpte2084");
		expect(hdr(["bt709"], "auto")).toBeUndefined();
		expect(hdr(["pq"], "off")).toBeUndefined();
		expect(
			resolveRenderPlan(
				project(),
				{ codec: "h265", overrides: { hdr: "auto" } },
				{ ...facts, sourceTransfers: ["pq"] }
			).hdr
		).toBeUndefined();
	});
	test("settings layer: derived < preset < project settings < overrides", () => {
		const withSettings = project({
			exportSettings: {
				container: "mp4",
				crf: 18,
				platformPreset: "youtube-1080p",
			},
		});
		const plan = resolveRenderPlan(withSettings, {}, facts);
		expect(plan.preset?.id).toBe("youtube-1080p");
		expect(plan.output).toEqual({ width: 1920, height: 1080 });
		expect(plan.settings.crf).toBe(18);
		expect(plan.settings.rateControl).toBe("vbr");
		expect(
			resolveRenderPlan(
				withSettings,
				{ overrides: { rateControl: "crf" } },
				facts
			).settings.rateControl
		).toBe("crf");
		const switched = resolveRenderPlan(
			withSettings,
			{ overrides: { platformPreset: "tiktok" } },
			facts
		);
		expect(switched.output).toEqual({ width: 1080, height: 1920 });
		expect(switched.settings.crf).toBe(20);
		expect(switched.warnings[0]).toContain("letterboxed");
		expect(() =>
			resolveRenderPlan(
				project(),
				{ overrides: { platformPreset: "myspace" } },
				facts
			)
		).toThrow("Unknown publish preset");
	});
	test("repeating the project's own preset keeps its saved settings", () => {
		const withSettings = project({
			exportSettings: {
				container: "mp4",
				crf: 18,
				platformPreset: "youtube-1080p",
				rateControl: "crf",
			},
		});
		const same = resolveRenderPlan(
			withSettings,
			{ overrides: { platformPreset: "youtube-1080p" } },
			facts
		);
		expect(same.settings).toEqual(
			resolveRenderPlan(withSettings, {}, facts).settings
		);
		expect(same.settings).toMatchObject({ crf: 18, rateControl: "crf" });
	});
	test("inherited audio and alpha choices never block a format they do not apply to", () => {
		const silent = project({
			exportSettings: { container: "mp4", includeAudio: false },
		});
		expect(resolveRenderPlan(silent, { audioOnly: true }, facts)).toMatchObject(
			{ container: "wav", includeAudio: true, kind: "audio" }
		);
		expect(
			resolveRenderPlan(silent, { overrides: { container: "mp3" } }, facts)
				.includeAudio
		).toBe(true);
		expect(() =>
			resolveRenderPlan(
				silent,
				{ audioOnly: true, overrides: { includeAudio: false } },
				facts
			)
		).toThrow("cannot leave out the audio");
		const transparent = project({
			exportSettings: { alpha: true, container: "mov" },
		});
		expect(resolveRenderPlan(transparent, {}, facts)).toMatchObject({
			alpha: true,
			videoCodec: "prores-4444",
		});
		for (const container of ["mp4", "gif", "jpeg-sequence", "wav"] as const) {
			expect(
				resolveRenderPlan(transparent, { overrides: { container } }, facts)
					.alpha
			).toBe(false);
		}
		expect(
			resolveRenderPlan(transparent, { codec: "h264" }, facts)
		).toMatchObject({ alpha: false, container: "mov", videoCodec: "h264" });
		expect(
			resolveRenderPlan(
				transparent,
				{ overrides: { container: "webm" } },
				facts
			).alpha
		).toBe(true);
		expect(() =>
			resolveRenderPlan(
				transparent,
				{ overrides: { alpha: true, container: "mp4" } },
				facts
			)
		).toThrow("Transparent video exports need");
	});
	test("the requested container resolves before alpha and audio checks", () => {
		expect(requestedExportContainer(project(), {})).toBe("mp4");
		expect(
			requestedExportContainer(project({ exportCodec: "prores" }), {})
		).toBe("mov");
		expect(
			requestedExportContainer(
				project({ exportSettings: { container: "gif" } }),
				{}
			)
		).toBe("gif");
		expect(requestedExportContainer(project(), { audioOnly: true })).toBe(
			"wav"
		);
		expect(
			requestedExportContainer(project(), {
				overrides: { platformPreset: "podcast-audio" },
			})
		).toBe("mp3");
		expect(exportSupportsAlpha("png-sequence")).toBe(true);
		expect(exportSupportsAlpha("mp4")).toBe(false);
	});
	test("the podcast preset is an MP3 audio export", () => {
		expect(
			resolveRenderPlan(
				project(),
				{ overrides: { platformPreset: "podcast-audio" } },
				facts
			)
		).toMatchObject({ container: "mp3", kind: "audio" });
	});
});

describe("helpers", () => {
	test("every container has a file format and a kind", () => {
		for (const container of exportContainerSchema.options) {
			expect(EXPORT_FILE_FORMATS[container].extension.length).toBeGreaterThan(
				1
			);
			expect(["video", "audio", "gif", "sequence"]).toContain(
				exportKindOf(container)
			);
		}
		expect(importableExport("mp4")).toBe(true);
		expect(importableExport("mp3")).toBe(true);
		expect(importableExport("gif")).toBe(false);
		expect(importableExport("png-sequence")).toBe(false);
	});
	test("rate control arguments", () => {
		expect(rateControlArgs("cbr", 4000)).toEqual([
			"-b:v",
			"4000k",
			"-maxrate",
			"4000k",
			"-bufsize",
			"8000k",
		]);
		expect(rateControlArgs("vbr", 4000)).toEqual([
			"-b:v",
			"4000k",
			"-maxrate",
			"6000k",
			"-bufsize",
			"12000k",
		]);
	});
	test("required encoders", () => {
		const encoders = (options: Parameters<typeof resolveRenderPlan>[1]) =>
			requiredEncoders(resolveRenderPlan(project(), options, facts));
		expect(encoders({})).toEqual(["aac", "libx264"]);
		expect(encoders({ codec: "vp9" })).toEqual(["libopus", "libvpx-vp9"]);
		expect(encoders({ codec: "h265-10bit" })).toEqual(["aac", "libx265"]);
		expect(encoders({ codec: "prores" })).toEqual(["aac", "prores_ks"]);
		expect(encoders({ overrides: { includeAudio: false } })).toEqual([
			"libx264",
		]);
		expect(encoders({ audioOnly: true })).toEqual([]);
		expect(encoders({ overrides: { container: "mp3" } })).toEqual([
			"libmp3lame",
		]);
		expect(encoders({ overrides: { container: "gif" } })).toEqual([]);
	});
	test("job output records the effective export", () => {
		const request = {
			range: { start: 1, end: 3 },
			saveAsAsset: true,
			revision: 2,
			overrides: { container: "webm" as const },
		};
		const plan = resolveRenderPlan(project(), request, facts);
		expect(exportJobOutputOf(plan, request)).toEqual({
			alpha: false,
			codec: "vp9",
			container: "webm",
			duration: 2,
			extension: "webm",
			height: 1080,
			includeAudio: true,
			kind: "video",
			label: "WebM",
			mime: "video/webm",
			range: { start: 1, end: 3 },
			request: {
				range: { start: 1, end: 3 },
				overrides: { container: "webm" },
			},
			saveAsAsset: true,
			warnings: [],
			width: 1920,
		});
	});
});

describe("output resolution tiers", () => {
	test("the request schema accepts tier names only", () => {
		expect(
			renderRequestSchema.parse({ outputResolution: "2k" }).outputResolution
		).toBe("2k");
		expect(
			renderRequestSchema.safeParse({ outputResolution: "8k" }).success
		).toBe(false);
	});

	test("a tier scales the canvas short side and keeps the aspect", () => {
		const plan = resolveRenderPlan(
			project({ width: 1080, height: 1350 }),
			{ outputResolution: "4k" },
			facts
		);
		expect(plan.output).toEqual({ width: 2160, height: 2700 });
		expect(plan.settings.outputWidth).toBe(2160);
		expect(plan.settings.outputHeight).toBe(2700);
	});

	test("a tier replaces a preset size without a letterbox warning", () => {
		const plan = resolveRenderPlan(
			project({ width: 1080, height: 1350 }),
			{ outputResolution: "720p", overrides: { platformPreset: "tiktok" } },
			facts
		);
		expect(plan.output).toEqual({ width: 720, height: 900 });
		expect(
			plan.warnings.some((warning) => warning.includes("letterboxed"))
		).toBe(false);
	});

	test("a tier cannot be combined with an explicit size", () => {
		expect(() =>
			resolveRenderPlan(
				project(),
				{
					outputResolution: "1080p",
					overrides: { outputWidth: 640, outputHeight: 360 },
				},
				facts
			)
		).toThrow("not both");
	});

	test("a tier past the frame limit is refused; audio exports ignore it", () => {
		const wide = project({ width: 8192, height: 1024 });
		expect(() =>
			resolveRenderPlan(wide, { outputResolution: "4k" }, facts)
		).toThrow("Choose a lower resolution");
		expect(
			resolveRenderPlan(
				wide,
				{ outputResolution: "4k", audioOnly: true },
				facts
			).kind
		).toBe("audio");
	});
});
