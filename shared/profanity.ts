import { z } from "zod";

/** How caption profanity is treated: left alone, masked (`f***`), or dropped. */
export type ProfanityMode = "none" | "mask" | "remove";

/**
 * A small, locally bundled list of common English profanity roots. Matching
 * is whole-word only (after trimming punctuation), so place names and longer
 * words that merely contain a root are never altered. Callers extend the list
 * per request with `profanityWords`.
 */
export const BUNDLED_PROFANITY: readonly string[] = [
	"arse",
	"arsehole",
	"ass",
	"asshole",
	"bastard",
	"bitch",
	"bollocks",
	"bullshit",
	"cock",
	"crap",
	"cunt",
	"damn",
	"dick",
	"dickhead",
	"dicks",
	"dipshit",
	"fuck",
	"fucker",
	"goddamn",
	"jackass",
	"motherfucker",
	"piss",
	"prick",
	"shit",
	"shite",
	"slut",
	"twat",
	"wank",
	"wanker",
	"whore",
];

/** Roots whose common inflections (`fucking`, `shitty`, `bitches`) also match. */
const INFLECTED_ROOTS: readonly string[] = [
	"bitch",
	"cunt",
	"damn",
	"fuck",
	"piss",
	"shit",
	"twat",
	"wank",
	"whore",
];
const SUFFIXES = ["", "s", "es", "ed", "er", "ers", "ing", "in", "y", "ty"];

/** At most 200 extra words, each a single token of letters, digits, or `'`. */
export const profanityWordsSchema = z
	.array(
		z
			.string()
			.trim()
			.min(1)
			.max(40)
			.regex(/^[\p{L}\p{N}']+$/u, "Use single words without spaces.")
	)
	.max(200);

/** Lowercase letters/digits core of a token, without surrounding punctuation. */
export function profanityKey(token: string): string {
	return token
		.normalize("NFKC")
		.toLowerCase()
		.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export type ProfanityMatcher = (token: string) => boolean;

/** Build a whole-word matcher from the bundled list plus `extraWords`. */
export function profanityMatcher(
	extraWords: readonly string[] = []
): ProfanityMatcher {
	const exact = new Set<string>(BUNDLED_PROFANITY);
	for (const word of extraWords) {
		const key = profanityKey(word);
		if (key) {
			exact.add(key);
		}
	}
	for (const root of INFLECTED_ROOTS) {
		for (const suffix of SUFFIXES) {
			exact.add(root + suffix);
		}
		// Doubled consonant forms: `shitter`, `twatty`.
		for (const suffix of ["er", "ers", "ing", "y", "ed"]) {
			exact.add(root + root.at(-1) + suffix);
		}
	}
	return (token) => {
		const key = profanityKey(token);
		return key.length > 0 && exact.has(key);
	};
}

/**
 * Mask a token, keeping its first letter and any surrounding punctuation:
 * `Shit!` becomes `S***!`.
 */
export function maskToken(token: string): string {
	const match = token.match(/^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u);
	const lead = match?.[1] ?? "";
	const core = [...(match?.[2] ?? token)];
	const tail = match?.[3] ?? "";
	if (core.length <= 1) {
		return `${lead}${"*".repeat(core.length)}${tail}`;
	}
	return `${lead}${core[0]}${"*".repeat(core.length - 1)}${tail}`;
}

/**
 * Apply `mode` to every whitespace-separated token of `text`. Removal also
 * collapses the whitespace left behind. Returns the input unchanged for
 * `none`.
 */
export function filterProfanity(
	text: string,
	mode: ProfanityMode,
	matches: ProfanityMatcher = profanityMatcher()
): string {
	if (mode === "none") {
		return text;
	}
	const lines = text.split("\n").map((line) => {
		const tokens = line.split(/(\s+)/);
		if (mode === "mask") {
			return tokens
				.map((token) =>
					/\S/.test(token) && matches(token) ? maskToken(token) : token
				)
				.join("");
		}
		return tokens
			.filter((token) => !(/\S/.test(token) && matches(token)))
			.join("")
			.replace(/\s{2,}/g, " ")
			.trim();
	});
	return lines.filter((line) => mode !== "remove" || line.length).join("\n");
}
