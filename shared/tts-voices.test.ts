import { describe, expect, test } from "bun:test";
import {
	catalogHasVoices,
	choiceFromOption,
	choiceLanguages,
	describeVoice,
	EMPTY_VOICE_CHOICE,
	languageLabel,
	narrationVoiceFields,
	ttsVoiceCatalog,
	voiceOptionValue,
} from "./tts-voices.ts";

const kokoro = {
	default_voice: "af_heart",
	description: "Fast local voices",
	display_name: "Kokoro",
	id: "kokoro",
	installed: true,
	languages: ["en-us", "en-gb", "fr-fr", "ja"],
	loaded: true,
	sample_rate: 24_000,
	size_mb: 330,
	supports_cloning: false,
	voices: ["af_heart", "am_michael", "bf_emma", "ff_siwis", "jf_alpha"],
};
const piper = {
	default_voice: "de_DE-thorsten-medium",
	display_name: "Piper",
	id: "piper",
	installed: true,
	languages: ["de"],
	voices: ["de_DE-thorsten-medium"],
};
const cloner = {
	display_name: "Chatterbox",
	id: "chatterbox",
	installed: false,
	languages: ["en"],
	voices: ["default"],
};

describe("text-to-speech voice catalog", () => {
	test("groups installed voices by engine and language with readable labels", () => {
		const catalog = ttsVoiceCatalog({ data: [kokoro, piper, cloner] });
		expect(
			catalog.groups.map((group) => [
				group.engineLabel,
				group.languageLabel,
				group.voices.map((voice) => voice.label),
			])
		).toEqual([
			["Kokoro", "English (UK)", ["Emma (female)"]],
			["Kokoro", "English (US)", ["Heart (female)", "Michael (male)"]],
			["Kokoro", "French", ["Siwis (female)"]],
			["Kokoro", "Japanese", ["Alpha (female)"]],
			["Piper", "German", ["de_DE-thorsten-medium"]],
		]);
		expect(
			catalog.engines.map((engine) => [engine.id, engine.installed])
		).toEqual([
			["kokoro", true],
			["piper", true],
			["chatterbox", false],
		]);
		expect(catalogHasVoices(catalog)).toBe(true);
	});

	test("drops malformed rows and duplicate engines, and accepts a bare array", () => {
		const catalog = ttsVoiceCatalog([
			null,
			{ id: "" },
			{ id: 7 },
			kokoro,
			{ ...kokoro, voices: ["zm_yunxi"] },
		]);
		expect(catalog.engines).toHaveLength(1);
		expect(catalog.groups.flatMap((group) => group.voices)).toHaveLength(5);
		expect(catalogHasVoices(ttsVoiceCatalog("nope"))).toBe(false);
		expect(catalogHasVoices(ttsVoiceCatalog({ data: [cloner] }))).toBe(false);
	});

	test("reads Kokoro prefixes only when the engine speaks that language", () => {
		expect(describeVoice("bm_george", ["en-gb"])).toEqual({
			label: "George (male)",
			language: "en-gb",
		});
		expect(describeVoice("jf_alpha", ["en-us", "de"])).toEqual({
			label: "jf_alpha",
			language: "",
		});
		expect(describeVoice("narrator", ["es"])).toEqual({
			label: "narrator",
			language: "es",
		});
		expect(languageLabel("")).toBe("Any language");
		expect(languageLabel("xx-yy")).toBe("xx-yy");
	});

	test("choosing a voice sets its engine and language", () => {
		const catalog = ttsVoiceCatalog([kokoro, piper]);
		const french = voiceOptionValue({ engine: "kokoro", voice: "ff_siwis" });
		expect(choiceFromOption(catalog, french, EMPTY_VOICE_CHOICE)).toEqual({
			engine: "kokoro",
			language: "fr-fr",
			voice: "ff_siwis",
		});
		expect(
			choiceFromOption(catalog, "", {
				engine: "kokoro",
				language: "fr-fr",
				voice: "ff_siwis",
			})
		).toEqual({ engine: "", language: "fr-fr", voice: "" });
		expect(choiceLanguages(catalog, "piper")).toEqual(["de"]);
		expect(choiceLanguages(catalog, "")).toContain("ja");
	});

	test("narration fields keep only what was chosen", () => {
		expect(narrationVoiceFields(EMPTY_VOICE_CHOICE)).toEqual({});
		expect(
			narrationVoiceFields({
				engine: "kokoro",
				language: " ",
				voice: "af_heart",
			})
		).toEqual({ engine: "kokoro", voice: "af_heart" });
	});
});
