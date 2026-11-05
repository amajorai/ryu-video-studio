import { expect, test } from "bun:test";
import { transcriptWindowWords } from "./transcript.ts";

test("malformed measured words are rejected rather than discarded", () => {
	expect(() =>
		transcriptWindowWords(
			{ words: [{ startMs: -1, endMs: 500, text: "Invalid timing" }] },
			0,
			1
		)
	).toThrow();
});

test("an engine response without measured word alignment returns no invented words", () => {
	expect(transcriptWindowWords({ text: "No alignment" }, 0, 1)).toEqual([]);
});
