import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import { compositeLayer } from "../render-composite.ts";
import { encodeArgs } from "../render-encode.ts";
import {
	audioMixFilters,
	segmentAudioFilters,
} from "../render-segment-audio.ts";
import { segmentVideoFilters } from "../render-segment-video.ts";
import { shadeHex } from "../render-spatial.ts";
import { adjustmentAfterTrack } from "./adjustment.ts";
import { captionStyleLine } from "./ass-captions.ts";
import { assBgr, assText, assTimestamp } from "./ass-common.ts";
import { titleEvents, titleStyles } from "./ass-titles.ts";
import { audioEffectFilters } from "./audio-effects.ts";
import { trackMixFilters } from "./audio-mix.ts";
import { clipPanFilters } from "./audio-pan.ts";
import { baseSource, clipBackgroundFilters } from "./background.ts";
import { advancedColorFilters } from "./color-advanced.ts";
import { basicColorFilters } from "./color-basic.ts";
import { cropFilters } from "./crop.ts";
import { flipFilters } from "./flip.ts";
import { keyFilters } from "./key.ts";
import { maskStage } from "./mask.ts";
import { opacityFilter } from "./opacity.ts";
import { padFilter, rotateFilter, scaledSize } from "./transform.ts";
import { fadeFilters, revealFilters } from "./transitions.ts";
import type { RenderStageContext } from "./types.ts";
import {
	previousDrawnClips,
	segmentAudible,
	segmentDrawsVideo,
	segmentVisible,
} from "./visibility.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: true,
	height: 360,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 640,
};

function fixture(): { p: Project; s: Segment } {
	const p = newProject("Stages");
	const s = newSegment(video);
	p.segments = [s];
	return { p, s };
}

const context: RenderStageContext = {
	inputIndex: (offset) => 10 + offset,
	lutPath: (id) => `/luts/${id}.cube`,
	mediaPath: (id) => `/media/${id}`,
};

describe("identity stubs keep today's render", () => {
	test("visual stubs add no filters", () => {
		const { s } = fixture();
		expect(keyFilters(s)).toEqual([]);
		expect(flipFilters(s)).toEqual([]);
		expect(advancedColorFilters(s, context)).toEqual([]);
		expect(revealFilters(s, undefined, 4)).toEqual([]);
	});
	test("audio stubs add no filters", () => {
		const { p, s } = fixture();
		expect(audioEffectFilters(s)).toEqual([]);
		expect(clipPanFilters(s)).toEqual([]);
		expect(trackMixFilters(p, 0)).toEqual([]);
	});
	test("label stages pass their input through", () => {
		const { p, s } = fixture();
		expect(maskStage(s, { ...context, input: "mask1in", n: 1 })).toEqual({
			filters: [],
			inputs: [],
			label: "mask1in",
		});
		expect(clipBackgroundFilters(s, p, "v1")).toEqual({
			filters: [],
			label: "v1",
		});
		expect(adjustmentAfterTrack(p, 3, "out2", 0)).toEqual({
			filters: [],
			last: "out2",
		});
		expect(titleStyles(p)).toEqual([]);
	});
});

