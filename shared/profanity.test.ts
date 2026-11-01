import { describe, expect, test } from "bun:test";
import {
	filterProfanity,
	maskToken,
	profanityMatcher,
	profanityWordsSchema,
} from "./profanity.ts";

describe("profanity", () => {
	const matches = profanityMatcher();

	test("matches whole words and common inflections only", () => {
		expect(matches("Shit!")).toBe(true);
		expect(matches("fucking")).toBe(true);
		expect(matches("bitches")).toBe(true);
		expect(matches("fuckin'")).toBe(true);
		// Words that merely contain a root are left alone.
		expect(matches("Scunthorpe")).toBe(false);
		expect(matches("assess")).toBe(false);
		expect(matches("classic")).toBe(false);
		expect(matches("cockpit")).toBe(false);
	});

	test("masking keeps the first letter and punctuation", () => {
		expect(maskToken("fuck")).toBe("f***");
		expect(maskToken("Shit!")).toBe("S***!");
		expect(maskToken('"damn,"')).toBe('"d***,"');
		expect(filterProfanity("Oh shit, that's fucking great", "mask")).toBe(
			"Oh s***, that's f****** great"
		);
	});

	test("removal drops the word and collapses spaces", () => {
		expect(filterProfanity("Oh shit that is great", "remove")).toBe(
			"Oh that is great"
		);
		expect(filterProfanity("shit", "remove")).toBe("");
		expect(filterProfanity("fine\nshit happens", "remove")).toBe(
			"fine\nhappens"
		);
		expect(filterProfanity("shit stays", "none")).toBe("shit stays");
	});

	test("user words extend the bundled list", () => {
		const custom = profanityMatcher(["Heck", "frak"]);
		expect(custom("heck!")).toBe(true);
		expect(custom("FRAK")).toBe(true);
		expect(matches("heck")).toBe(false);
		expect(profanityWordsSchema.safeParse(["two words"]).success).toBe(false);
		expect(profanityWordsSchema.safeParse(["ok"]).success).toBe(true);
	});
});
