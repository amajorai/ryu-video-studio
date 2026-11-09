import { describe, expect, test } from "bun:test";
import {
	createPreviewMeter,
	METER_BLOCK,
	meterReadingFromBlocks,
} from "./meter.ts";
import {
	createScrubber,
	createScrubWindowCache,
	decodedBytes,
	grainEnvelope,
	SCRUB_GRAIN_SECONDS,
	SCRUB_MIN_INTERVAL_MS,
	SCRUB_WINDOW_SECONDS,
	type ScrubWindow,
	scrubDecision,
	scrubWindowStart,
} from "./scrub.ts";
import { previewClipMixGain, previewTempo, previewTrackMix } from "./tempo.ts";

const sine = (amplitude: number) =>
	Float32Array.from(
		{ length: METER_BLOCK },
		(_, index) => amplitude * Math.sin((2 * Math.PI * 1000 * index) / 48_000)
	);

describe("preview meter", () => {
	test("computes peak and RMS per channel from known buffers", () => {
		const reading = meterReadingFromBlocks([sine(0.5), new Float32Array(16)]);
		expect(reading.peak[0]).toBeCloseTo(0.5, 2);
		expect(reading.rms[0]).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
		expect(reading.peak[1]).toBe(0);
		expect(reading.rms[1]).toBe(0);
		expect(reading.clipped).toEqual([false, false]);
	});

	test("the clip indicator latches until reset", () => {
		const hot = meterReadingFromBlocks([sine(1), sine(0.5)]);
		expect(hot.clipped).toEqual([true, false]);
		const quiet = meterReadingFromBlocks([sine(0.1), sine(0.1)], hot.clipped);
		expect(quiet.clipped).toEqual([true, false]);
	});

	test("taps the master with one analyser per channel and latches clips", () => {
		const connections: string[] = [];
		let level = 1;
		const node = (name: string) => ({
			connect(_target: unknown, output?: number) {
				connections.push(`${name}${output === undefined ? "" : `:${output}`}`);
			},
			disconnect() {
				connections.push(`${name}-off`);
			},
		});
		const audio = {
			createAnalyser: () => ({
				...node("analyser"),
				fftSize: 0,
				getFloatTimeDomainData(block: Float32Array) {
					block.fill(level);
				},
				smoothingTimeConstant: 1,
			}),
			createChannelSplitter: () => node("splitter"),
		} as unknown as AudioContext;
		const master = node("master") as unknown as AudioNode;
		const meter = createPreviewMeter(audio, master);
		if (!meter) {
			throw new Error("meter was not created");
		}
		expect(connections).toEqual(["splitter:0", "splitter:1", "master"]);
		// Scrub grains connect here to reach the limiter and the meter.
		expect(meter.master).toBe(master);
		expect(meter.read()).toEqual({
			clipped: [true, true],
			peak: [1, 1],
			rms: [1, 1],
		});
		level = 0.25;
		expect(meter.read().clipped).toEqual([true, true]);
		meter.resetClip();
		expect(meter.read()).toEqual({
			clipped: [false, false],
			peak: [0.25, 0.25],
			rms: [0.25, 0.25],
		});
		meter.dispose();
		expect(connections).toContain("analyser-off");
	});

	test("contexts without analysers report no meter", () => {
		expect(
			createPreviewMeter({} as AudioContext, {} as unknown as AudioNode)
		).toBeNull();
	});
});