describe("stages that reproduce current filters", () => {
	test("crop keeps a null placeholder when the clip is uncropped", () => {
		const { s } = fixture();
		expect(cropFilters(s)).toEqual(["null"]);
		expect(
			cropFilters({ ...s, crop: { bottom: 0.1, left: 0.2, right: 0, top: 0 } })
		).toEqual(["crop=w='iw*(1-0.2)':h='ih*(1-0.1)':x='iw*0.2':y='ih*0'"]);
	});
	test("basic color adds colorbalance only for temperature or tint", () => {
		const { s } = fixture();
		expect(basicColorFilters(s)).toEqual([
			"eq=brightness=0:contrast=1:saturation=1",
		]);
		expect(
			basicColorFilters({
				...s,
				colorGrade: { exposure: 0.3, temperature: 0.2, tint: 0, vibrance: 0.4 },
			})
		).toEqual([
			"eq=brightness=0.1:contrast=1:saturation=1.2",
			"colorbalance=rs=0.2:gs=0:bs=-0.2",
		]);
	});
	test("opacity switches to a per-pixel expression when keyframed", () => {
		const { s } = fixture();
		expect(opacityFilter({ ...s, opacity: 0.5 })).toBe(
			"colorchannelmixer=aa=0.5"
		);
		expect(
			opacityFilter({
				...s,
				keyframes: [
					{
						id: "00000000-0000-4000-8000-000000000002",
						property: "opacity",
						time: 0,
						value: 0.5,
					},
				],
			})
		).toStartWith("geq=r='r(X,Y)'");
	});
	test("transform sizes are even and the pad covers the largest scale", () => {
		const { p, s } = fixture();
		expect(scaledSize(s, p)).toEqual({
			h: "2*max(1,round(1080*(1)/2))",
			w: "2*max(1,round(1920*(1)/2))",
		});
		expect(rotateFilter({ ...s, rotation: 30 })).toBe(
			"rotate=a='(30)*PI/180':ow=iw:oh=ih:fillcolor=black@0"
		);
		expect(padFilter({ ...s, scale: 1.5 }, p)).toBe(
			"pad=2880:1620:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame"
		);
	});
	test("fades combine the crossfade entry and clip fades", () => {
		const { s } = fixture();
		expect(
			fadeFilters(
				{ ...s, entryTransition: "crossfade", fadeIn: 0.2, fadeOut: 0.5 },
				4
			)
		).toEqual([
			"fade=t=in:st=0:d=0.5:alpha=1",
			"fade=t=in:st=0:d=0.2:alpha=1",
			"fade=t=out:st=3.5:d=0.5:alpha=1",
		]);
	});
	test("audibility follows asset audio, track state and volume", () => {
		const { p, s } = fixture();
		expect(segmentVisible(p, s)).toBe(true);
		expect(segmentAudible(p, s, video)).toBe(true);
		expect(segmentAudible(p, s, { ...video, hasAudio: false })).toBe(false);
		expect(segmentAudible(p, s, undefined)).toBe(false);
		expect(segmentAudible(p, { ...s, volume: 0 }, video)).toBe(false);
		expect(segmentAudible(p, { ...s, muted: true }, video)).toBe(false);
		expect(segmentAudible(p, { ...s, speed: 20 }, video)).toBe(false);
		expect(segmentAudible(p, { ...s, muted: false, speed: 20 }, video)).toBe(
			true
		);
		expect(
			segmentAudible(
				{
					...p,
					trackSettings: [
						{
							locked: false,
							muted: true,
							name: "Video 1",
							solo: false,
							track: 0,
						},
					],
				},
				s,
				video
			)
		).toBe(false);
	});
	test("the canvas source renders one frame for frame previews", () => {
		const { p } = fixture();
		const exported = baseSource(p, 4, undefined);
		expect(exported.args.at(-1)).toEndWith(":d=4");
		expect(exported.filters).toEqual(["[0:v]format=yuv420p[base]"]);
		const frame = baseSource(p, 4, 1.5);
		expect(frame.args.at(-1)).toEndWith(`:d=${1 / 30}`);
		expect(frame.filters).toEqual([
			"[0:v]format=yuv420p,setpts=PTS+1.5/TB[base]",
		]);
	});
});

