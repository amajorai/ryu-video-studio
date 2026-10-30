import { z } from "zod";

/**
 * The host's speech-engine listing (`window.ryu.media.ttsEngines()`), turned
 * into a voice picker: voices grouped by engine and language, with a
 * readable label per voice. Unknown or malformed rows are dropped, so a
 * host that lists nothing usable leaves the picker on its free-text field.
 */

const engineRowSchema = z.object({
	id: z.string().trim().min(1).max(64),
	display_name: z.string().max(200).optional(),
	default_voice: z.string().max(100).optional(),
	installed: z.boolean().optional(),
	loaded: z.boolean().optional(),
	languages: z.array(z.string().max(35)).max(200).optional(),
	voices: z.array(z.string().max(100)).max(2000).optional(),
});

/** One selectable voice. `language` is empty when the engine does not say. */
export interface TtsVoiceOption {
	engine: string;
	label: string;
	/** BCP 47-style language the voice speaks, or "" when unknown. */
	language: string;
	voice: string;
}

/** Voices of one engine that speak one language. */
export interface TtsVoiceGroup {
	engine: string;
	engineLabel: string;
	language: string;
	languageLabel: string;
	voices: TtsVoiceOption[];
}

export interface TtsEngineEntry {
	defaultVoice: string;
	id: string;
	installed: boolean;
	label: string;
	languages: string[];
}

export interface TtsVoiceCatalog {
	engines: TtsEngineEntry[];
	groups: TtsVoiceGroup[];
}

/** What a narration request needs from the picker; "" means engine default. */
export interface TtsVoiceChoice {
	engine: string;
	language: string;
	voice: string;
}

export const ttsVoiceChoiceSchema = z.object({
	engine: z.string().trim().max(64).default(""),
	language: z.string().trim().max(35).default(""),
	voice: z.string().trim().max(100).default(""),
});

export const EMPTY_VOICE_CHOICE: TtsVoiceChoice = {
	engine: "",
	language: "",
	voice: "",
};

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
	ar: "Arabic",
	de: "German",
	en: "English",
	"en-gb": "English (UK)",
	"en-us": "English (US)",
	es: "Spanish",
	fr: "French",
	"fr-fr": "French",
	hi: "Hindi",
	it: "Italian",
	ja: "Japanese",
	ko: "Korean",
	nl: "Dutch",
	pl: "Polish",
	pt: "Portuguese",
	"pt-br": "Portuguese (Brazil)",
	ru: "Russian",
	tr: "Turkish",
	zh: "Chinese (Mandarin)",
};

/** A readable name for a language code; the code itself when unknown. */
export function languageLabel(code: string): string {
	if (!code) {
		return "Any language";
	}
	return LANGUAGE_NAMES[code.toLowerCase()] ?? code;
}

/**
 * Kokoro-style voice ids (`af_heart`, `bm_george`): the first letter names
 * the language and the second the voice's gender.
 */
const KOKORO_LANGUAGE: Readonly<Record<string, string>> = {
	a: "en-us",
	b: "en-gb",
	e: "es",
	f: "fr-fr",
	h: "hi",
	i: "it",
	j: "ja",
	p: "pt-br",
	z: "zh",
};
const KOKORO_VOICE = /^([abefhijpz])([fm])_([a-z0-9]+)$/;

const titleCase = (text: string) =>
	text.charAt(0).toUpperCase() + text.slice(1);

/** The language family a code belongs to (`en-us` → `en`). */
const baseLanguage = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/**
 * The language and label of a voice id. Kokoro-style ids are read from their
 * prefix; others keep their id as the label and speak every language the
 * engine lists (when it lists exactly one, that one).
 */
export function describeVoice(
	voice: string,
	engineLanguages: readonly string[]
): { label: string; language: string } {
	const match = KOKORO_VOICE.exec(voice);
	const prefixLanguage = match ? KOKORO_LANGUAGE[match[1] ?? ""] : undefined;
	if (match && prefixLanguage) {
		const engineSpeaks =
			engineLanguages.length === 0 ||
			engineLanguages.some(
				(code) =>
					code.toLowerCase() === prefixLanguage ||
					baseLanguage(code) === baseLanguage(prefixLanguage)
			);
		if (engineSpeaks) {
			const gender = match[2] === "f" ? "female" : "male";
			return {
				label: `${titleCase(match[3] ?? voice)} (${gender})`,
				language: prefixLanguage,
			};
		}
	}
	return {
		label: voice,
		language: engineLanguages.length === 1 ? (engineLanguages[0] ?? "") : "",
	};
}