describe("scrubbing", () => {
	const audible = { active: true, audible: true, volume: 1 };

	test("the first sync only records the position", () => {
		expect(scrubDecision({}, 2, audible, 0)).toEqual({ kind: "track" });
	});

	test("a moved source plays a grain at the new time", () => {
		expect(scrubDecision({ lastSourceTime: 1 }, 2, audible, 100)).toEqual({
			kind: "grain",
			offset: 2,
		});
	});

	test("unchanged positions, inaudible clips and fast repeats do not play", () => {
		expect(scrubDecision({ lastSourceTime: 2 }, 2, audible, 0).kind).toBe(
			"skip"
		);
		expect(
			scrubDecision({ lastSourceTime: 1 }, 2, { ...audible, active: false }, 0)
				.kind
		).toBe("track");
		expect(
			scrubDecision({ lastSourceTime: 1 }, 2, { ...audible, volume: 0 }, 0).kind
		).toBe("track");
		expect(
			scrubDecision(
				{ lastGrainAt: 100, lastSourceTime: 1 },
				2,
				audible,
				100 + SCRUB_MIN_INTERVAL_MS - 1
			).kind
		).toBe("track");
		expect(
			scrubDecision({ lastSourceTime: 1 }, Number.NaN, audible, 0)
		).toEqual({ kind: "skip" });
	});

	test("grains fade in and out and clamp gain", () => {
		expect(grainEnvelope(0.5)).toEqual([
			[0, 0],
			[0.005, 0.5],
			[SCRUB_GRAIN_SECONDS - 0.005, 0.5],
			[SCRUB_GRAIN_SECONDS, 0],
		]);
		expect(grainEnvelope(9)[1]?.[1]).toBe(4);
	});

	test("the scrubber plays the latest position from its window", async () => {
		const played: [number, number][] = [];
		const loads: [number, string | undefined][] = [];
		let now = 0;
		let enabled = true;
		const buffer = { duration: SCRUB_WINDOW_SECONDS } as AudioBuffer;
		const scrub = createScrubber({
			enabled: () => enabled,
			load: (_element, sourceTime, context) => {
				loads.push([sourceTime, context.assetId]);
				return Promise.resolve({
					buffer,
					start: scrubWindowStart(sourceTime),
				});
			},
			now: () => now,
			play: (_buffer, offset, volume) => played.push([offset, volume]),
		});
		const element = {} as HTMLMediaElement;
		const withAsset = { ...audible, assetId: "a1" };
		scrub(element, 21, withAsset);
		now = 100;
		scrub(element, 21.5, { ...withAsset, volume: 0.5 });
		await Promise.resolve();
		await Promise.resolve();
		// Offsets are relative to the 20 s window that holds the source time.
		expect(loads).toEqual([[21.5, "a1"]]);
		expect(played).toEqual([[1.5, 0.5]]);
		enabled = false;
		now = 500;
		scrub(element, 3, withAsset);
		await Promise.resolve();
		expect(played).toHaveLength(1);
	});

	test("windows align to the sidecar audio-window size", () => {
		expect(scrubWindowStart(0)).toBe(0);
		expect(scrubWindowStart(SCRUB_WINDOW_SECONDS - 0.01)).toBe(0);
		expect(scrubWindowStart(SCRUB_WINDOW_SECONDS * 3 + 1)).toBe(
			SCRUB_WINDOW_SECONDS * 3
		);
		expect(scrubWindowStart(-5)).toBe(0);
	});

	test("decoded size counts every channel", () => {
		expect(decodedBytes({ length: 16_000, numberOfChannels: 1 })).toBe(64_000);
		expect(decodedBytes({ length: 16_000, numberOfChannels: 2 })).toBe(128_000);
	});

	test("the window cache is bounded by decoded bytes, not entries", async () => {
		const fetched: string[] = [];
		const window = (start: number, length: number): ScrubWindow => ({
			buffer: { duration: 1, length, numberOfChannels: 1 } as AudioBuffer,
			start,
		});
		const cache = createScrubWindowCache((assetId, start) => {
			fetched.push(`${assetId}:${start}`);
			return Promise.resolve(window(start, 100));
		}, 1000);
		await cache.get("a", 0);
		await cache.get("a", 20);
		expect(cache.size()).toBe(800);
		// A third 400-byte window pushes the least recently used one out.
		await cache.get("a", 0);
		await cache.get("a", 40);
		expect(cache.size()).toBe(800);
		await cache.get("a", 0);
		await cache.get("a", 20);
		expect(fetched).toEqual(["a:0", "a:20", "a:40", "a:20"]);
	});

	test("failed windows are not cached", async () => {
		let attempts = 0;
		const cache = createScrubWindowCache(() => {
			attempts++;
			return Promise.reject(new Error("busy"));
		});
		expect(await cache.get("a", 0)).toBeNull();
		expect(await cache.get("a", 0)).toBeNull();
		expect(attempts).toBe(2);
		expect(cache.size()).toBe(0);
	});
});

describe("preview tempo", () => {
	test("pitch preservation is always set, so reused elements reset", () => {
		expect(previewTempo({ speed: 1 })).toEqual({
			muted: false,
			playbackRate: 1,
			preservesPitch: true,
		});
		expect(previewTempo({ speed: 2 })).toEqual({
			muted: false,
			playbackRate: 2,
			preservesPitch: true,
		});
	});

	test("toggling preserve pitch off and back on restores the element", () => {
		const element = { preservesPitch: true };
		const sync = (segment: Parameters<typeof previewTempo>[0]) => {
			element.preservesPitch = previewTempo(segment).preservesPitch;
		};
		sync({ preservePitch: false, speed: 2 });
		expect(element.preservesPitch).toBe(false);
		sync({ speed: 2 });
		expect(element.preservesPitch).toBe(true);
	});

	test("tape-style clips turn off pitch preservation", () => {
		expect(previewTempo({ preservePitch: false, speed: 0.5 })).toEqual({
			muted: false,
			playbackRate: 0.5,
			preservesPitch: false,
		});
	});

	test("clips above 16x preview muted unless they opt back in", () => {
		expect(previewTempo({ speed: 40 }).muted).toBe(true);
		expect(previewTempo({ speed: 40 }).playbackRate).toBe(16);
		expect(previewTempo({ muted: false, speed: 40 }).muted).toBe(false);
	});

	test("an explicit clip mute silences the preview at any speed", () => {
		expect(previewTempo({ muted: true, speed: 1 }).muted).toBe(true);
	});
});

describe("preview track mix", () => {
	const track = (gainDb?: number, pan?: number) => ({
		trackSettings: [
			{
				locked: false,
				muted: false,
				name: "Track 1",
				solo: false,
				track: 0,
				...(gainDb === undefined ? {} : { gainDb }),
				...(pan === undefined ? {} : { pan }),
			},
		],
	});

	test("untouched tracks are unity", () => {
		expect(previewTrackMix({ trackSettings: [] }, 0)).toEqual({
			gain: 1,
			left: 1,
			right: 1,
		});
	});

	test("track gain scales the clip and track pan sets the balance", () => {
		const quieter = previewTrackMix(track(-6), 0);
		expect(quieter.gain).toBeCloseTo(10 ** (-6 / 20), 6);
		const left = previewTrackMix(track(0, -1), 0);
		expect(left.right).toBe(0);
		expect(left.left).toBeCloseTo(Math.SQRT2, 6);
	});

	test("muted clips contribute nothing to the preview mix", () => {
		const project = track(-6);
		expect(previewClipMixGain(project, { speed: 20, track: 0 })).toBe(0);
		expect(
			previewClipMixGain(project, { muted: true, speed: 1, track: 0 })
		).toBe(0);
		expect(
			previewClipMixGain(project, { muted: false, speed: 20, track: 0 })
		).toBeCloseTo(10 ** (-6 / 20), 6);
	});
});
