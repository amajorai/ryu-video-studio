import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	assetSchema,
	newProject,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import {
	type RenderOptions,
	resolveRenderPlan,
} from "../../shared/render-options.ts";
import { buildRender, transparentBase } from "./render.ts";
import { encodeArgs } from "./render-encode.ts";

const fixtureSchema = z
	.object({
		assets: z.array(assetSchema),
		project: projectSchema,
	})
	.passthrough();

function fixture(name: string) {
	return fixtureSchema.parse(
		JSON.parse(
			readFileSync(
				join(import.meta.dir, "__fixtures__", "render", `${name}.json`),
				"utf8"
			)
		)
	);
}

function project(patch: Partial<Project> = {}): Project {
	return {
		...newProject("Encode"),
		width: 1920,
		height: 1080,
		fps: 30,
		...patch,
	};
}

function buildPlan(
	p: Project,
	options: RenderOptions,
	transfers: ("pq" | "hlg")[]
) {
	return resolveRenderPlan(p, options, {
		sourceTransfers: transfers,
		timelineDuration: 8,
	});
}

const graph = { audio: "mix", duration: 8, video: "out" };
const encode = (options: RenderOptions, p: Project = project()) =>
	encodeArgs(p, options, graph).join(" ");

describe("encodeArgs per container and codec", () => {
	const cases: [string, RenderOptions, Partial<Project>, string][] = [
		[
			"legacy H.264",
			{},
			{},
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart -threads 2",
		],
		[
			"legacy H.265 review",
			{},
			{ exportCodec: "h265", exportPreset: "review" },
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v libx265 -preset veryfast -crf 30 -pix_fmt yuv420p -tag:v hvc1 -movflags +faststart -threads 2",
		],
		[
			"legacy ProRes 422",
			{},
			{ exportCodec: "prores" },
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -threads 2",
		],
		[
			"H.264 in MOV",
			{ overrides: { container: "mov" } },
			{},
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart -threads 2",
		],
		[
			"HEVC 10-bit",
			{ codec: "h265-10bit" },
			{},
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v libx265 -preset fast -crf 24 -pix_fmt yuv420p10le -tag:v hvc1 -movflags +faststart -threads 2",
		],
		[
			"ProRes 4444 with alpha",
			{ overrides: { container: "mov", alpha: true } },
			{},
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -threads 2",
		],
		[
			"opaque ProRes 4444",
			{ codec: "prores-4444", overrides: { alpha: false } },
			{},
			"-map [out] -map [mix] -c:a aac -b:a 192k -t 8 -r 30 -c:v prores_ks -profile:v 4 -pix_fmt yuv444p10le -threads 2",
		],
		[
			"WebM VP9 with Opus",
			{ overrides: { container: "webm", crf: 32, encoderPreset: "medium" } },
			{},
			"-map [out] -map [mix] -c:a libopus -b:a 192k -ar 48000 -t 8 -r 30 -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 -deadline good -cpu-used 2 -pix_fmt yuv420p -threads 2",
		],
		[
			"WebM VP9 alpha",
			{ overrides: { container: "webm", alpha: true } },
			{},
			"-map [out] -map [mix] -c:a libopus -b:a 192k -ar 48000 -t 8 -r 30 -c:v libvpx-vp9 -crf 20 -b:v 0 -row-mt 1 -deadline good -cpu-used 3 -pix_fmt yuva420p -auto-alt-ref 0 -threads 2",
		],
		[
			"CBR with a custom preset and audio bitrate",
			{
				overrides: {
					rateControl: "cbr",
					bitrateKbps: 6000,
					encoderPreset: "slow",
					audioBitrateKbps: 320,
				},
			},
			{},
			"-map [out] -map [mix] -c:a aac -b:a 320k -t 8 -r 30 -c:v libx264 -preset slow -b:v 6000k -maxrate 6000k -bufsize 12000k -pix_fmt yuv420p -movflags +faststart -threads 2",
		],
		[
			"VBR VP9",
			{ codec: "vp9", overrides: { rateControl: "vbr", bitrateKbps: 2000 } },
			{},
			"-map [out] -map [mix] -c:a libopus -b:a 192k -ar 48000 -t 8 -r 30 -c:v libvpx-vp9 -b:v 2000k -maxrate 3000k -bufsize 6000k -row-mt 1 -deadline good -cpu-used 3 -pix_fmt yuv420p -threads 2",
		],
		[
			"range without audio",
			{ range: { start: 2, end: 5 }, overrides: { includeAudio: false } },
			{},
			"-map [out] -an -ss 2 -t 3 -r 30 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart -threads 2",
		],
		["WAV", { audioOnly: true }, {}, "-map [mix] -vn -t 8 -c:a pcm_s16le"],
		[
			"MP3 range",
			{
				audioOnly: true,
				range: { start: 1, end: 4 },
				overrides: { container: "mp3" },
			},
			{},
			"-map [mix] -vn -ss 1 -t 3 -c:a libmp3lame -q:a 2",
		],
		[
			"AAC",
			{ overrides: { container: "aac", audioBitrateKbps: 256 } },
			{},
			"-map [mix] -vn -t 8 -c:a aac -b:a 256k -movflags +faststart",
		],
		[
			"GIF",
			{ overrides: { container: "gif" } },
			{},
			"-map [out] -an -c:v gif -loop 0",
		],
		[
			"PNG sequence",
			{ overrides: { container: "png-sequence" } },
			{},
			"-map [out] -an -t 8 -r 30 -c:v png -pix_fmt rgb24 -f image2",
		],
		[
			"PNG sequence with alpha",
			{ overrides: { container: "png-sequence", alpha: true } },
			{},
			"-map [out] -an -t 8 -r 30 -c:v png -pix_fmt rgba -f image2",
		],
		[
			"JPEG sequence",
			{
				range: { start: 1, end: 2 },
				overrides: { container: "jpeg-sequence" },
			},
			{},
			"-map [out] -an -ss 1 -t 1 -r 30 -c:v mjpeg -q:v 2 -pix_fmt yuvj444p -f image2",
		],
	];
	for (const [name, options, patch, expected] of cases) {
		test(name, () => {
			expect(encode(options, project(patch))).toBe(expected);
		});
	}
	test("HDR tags for 10-bit HEVC from a PQ source", () => {
		const p = project();
		const args = encodeArgs(
			p,
			{
				plan: buildPlan(
					p,
					{ codec: "h265-10bit", overrides: { hdr: "auto" } },
					["pq"]
				),
			},
			graph
		).join(" ");
		expect(args).toContain(
			"-pix_fmt yuv420p10le -x265-params colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -tag:v hvc1"
		);
	});
	test("audio-only without audio is refused; frames ignore export options", () => {
		expect(() =>
			encodeArgs(project(), { audioOnly: true }, { duration: 8, video: "out" })
		).toThrow("Nothing on the timeline is audible");
		expect(
			encodeArgs(
				project(),
				{ overrides: { container: "gif" } },
				{ duration: 8, frameTime: 1, video: "out" }
			).join(" ")
		).toContain("-c:v png -pix_fmt rgba");
	});
});