describe("segment chains", () => {
	test("a clip renders as one chain statement plus its overlay", () => {
		const { p, s } = fixture();
		const output = segmentVideoFilters({
			base: "base",
			context,
			length: 4,
			n: 1,
			p,
			s,
			visualize: false,
		});
		expect(output.last).toBe("out1");
		expect(output.inputs).toEqual([]);
		expect(output.filters).toHaveLength(2);
		expect(output.filters[0]).toStartWith(
			"[1:v]setpts=(PTS-STARTPTS)/1,fps=30,null,eq=brightness=0"
		);
		expect(output.filters[0]).toEndWith("setpts=PTS+0/TB[v1]");
		expect(output.filters[1]).toStartWith("[base][v1]overlay=");
	});
	test("compositeLayer is a plain alpha-over overlay", () => {
		const { s } = fixture();
		expect(
			compositeLayer({
				base: "base",
				enable: "between(t,0,4)",
				layer: "v1",
				out: "out1",
				s,
				x: "0",
				y: "0",
			})
		).toEqual([
			"[base][v1]overlay=x='0':y='0':eof_action=pass:enable='between(t,0,4)'[out1]",
		]);
	});
	test("audio chains keep today's order and end in a delayed label", () => {
		const { p, s } = fixture();
		expect(
			segmentAudioFilters({
				length: 4,
				n: 2,
				p,
				s: { ...s, fadeIn: 0.25, start: 1.5 },
				visualize: false,
			})
		).toEqual([
			"[2:a]asetpts=PTS-STARTPTS,anull,anull,volume='1':eval=frame,afade=t=in:st=0:d=0.25,aresample=48000,adelay=72000S:all=1[a2]",
		]);
	});
	test("the mix is empty without audio and ducks against the other clips", () => {
		expect(
			audioMixFilters({ all: [], ducked: [], sidechain: [], until: 4 })
		).toEqual([]);
		expect(
			audioMixFilters({
				all: ["[a1]"],
				ducked: [],
				sidechain: ["[a1]"],
				until: 4,
			})
		).toEqual([
			"[a1]amix=inputs=1:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]",
		]);
		const ducked = audioMixFilters({
			all: ["[a1]", "[a2]"],
			ducked: ["[a1]"],
			sidechain: ["[a2]"],
			until: 4,
		});
		// Both gate inputs are held to the same length past the timeline, so
		// neither ending first can cut the other's tail. The default dip is
		// 9 dB: the enveloped copy is subtracted at 1 - 10^(-9/20).
		expect(ducked.slice(0, -1)).toEqual([
			"[a2]amix=inputs=1:normalize=0,apad=whole_dur=5[sidechainMix]",
			"[sidechainMix]asplit=2[sidechainMain][sidechain0]",
			"[a1]apad=whole_dur=5[duckHeld0]",
			"[sidechain0]dcshift=shift=0.000001,asplit=2[duck0KeyA][duck0KeyB]",
			"[duck0KeyA]aeval=exprs=1:c=mono[duck0One]",
			"[duck0One][duck0KeyB]sidechaingate=threshold=0.02:ratio=9000:range=0.000001:knee=1:attack=5:release=60:detection=rms[duck0Voiced]",
			"[duckHeld0]asplit=2[duck0Dry][duck0Wet]",
			"[duck0Wet][duck0Voiced]sidechaingate=threshold=1:ratio=2:range=0:knee=1:attack=36.409569:release=455.119613:detection=peak,volume=-0.645187[duck0Cut]",
			"[duck0Dry][duck0Cut]amix=inputs=2:normalize=0[ducked0]",
		]);
		expect(ducked.at(-1)).toBe(
			"[sidechainMain][ducked0]amix=inputs=2:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]"
		);
	});
	test("each ducked clip uses its own amount, attack and release", () => {
		const filters = audioMixFilters({
			all: ["[a1]", "[a2]", "[a3]"],
			ducked: ["[a1]", "[a3]"],
			duckSettings: [{ amountDb: 12, attackMs: 50, releaseMs: 600 }, undefined],
			sidechain: ["[a2]"],
			until: 4,
		});
		expect(filters).toContain(
			"[duck0Wet][duck0Voiced]sidechaingate=threshold=1:ratio=2:range=0:knee=1:attack=91.023923:release=1092.287072:detection=peak,volume=-0.748811[duck0Cut]"
		);
		expect(filters).toContain(
			"[duck1Wet][duck1Voiced]sidechaingate=threshold=1:ratio=2:range=0:knee=1:attack=36.409569:release=455.119613:detection=peak,volume=-0.645187[duck1Cut]"
		);
	});
});

