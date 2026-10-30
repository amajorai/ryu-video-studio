import { describe, expect, test } from "bun:test";
import { newProject, updateTrackSetting } from "./project.ts";
import {
	isUnityTrackMix,
	projectTrackMix,
	trackMixFilterChain,
	trackMixGains,
	trackMixOf,
} from "./track-mix.ts";

describe("track mix", () => {
	test("legacy tracks resolve to unity and add no filters", () => {
		const project = newProject("Mix");
		const mix = projectTrackMix(project, 0);
		expect(mix).toEqual({ gainDb: 0, pan: 0 });
		expect(isUnityTrackMix(mix)).toBe(true);
		expect(trackMixFilterChain(mix)).toEqual([]);
		expect(trackMixGains(mix)).toEqual({ left: 1, right: 1 });
	});

	test("gain renders as a dB volume filter", () => {
		expect(trackMixFilterChain({ gainDb: -6, pan: 0 })).toEqual([
			"volume=-6dB",
		]);
		expect(trackMixFilterChain({ gainDb: 3.25, pan: 0 })).toEqual([
			"volume=3.25dB",
		]);
	});

	test("pan renders a constant-power stereo balance after the gain", () => {
		expect(trackMixFilterChain({ gainDb: -3, pan: -1 })).toEqual([
			"volume=-3dB",
			"aformat=channel_layouts=stereo",
			"pan=stereo|c0=1.4142*c0|c1=0*c0",
		]);
		expect(trackMixFilterChain({ gainDb: 0, pan: 0.5 })).toEqual([
			"aformat=channel_layouts=stereo",
			"pan=stereo|c0=0.5412*c0|c1=1.3066*c1",
		]);
	});

	test("preview gains combine dB gain with the balance", () => {
		const gains = trackMixGains({ gainDb: -6, pan: 1 });
		expect(gains.left).toBe(0);
		expect(gains.right).toBeCloseTo(Math.SQRT2 * 0.501_187, 5);
	});

	test("stored track settings feed the mix", () => {
		const project = updateTrackSetting(newProject("Mix"), 2, {
			gainDb: -12,
			pan: 0.25,
		});
		expect(projectTrackMix(project, 2)).toEqual({ gainDb: -12, pan: 0.25 });
		expect(trackMixOf({})).toEqual({ gainDb: 0, pan: 0 });
	});
});
