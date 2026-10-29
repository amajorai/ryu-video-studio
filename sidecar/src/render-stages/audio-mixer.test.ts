import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	updateTrackSetting,
} from "../../../shared/project.ts";
import { segmentAudioFilters } from "../render-segment-audio.ts";
import { trackMixFilters } from "./audio-mix.ts";
import { tempoFilters } from "./audio-tempo.ts";

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-0000000000c3",
	kind: "audio",
	name: "Voice",
	width: 0,
};
const clip = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(asset, 0, 1),
	...patch,
});

describe("tempo stage", () => {
	test("keeps pitch with atempo by default", () => {
		expect(tempoFilters(clip())).toEqual(["anull"]);
		expect(tempoFilters(clip({ speed: 4 }))).toEqual(["atempo=2", "atempo=2"]);
	});

	test("renders tape-style speed when pitch is not preserved", () => {
		expect(tempoFilters(clip({ preservePitch: false, speed: 1.5 }))).toEqual([
			"aresample=48000",
			"asetrate=72000",
			"aresample=48000",
		]);
	});

	test("mutes clips above 16x unless muted is false", () => {
		expect(tempoFilters(clip({ speed: 50 })).at(-1)).toBe("volume=0");
		expect(tempoFilters(clip({ muted: false, speed: 50 }))).not.toContain(
			"volume=0"
		);
	});
});

describe("track mix stage", () => {
	test("reads the clip's track settings", () => {
		const project = updateTrackSetting(newProject("Mix"), 1, {
			gainDb: -6,
			pan: 1,
		});
		expect(trackMixFilters(project, 1)).toEqual([
			"volume=-6dB",
			"aformat=channel_layouts=stereo",
			"pan=stereo|c0=0*c0|c1=1.4142*c1",
		]);
		expect(trackMixFilters(project, 0)).toEqual([]);
	});

	test("sits after the clip fades and before the timeline delay", () => {
		const project = updateTrackSetting(newProject("Mix"), 1, { gainDb: -3 });
		const s = clip({ fadeIn: 0.5, start: 2 });
		const [chain] = segmentAudioFilters({
			length: 4,
			n: 3,
			p: project,
			s,
			visualize: false,
		});
		expect(chain).toContain(
			"afade=t=in:st=0:d=0.5,volume=-3dB,aresample=48000,adelay=96000S:all=1[a3]"
		);
	});

	test("legacy projects keep the byte-identical clip chain", () => {
		const [chain] = segmentAudioFilters({
			length: 4,
			n: 1,
			p: newProject("Legacy"),
			s: clip(),
			visualize: false,
		});
		expect(chain).toStartWith("[1:a]asetpts=PTS-STARTPTS,anull,");
		expect(chain).not.toContain("dB");
		expect(chain).toEndWith(",aresample=48000,adelay=0S:all=1[a1]");
	});
});
