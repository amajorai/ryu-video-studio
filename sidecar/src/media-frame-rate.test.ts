import { describe, expect, test } from "bun:test";
import {
	parseProbeOutput,
	probeColorTransfer,
	probeFrameRate,
} from "./media.ts";

function videoProbe(stream: Record<string, unknown>, audio = true) {
	return JSON.stringify({
		format: { duration: "2" },
		streams: [
			{
				codec_name: "h264",
				codec_type: "video",
				duration: "2",
				height: 1080,
				width: 1920,
				...stream,
			},
			...(audio ? [{ codec_type: "audio" }] : []),
		],
	});
}

describe("probe frame rate", () => {
	test("keeps the exact NTSC rate from r_frame_rate", () => {
		expect(
			parseProbeOutput(
				videoProbe({
					avg_frame_rate: "30000/1001",
					r_frame_rate: "30000/1001",
				})
			)
		).toMatchObject({ frameRate: 29.97, kind: "video" });
		expect(
			parseProbeOutput(videoProbe({ r_frame_rate: "24000/1001" })).frameRate
		).toBe(23.976);
	});

	test("falls back to the average rate for missing or misleading timebases", () => {
		expect(probeFrameRate({ avg_frame_rate: "25/1" })).toBe(25);
		expect(
			probeFrameRate({ avg_frame_rate: "25/1", r_frame_rate: "90000/1" })
		).toBe(25);
		expect(
			probeFrameRate({ avg_frame_rate: "2997/125", r_frame_rate: "60/1" })
		).toBe(23.976);
		expect(
			probeFrameRate({ avg_frame_rate: "0/0", r_frame_rate: "0/0" })
		).toBeUndefined();
	});

	test("stills and audio carry no frame rate or transfer", () => {
		const still = parseProbeOutput(
			JSON.stringify({
				format: {},
				streams: [
					{
						codec_name: "png",
						codec_type: "video",
						color_transfer: "bt709",
						height: 100,
						r_frame_rate: "25/1",
						width: 100,
					},
				],
			})
		);
		expect(still.kind).toBe("image");
		expect(still.frameRate).toBeUndefined();
		expect(still.colorTransfer).toBeUndefined();
		const audio = parseProbeOutput(
			JSON.stringify({
				format: { duration: "3" },
				streams: [{ codec_type: "audio" }],
			})
		);
		expect(audio.frameRate).toBeUndefined();
	});

	test("legacy probe output without the new fields parses as before", () => {
		const parsed = parseProbeOutput(videoProbe({}));
		expect(parsed).toEqual({
			duration: 2,
			hasAudio: true,
			height: 1080,
			kind: "video",
			width: 1920,
		});
	});
});

describe("probe color transfer", () => {
	test.each([
		["bt709", "bt709"],
		["smpte170m", "bt709"],
		["bt2020-10", "bt709"],
		["smpte2084", "pq"],
		["arib-std-b67", "hlg"],
		["linear", "unknown"],
		["SMPTE2084", "pq"],
	] as const)("%p is %p", (name, family) => {
		expect(probeColorTransfer(name)).toBe(family);
		expect(
			parseProbeOutput(videoProbe({ color_transfer: name })).colorTransfer
		).toBe(family);
	});

	test("absent or unknown transfers are left unset", () => {
		expect(probeColorTransfer(undefined)).toBeUndefined();
		expect(probeColorTransfer("unknown")).toBeUndefined();
		expect(probeColorTransfer(" ")).toBeUndefined();
	});
});
