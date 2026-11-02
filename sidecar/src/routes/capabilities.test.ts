import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilitiesFromOutput,
	createCapabilityCache,
	parseFfmpegEncoders,
	parseFfmpegFilters,
	parseX265TenBit,
	probeFfmpegCapabilities,
	TRACKED_ENCODERS,
	TRACKED_FILTERS,
	unavailableCapabilities,
} from "../ffmpeg-capabilities.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";

const filtersFixture = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 ... abench            A->A       Benchmark part of a filtergraph.
 TSC amix              N->A       Audio mixing.
 ... arnndn            A->A       Reduce noise from speech using Recurrent Neural Networks.
 TS. lut3d             V->V       Adjust colors using a 3D LUT.
 T.C hsvkey            V->V       Turns a certain HSV range into transparency.
 ..C xfade             VV->V      Cross fade one video with another video.
 ... color             |->V       Provide an uniformly colored input.
 ... nullsink          V->|       Do absolutely nothing with the input video.
 T.. vidstabdetect     V->V       Extract relative transformations.
`;

const encodersFixture = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 VFS... prores_ks            Apple ProRes (iCodec Pro) (codec prores)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libopus              libopus Opus (codec opus)
 S..... ass                  ASS (Advanced SubStation Alpha) subtitle
`;

const x265HelpFixture = `Encoder libx265 [libx265 H.265 / HEVC]:
    General capabilities: dr1 delay threads
    Threading capabilities: other
    Supported pixel formats: yuv420p yuvj420p yuv422p yuv444p gbrp yuv420p10le yuv422p10le gray
libx265 AVOptions:
`;

test("filter listing parses names across flag layouts and ignores the legend", () => {
	const names = parseFfmpegFilters(filtersFixture);
	expect([...names].sort()).toEqual([
		"abench",
		"amix",
		"arnndn",
		"color",
		"hsvkey",
		"lut3d",
		"nullsink",
		"vidstabdetect",
		"xfade",
	]);
	expect(names.has("T..")).toBe(false);
	expect(names.has("=")).toBe(false);
});

test("encoder listing parses names and ignores the legend", () => {
	const names = parseFfmpegEncoders(encodersFixture);
	expect([...names].sort()).toEqual([
		"aac",
		"ass",
		"libopus",
		"libx264",
		"libx265",
		"prores_ks",
	]);
});

test("x265 ten-bit support reads the supported pixel formats", () => {
	expect(parseX265TenBit(x265HelpFixture)).toBe(true);
	expect(
		parseX265TenBit("    Supported pixel formats: yuv420p yuv422p gbrp\n")
	).toBe(false);
	expect(parseX265TenBit("")).toBe(false);
});

test("capabilities report every tracked name with a boolean", () => {
	const capabilities = capabilitiesFromOutput({
		encoders: encodersFixture,
		filters: filtersFixture,
		x265Help: x265HelpFixture,
	});
	expect(Object.keys(capabilities.filters).sort()).toEqual(
		[...TRACKED_FILTERS].sort()
	);
	expect(Object.keys(capabilities.encoders).sort()).toEqual(
		[...TRACKED_ENCODERS].sort()
	);
	expect(capabilities.filters.lut3d).toBe(true);
	expect(capabilities.filters.backgroundkey).toBe(false);
	expect(capabilities.filters.vidstabtransform).toBe(false);
	expect(capabilities.encoders.libx265).toBe(true);
	expect(capabilities.encoders["libvpx-vp9"]).toBe(false);
	expect(capabilities.x265TenBit).toBe(true);
	expect(capabilities.renderer).toBe(true);
	const noHelp = capabilitiesFromOutput({
		encoders: encodersFixture,
		filters: filtersFixture,
	});
	expect(noHelp.x265TenBit).toBe(false);
	const unavailable = unavailableCapabilities();
	expect(unavailable.renderer).toBe(false);
	expect(Object.values(unavailable.filters).every((value) => !value)).toBe(
		true
	);
});

test("probe asks for x265 help only when libx265 is present", async () => {
	const calls: string[][] = [];
	const withoutX265 = await probeFfmpegCapabilities(async (args) => {
		calls.push(args);
		return args.includes("-filters")
			? filtersFixture
			: encodersFixture.replace(/^.*libx265.*$/m, "");
	});
	expect(withoutX265.encoders.libx265).toBe(false);
	expect(calls.some((args) => args.includes("encoder=libx265"))).toBe(false);
	const withX265 = await probeFfmpegCapabilities(async (args) => {
		if (args.includes("-filters")) {
			return filtersFixture;
		}
		return args.includes("-encoders") ? encodersFixture : x265HelpFixture;
	});
	expect(withX265.x265TenBit).toBe(true);
});

test("capability cache probes once and retries after a failed probe", async () => {
	let runs = 0;
	let fail = true;
	const cache = createCapabilityCache(async (args) => {
		runs += 1;
		if (fail) {
			throw new Error("FFmpeg is missing.");
		}
		return args.includes("-filters") ? filtersFixture : "";
	});
	expect((await cache()).renderer).toBe(false);
	fail = false;
	const first = await cache();
	const runsAfterFirst = runs;
	const second = await cache();
	expect(first.renderer).toBe(true);
	expect(second).toBe(first);
	expect(runs).toBe(runsAfterFirst);
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

test("GET /capabilities keeps its existing fields and adds FFmpeg probes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-caps-"));
	const store = new StudioStore(directory);
	cleanup.push(async () => {
		store.close();
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/capabilities`,
			{ headers: { authorization: `Bearer ${token}` } }
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			chunkSize: 512 * 1024,
			codecs: ["h264", "h265", "prores", "h265-10bit", "prores-4444", "vp9"],
			formats: [
				"mp4",
				"mov",
				"webm",
				"gif",
				"wav",
				"mp3",
				"aac",
				"png-sequence",
				"jpeg-sequence",
			],
			bundledAssets: { fonts: true, voiceIsolationModel: true },
			maxDuration: 7200,
			maxMediaBytes: 2 * 1024 * 1024 * 1024,
		});
		expect(typeof body.renderer).toBe("boolean");
		expect(typeof body.x265TenBit).toBe("boolean");
		expect(Object.keys(body.filters).sort()).toEqual(
			[...TRACKED_FILTERS].sort()
		);
		expect(Object.keys(body.encoders).sort()).toEqual(
			[...TRACKED_ENCODERS].sort()
		);
	} finally {
		app.stop();
	}
});
