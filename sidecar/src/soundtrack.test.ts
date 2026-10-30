import { expect, test } from "bun:test";
import {
	soundtrackExpression,
	soundtrackMediaArgs,
	synthesisTimeoutMs,
} from "./soundtrack.ts";

const graphInput = (args: string[]): string => {
	const index = args.indexOf("-i");
	return args[index + 1] ?? "";
};

test("soundtrack rhythm is driven by the requested tempo", () => {
	const slow = soundtrackMediaArgs(
		{ bpm: 60, duration: 4, mood: "warm" },
		"/tmp/slow.wav"
	);
	const fast = soundtrackMediaArgs(
		{ bpm: 120, duration: 4, mood: "warm" },
		"/tmp/fast.wav"
	);
	expect(graphInput(slow)).not.toBe(graphInput(fast));
	// Beat length (60/bpm) gates each pulse; beats-per-second drives bar changes.
	expect(graphInput(slow)).toContain("mod(t,1)");
	expect(graphInput(slow)).toContain("floor(t*1)");
	expect(graphInput(fast)).toContain("mod(t,0.5)");
	expect(graphInput(fast)).toContain("floor(t*2)");
});

test("soundtrack expression changes chord once per bar and keeps mood voicing", () => {
	const warm = soundtrackExpression({ bpm: 96, mood: "warm" });
	const tense = soundtrackExpression({ bpm: 96, mood: "tense" });
	expect(warm).toContain("sin(2*PI*220*");
	expect(tense).toContain("sin(2*PI*196*");
	expect(warm).toContain("floor(floor(t*1.6)/4)");
	expect(warm).toContain("0.8409");
	expect(warm.includes("'")).toBe(false);
});

test("original moods without layers or sections keep the published score", () => {
	expect(soundtrackExpression({ bpm: 120, mood: "warm" })).toBe(
		"(0.28*sin(2*PI*220*if(eq(mod(floor(floor(t*2)/4),4),0),1,if(eq(mod(floor(floor(t*2)/4),4),1),0.8409,if(eq(mod(floor(floor(t*2)/4),4),2),0.6674,0.7492)))*t)+0.18*sin(2*PI*277.18*if(eq(mod(floor(floor(t*2)/4),4),0),1,if(eq(mod(floor(floor(t*2)/4),4),1),0.8409,if(eq(mod(floor(floor(t*2)/4),4),2),0.6674,0.7492)))*t)+0.14*sin(2*PI*329.63*if(eq(mod(floor(floor(t*2)/4),4),0),1,if(eq(mod(floor(floor(t*2)/4),4),1),0.8409,if(eq(mod(floor(floor(t*2)/4),4),2),0.6674,0.7492)))*t))*min(1,mod(t,0.5)/0.015)*(0.25+0.75*exp(-3*mod(t,0.5)/0.5))*if(eq(mod(floor(t*2),4),0),1,0.72)"
	);
	const args = soundtrackMediaArgs(
		{ bpm: 96, duration: 4, mood: "warm" },
		"/tmp/warm.wav"
	);
	expect(args[args.indexOf("-filter_complex") + 1]).toBe(
		"[0:a]volume=0.75,afade=t=in:st=0:d=0.4,afade=t=out:st=3.4:d=0.6"
	);
});

test("sections drive an intensity curve that gates layers and moves the chords", () => {
	const expression = soundtrackExpression({
		bpm: 120,
		mood: "suspense",
		sections: [
			{ start: 0, end: 4, intensity: 0.2 },
			{ start: 4, end: 8, intensity: 1 },
		],
	});
	// Per-sample registers hold beat position, beat index, chord and intensity.
	expect(expression.startsWith("st(4,mod(t,0.5));st(5,floor(t*2));st(2,")).toBe(
		true
	);
	expect(expression).toContain(
		"st(3,0.2+0.8*clip((t-4)/0.05,0,1)+-0.5*clip((t-8)/0.05,0,1))"
	);
	// The second section starts two chords further on.
	expect(expression).toContain("+2*(gte(t,4))");
	// Bass enters above 0.2 and the hat above 0.55; the pad is never gated.
	expect(expression).toContain("clip((ld(3)-0.2)/0.1,0,1)");
	expect(expression).toContain("clip((ld(3)-0.55)/0.1,0,1)");
	expect(expression).toContain("(0.35+0.65*ld(3))*(");
	expect(expression.includes("'")).toBe(false);
	expect(expression.includes("|")).toBe(false);
});

test("explicit layers replace the style band and a full band is scaled below clipping", () => {
	const kickOnly = soundtrackExpression({
		bpm: 100,
		layers: ["kick"],
		mood: "cinematic",
	});
	expect(kickOnly).toContain("0.5*sin(2*PI*(50*ld(4)");
	expect(kickOnly).not.toContain("random(");
	const full = soundtrackExpression({
		bpm: 100,
		layers: ["pluck", "pad", "bass", "arpeggio", "kick", "hat", "snare"],
		mood: "upbeat",
	});
	// 1.1 headroom over the summed layer peaks of 1.93.
	expect(full).toContain(";0.569948*(");
	expect(full).toContain("random(0)");
	expect(full).toContain("random(1)");
});

test("lo-fi and ambient add their style filter before the master level", () => {
	const lofi = soundtrackMediaArgs(
		{ bpm: 80, duration: 4, mood: "lo-fi" },
		"/tmp/lofi.wav"
	);
	expect(lofi[lofi.indexOf("-filter_complex") + 1]).toStartWith(
		"[0:a]lowpass=f=3200,volume=0.75"
	);
	const ambient = soundtrackMediaArgs(
		{ bpm: 70, duration: 4, mood: "ambient" },
		"/tmp/ambient.wav"
	);
	expect(ambient[ambient.indexOf("-filter_complex") + 1]).toStartWith(
		"[0:a]aecho="
	);
});

test("synthesis time limits grow with duration", () => {
	expect(synthesisTimeoutMs(1)).toBe(121_000);
	expect(synthesisTimeoutMs(7200)).toBe(7_320_000);
});

test("a downbeat offset phases the rhythm clock but not oscillators or sections", () => {
	const request = {
		bpm: 120,
		downbeatOffset: 0.5,
		duration: 8,
		mood: "cinematic" as const,
		sections: [
			{ start: 0, end: 4.5, intensity: 0.3 },
			{ start: 4.5, end: 8, intensity: 1 },
		],
	};
	const expression = soundtrackExpression(request);
	// Bars are 2 s; a 1.5 s lead puts a bar start at 0.5 s.
	expect(expression).toContain("st(4,mod((t+1.5),0.5))");
	expect(expression).toContain("st(5,floor((t+1.5)*2))");
	expect(expression).toContain("gte(t,4.5)");
	expect(expression).toContain("clip((t-4.5)/0.05,0,1)");
	expect(expression).toContain("sin(2*PI*146.83*ld(2)*t)");
	// An offset already on the bar grid leaves the score unchanged.
	expect(soundtrackExpression({ ...request, downbeatOffset: 4 })).toBe(
		soundtrackExpression({ ...request, downbeatOffset: undefined })
	);
	expect(
		soundtrackExpression({ bpm: 96, downbeatOffset: 0, mood: "warm" })
	).toBe(soundtrackExpression({ bpm: 96, mood: "warm" }));
});
