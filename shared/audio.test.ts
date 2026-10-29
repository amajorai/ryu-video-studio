import { expect, test } from "bun:test";
import {
	audioCleanupFilters,
	audioProcessingFilters,
	channelModeMatrix,
	cleanupNeedsIsolation,
	clipPanFilterChain,
	escapeFilterPath,
	filterNumber,
	panGains,
	panMatrix,
} from "./audio.ts";
import { audioCleanupOf } from "./schema/defaults.ts";

test("audio processing modes expose bounded local filter graphs", () => {
	expect(audioProcessingFilters("denoise")).toEqual([
		"highpass=f=70",
		"lowpass=f=16000",
		"afftdn=nr=18:nf=-35",
	]);
	expect(audioProcessingFilters("none")).toEqual(["anull"]);
	expect(audioProcessingFilters("normalize")).toEqual([
		"loudnorm=I=-16:TP=-1.5:LRA=11",
	]);
	expect(audioProcessingFilters("voice-enhance")).toEqual([
		"highpass=f=80",
		"lowpass=f=14000",
		"afftdn=nr=12",
		"acompressor=threshold=-18dB:ratio=3:attack=20:release=250",
	]);
});

const off = { denoise: 0, enhance: 0, normalize: false, voiceIsolation: 0 };

test("graded cleanup maps each control to its filters in a fixed order", () => {
	expect(audioCleanupFilters(off, { rnnoiseModel: null })).toEqual(["anull"]);
	expect(
		audioCleanupFilters(
			{ denoise: 1, enhance: 1, normalize: true, voiceIsolation: 0.5 },
			{ rnnoiseModel: "/m.rnnn" }
		)
	).toEqual([
		"afftdn=nr=30:nf=-30",
		"highpass=f=80",
		"lowpass=f=14000",
		"acompressor=threshold=-18dB:ratio=4:attack=20:release=250",
		"equalizer=f=3000:t=q:w=1:g=3",
		"arnndn=m=/m.rnnn:mix=0.5",
		"loudnorm=I=-16:TP=-1.5:LRA=11",
	]);
	expect(
		audioCleanupFilters({ ...off, denoise: 0.25 }, { rnnoiseModel: null })
	).toEqual(["afftdn=nr=12:nf=-45"]);
});

test("voice isolation is skipped when arnndn is unavailable", () => {
	const cleanup = { ...off, voiceIsolation: 1 };
	expect(cleanupNeedsIsolation(cleanup)).toBe(true);
	expect(cleanupNeedsIsolation(off)).toBe(false);
	expect(audioCleanupFilters(cleanup, { rnnoiseModel: null })).toEqual([
		"anull",
	]);
});

test("legacy presets resolve to graded cleanup values", () => {
	expect(audioCleanupOf({ audioProcessing: "voice-enhance" })).toEqual({
		...off,
		denoise: 0.4,
		enhance: 0.6,
	});
	expect(
		audioCleanupOf({
			audioCleanup: { normalize: true },
			audioProcessing: "denoise",
		})
	).toEqual({ ...off, normalize: true });
});

test("balance is constant power and exact at centre and extremes", () => {
	expect(panGains(0)).toEqual({ left: 1, right: 1 });
	expect(panGains(-1)).toEqual({ left: Math.SQRT2, right: 0 });
	expect(panGains(1)).toEqual({ left: 0, right: Math.SQRT2 });
	for (const pan of [-0.7, -0.2, 0.4, 0.9]) {
		const { left, right } = panGains(pan);
		expect(left ** 2 + right ** 2).toBeCloseTo(2, 10);
	}
	expect(panGains(Number.NaN)).toEqual({ left: 1, right: 1 });
	expect(panGains(5)).toEqual(panGains(1));
});

test("channel modes route both outputs", () => {
	expect(channelModeMatrix("swap")).toEqual([
		[0, 1],
		[1, 0],
	]);
	expect(panMatrix("left", -1)).toEqual([
		[Math.SQRT2, 0],
		[0, 0],
	]);
});

test("pan filters are empty for centred stereo and a matrix otherwise", () => {
	expect(clipPanFilterChain({ channelMode: "stereo", pan: 0 })).toEqual([]);
	expect(clipPanFilterChain({ channelMode: "mono", pan: 0 })).toEqual([
		"aformat=channel_layouts=stereo",
		"pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1",
	]);
	expect(clipPanFilterChain({ channelMode: "stereo", pan: -1 })).toEqual([
		"aformat=channel_layouts=stereo",
		"pan=stereo|c0=1.4142*c0|c1=0*c0",
	]);
	expect(clipPanFilterChain({ channelMode: "swap", pan: 0 })).toEqual([
		"aformat=channel_layouts=stereo",
		"pan=stereo|c0=1*c1|c1=1*c0",
	]);
});

test("animated pan renders per-channel aeval expressions", () => {
	const [shape, aeval] = clipPanFilterChain({
		channelMode: "right",
		pan: 0,
		panExpression: "if(lt(t,1),-1+2*t,1)",
	});
	expect(shape).toBe("aformat=channel_layouts=stereo");
	expect(aeval).toBe(
		"aeval=exprs='sqrt(2)*cos((min(1,max(-1,(if(lt(t,1),-1+2*t,1))))+1)*PI/4)*(0*val(0)+1*val(1))|sqrt(2)*sin((min(1,max(-1,(if(lt(t,1),-1+2*t,1))))+1)*PI/4)*(0*val(0)+1*val(1))':channel_layout=same"
	);
});

test("filter numbers and paths are deterministic and escaped", () => {
	expect(filterNumber(1 / 3)).toBe("0.3333");
	expect(filterNumber(-0.000_01)).toBe("0");
	expect(escapeFilterPath("/a/b.rnnn")).toBe("/a/b.rnnn");
	expect(escapeFilterPath("C:\\m,o[d]'l;")).toBe(
		String.raw`C\\:\\\\m\,o\[d\]\\\'l\;`
	);
});