describe("ASS helpers", () => {
	test("timestamps round to centiseconds and text escapes overrides", () => {
		expect(assTimestamp(3725.456)).toBe("1:02:05.46");
		expect(assText("a{b}\\c\nd")).toBe("a｛b｝＼c\\Nd");
		expect(assBgr("#112233")).toBe("332211");
	});
	test("titles position or slide in and the caption style scales with height", () => {
		const { p } = fixture();
		const title = {
			animation: "slide-up" as const,
			color: "#ff0000",
			end: 2,
			fadeIn: 0.5,
			fadeOut: 0,
			fontSize: 0.1,
			id: "00000000-0000-4000-8000-000000000003",
			start: 0,
			text: "Hi",
			x: 0.5,
			y: 0.5,
		};
		expect(titleEvents(title, p)).toEqual([
			"Dialogue: 1,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\an5\\move(960,626,960,540,0,500)\\fs108\\c&H0000ff&\\fad(500,0)}Hi",
		]);
		expect(titleEvents({ ...title, animation: "fade" }, p)[0]).toContain(
			"\\pos(960,540)"
		);
		expect(captionStyleLine(p)).toStartWith("Style: Default,Arial,49,");
	});
});

describe("encoder arguments", () => {
	test("frame renders are one RGBA PNG without audio", () => {
		const { p } = fixture();
		expect(
			encodeArgs(p, {}, { duration: 4, frameTime: 1, video: "out1" })
		).toEqual([
			"-map",
			"[out1]",
			"-frames:v",
			"1",
			"-an",
			"-c:v",
			"png",
			"-pix_fmt",
			"rgba",
			"-fps_mode",
			"passthrough",
			"-threads",
			"2",
		]);
	});
	test("export options resolve through the render plan (W2-E1)", () => {
		const { p } = fixture();
		const graph = { duration: 4, video: "out1" };
		expect(() => encodeArgs(p, { audioOnly: true }, graph)).toThrow(
			"Nothing on the timeline is audible"
		);
		expect(
			encodeArgs(p, { range: { end: 2, start: 1 } }, graph).join(" ")
		).toContain("-ss 1 -t 1 ");
		expect(
			encodeArgs(p, { overrides: { includeAudio: false } }, graph)
		).toContain("-an");
	});
});

test("stage-world shading clamps each channel", () => {
	expect(shadeHex("#808080", 1)).toBe("0x808080");
	expect(shadeHex("#c0c0c0", 2)).toBe("0xffffff");
	expect(shadeHex("#ff0000", 0.5)).toBe("0x800000");
});

describe("previous drawn clips", () => {
	test("skip audio-only clips, keep waveforms, and ignore frame filtering", () => {
		const { p, s } = fixture();
		const audio: Asset = {
			...video,
			id: "00000000-0000-4000-8000-000000000002",
			kind: "audio",
		};
		const music = { ...newSegment(audio), start: 4 };
		const waveform = {
			...newSegment(audio),
			start: 6,
			visualization: "waveform" as const,
		};
		const next = { ...newSegment(video), start: 8 };
		const otherTrack = { ...newSegment(video), start: 9, track: 1 };
		p.segments = [next, waveform, s, music, otherTrack];
		const previous = previousDrawnClips(p, [video, audio]);
		expect(previous.get(s.id)).toBeUndefined();
		expect(previous.get(music.id)?.id).toBe(s.id);
		expect(previous.get(waveform.id)?.id).toBe(s.id);
		expect(previous.get(next.id)?.id).toBe(waveform.id);
		expect(previous.get(otherTrack.id)).toBeUndefined();
		expect(segmentDrawsVideo(p, music, audio)).toBe(false);
		expect(segmentDrawsVideo(p, waveform, audio)).toBe(true);
	});
});