/** Accepts the bare array or a `{ data: [...] }` envelope. */
function engineRows(listing: unknown): unknown[] {
	if (Array.isArray(listing)) {
		return listing;
	}
	const data = (listing as { data?: unknown } | null)?.data;
	return Array.isArray(data) ? data : [];
}

/**
 * Parse a host engine listing into engines and voice groups. Engines that
 * report `installed: false` are kept in `engines` (so the picker can say
 * they need installing) but contribute no voices.
 */
export function ttsVoiceCatalog(listing: unknown): TtsVoiceCatalog {
	const engines: TtsEngineEntry[] = [];
	const groups = new Map<string, TtsVoiceGroup>();
	const seen = new Set<string>();
	for (const row of engineRows(listing)) {
		const parsed = engineRowSchema.safeParse(row);
		if (!parsed.success || seen.has(parsed.data.id)) {
			continue;
		}
		const engine = parsed.data;
		seen.add(engine.id);
		const languages = [
			...new Set((engine.languages ?? []).map((code) => code.trim())),
		].filter(Boolean);
		const installed = engine.installed !== false;
		const label = engine.display_name?.trim() || engine.id;
		engines.push({
			defaultVoice: engine.default_voice?.trim() ?? "",
			id: engine.id,
			installed,
			label,
			languages,
		});
		if (!installed) {
			continue;
		}
		for (const raw of new Set(engine.voices ?? [])) {
			const voice = raw.trim();
			if (!voice) {
				continue;
			}
			const described = describeVoice(voice, languages);
			const key = `${engine.id}\u0000${described.language}`;
			let group = groups.get(key);
			if (!group) {
				group = {
					engine: engine.id,
					engineLabel: label,
					language: described.language,
					languageLabel: languageLabel(described.language),
					voices: [],
				};
				groups.set(key, group);
			}
			group.voices.push({
				engine: engine.id,
				label: described.label,
				language: described.language,
				voice,
			});
		}
	}
	const sorted = [...groups.values()].sort(
		(left, right) =>
			left.engineLabel.localeCompare(right.engineLabel) ||
			left.languageLabel.localeCompare(right.languageLabel)
	);
	for (const group of sorted) {
		group.voices.sort((left, right) => left.label.localeCompare(right.label));
	}
	return { engines, groups: sorted };
}

/** Whether the listing offers anything to pick (otherwise keep free text). */
export function catalogHasVoices(catalog: TtsVoiceCatalog): boolean {
	return catalog.groups.some((group) => group.voices.length > 0);
}

/** Select-option value for a choice: engine and voice, NUL-free. */
export function voiceOptionValue(choice: {
	engine: string;
	voice: string;
}): string {
	return choice.voice ? `${choice.engine}/${choice.voice}` : "";
}

/**
 * The choice an option value selects. Picking a voice also sets its
 * language when it is known, so the engine reads the text in that voice's
 * language.
 */
export function choiceFromOption(
	catalog: TtsVoiceCatalog,
	value: string,
	current: TtsVoiceChoice
): TtsVoiceChoice {
	if (!value) {
		return { ...current, engine: "", voice: "" };
	}
	for (const group of catalog.groups) {
		const option = group.voices.find(
			(candidate) => voiceOptionValue(candidate) === value
		);
		if (option) {
			return {
				engine: option.engine,
				language: option.language || current.language,
				voice: option.voice,
			};
		}
	}
	return current;
}

/** Languages the language picker offers for the chosen engine (or all). */
export function choiceLanguages(
	catalog: TtsVoiceCatalog,
	engine: string
): string[] {
	const languages = new Set<string>();
	for (const entry of catalog.engines) {
		if (entry.installed && (!engine || entry.id === engine)) {
			for (const code of entry.languages) {
				languages.add(code);
			}
		}
	}
	for (const group of catalog.groups) {
		if (group.language && (!engine || group.engine === engine)) {
			languages.add(group.language);
		}
	}
	return [...languages].sort((left, right) =>
		languageLabel(left).localeCompare(languageLabel(right))
	);
}

/**
 * The `media.tts` fields a choice adds: only the non-empty ones, so an
 * empty choice keeps the node's default engine and voice.
 */
export function narrationVoiceFields(
	choice: Partial<TtsVoiceChoice>
): Partial<TtsVoiceChoice> {
	const fields: Partial<TtsVoiceChoice> = {};
	for (const key of ["engine", "voice", "language"] as const) {
		const value = choice[key]?.trim();
		if (value) {
			fields[key] = value;
		}
	}
	return fields;
}
