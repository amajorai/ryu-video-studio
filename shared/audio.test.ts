import { expect, test } from "bun:test";
import { audioProcessingFilters } from "./audio.ts";

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