describe("buildRender export finishing", () => {
	const multi = fixture("multi-track");
	const render = (options: RenderOptions, f = multi) =>
		buildRender(
			f.project,
			f.assets,
			(id) => `/media/${id}`,
			undefined,
			[],
			undefined,
			options
		);
	const graphOf = (args: string[]) =>
		args[args.indexOf("-filter_complex") + 1] ?? "";

	test("the default options keep the legacy argv", () => {
		expect(render({})).toEqual(
			buildRender(multi.project, multi.assets, (id) => `/media/${id}`)
		);
	});
	test("audio-only skips every video stage and pads the mix", () => {
		const args = render({ audioOnly: true });
		const graphText = graphOf(args);
		expect(graphText).not.toContain("[base]");
		expect(graphText).not.toContain("overlay");
		expect(graphText).toContain("[mix]apad=whole_dur=");
		expect(args.slice(args.indexOf("-map"))).toEqual([
			"-map",
			"[exportAudio]",
			"-vn",
			"-t",
			String(args[args.lastIndexOf("-t") + 1]),
			"-c:a",
			"pcm_s16le",
		]);
	});
	test("excluding audio drops every audio chain", () => {
		const args = render({ overrides: { includeAudio: false } });
		expect(graphOf(args)).not.toContain("amix");
		expect(args).toContain("-an");
		expect(args).not.toContain("[mix]");
	});
	test("alpha swaps the canvas for a transparent one", () => {
		const args = render({ overrides: { container: "mov", alpha: true } });
		expect(args.join(" ")).toContain("color=c=black@0:s=1280x720");
		expect(graphOf(args).startsWith("[0:v]format=yuva420p[base]")).toBe(true);
	});
	test("an output size scales and pads the composite", () => {
		const args = render({ overrides: { outputWidth: 640, outputHeight: 640 } });
		expect(graphOf(args)).toContain(
			"scale=640:640:force_original_aspect_ratio=decrease:flags=lanczos,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[exportFrame]"
		);
		expect(args[args.indexOf("-map") + 1]).toBe("[exportFrame]");
	});
	test("GIF runs a palette pass over the trimmed span", () => {
		const args = render({
			range: { start: 1, end: 3 },
			overrides: { container: "gif", gifWidth: 320, gifFps: 10 },
		});
		expect(graphOf(args)).toContain(
			"trim=start=1:end=3,setpts=PTS-STARTPTS,fps=10,scale=320:180:flags=lanczos,split[gifFrames][gifPaletteSource];[gifPaletteSource]palettegen=stats_mode=diff[gifPalette];[gifFrames][gifPalette]paletteuse=dither=sierra2_4a[gif]"
		);
		expect(graphOf(args)).not.toContain("amix");
		expect(args.slice(-7)).toEqual([
			"-map",
			"[gif]",
			"-an",
			"-c:v",
			"gif",
			"-loop",
			"0",
		]);
	});
	test("a GIF with another aspect is fitted and letterboxed, not stretched", () => {
		const args = render({
			overrides: { container: "gif", outputWidth: 640, outputHeight: 640 },
		});
		expect(graphOf(args)).toContain(
			"fps=15,scale=640:640:force_original_aspect_ratio=decrease:flags=lanczos,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,split[gifFrames]"
		);
	});
	test("NTSC rates encode as exact rationals", () => {
		const ntsc = project({ fps: 29.97 });
		const video = encodeArgs(ntsc, {}, graph);
		expect(video[video.indexOf("-r") + 1]).toBe("30000/1001");
		const frames = encodeArgs(
			ntsc,
			{ overrides: { container: "png-sequence" }, range: { start: 0, end: 1 } },
			graph
		);
		expect(frames[frames.indexOf("-r") + 1]).toBe("30000/1001");
		expect(transparentBase(ntsc, 2).args.join(" ")).toContain(
			"s=1920x1080:r=30000/1001:d=2,format=rgba"
		);
		expect(transparentBase(project(), 2).args.join(" ")).toContain(
			":r=30:d=2,"
		);
	});
	test("frame renders ignore export options", () => {
		const options = { overrides: { container: "gif" as const } };
		expect(
			buildRender(
				multi.project,
				multi.assets,
				(id) => `/media/${id}`,
				undefined,
				[],
				1,
				options
			)
		).toEqual(
			buildRender(
				multi.project,
				multi.assets,
				(id) => `/media/${id}`,
				undefined,
				[],
				1
			)
		);
	});
});
