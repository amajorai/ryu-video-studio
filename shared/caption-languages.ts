import { z } from "zod";

/**
 * Transcription language hint: `auto` (let the engine detect it) or a
 * BCP-47 tag such as `en`, `pt-BR`, or `zh-Hant`.
 */
export const transcriptLanguageSchema = z
	.string()
	.trim()
	.max(35)
	.regex(
		/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/,
		"Use auto or a BCP-47 language tag."
	);

export interface TranscriptLanguage {
	label: string;
	value: string;
}

/** Picker options: automatic detection first, then common languages. */
export const TRANSCRIPT_LANGUAGES: readonly TranscriptLanguage[] = [
	{ label: "Detect automatically", value: "auto" },
	{ label: "English", value: "en" },
	{ label: "Spanish", value: "es" },
	{ label: "French", value: "fr" },
	{ label: "German", value: "de" },
	{ label: "Italian", value: "it" },
	{ label: "Portuguese", value: "pt" },
	{ label: "Portuguese (Brazil)", value: "pt-BR" },
	{ label: "Dutch", value: "nl" },
	{ label: "Polish", value: "pl" },
	{ label: "Turkish", value: "tr" },
	{ label: "Russian", value: "ru" },
	{ label: "Ukrainian", value: "uk" },
	{ label: "Arabic", value: "ar" },
	{ label: "Hebrew", value: "he" },
	{ label: "Hindi", value: "hi" },
	{ label: "Bengali", value: "bn" },
	{ label: "Indonesian", value: "id" },
	{ label: "Vietnamese", value: "vi" },
	{ label: "Thai", value: "th" },
	{ label: "Japanese", value: "ja" },
	{ label: "Korean", value: "ko" },
	{ label: "Chinese (Simplified)", value: "zh-Hans" },
	{ label: "Chinese (Traditional)", value: "zh-Hant" },
	{ label: "Swedish", value: "sv" },
	{ label: "Greek", value: "el" },
];
