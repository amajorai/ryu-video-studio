import { describe, expect, test } from "bun:test";
import {
	applyGlossaryToCaptions,
	applyGlossaryToText,
	glossarySuggestionRequest,
	mergeGlossary,
	parseGlossarySuggestions,
} from "./caption-glossary.ts";
import type { Caption } from "./project.ts";

const id = () => crypto.randomUUID();

describe("caption glossary", () => {
	test("replaces whole words and phrases, ignoring case", () => {
		const glossary = [
			{ from: "rye you", to: "Ryu" },
			{ from: "cubernetes", to: "Kubernetes" },
		];
		expect(
			applyGlossaryToText(
				"Rye  you runs on cubernetes; cubernetesX stays.",
				glossary
			)
		).toEqual({
			count: 2,
			text: "Ryu runs on Kubernetes; cubernetesX stays.",
		});
	});

	test("timed words are rewritten in place and keep their timing", () => {
		const caption: Caption = {
			end: 3,
			id: id(),
			start: 0,
			text: "Meet rye you today.",
			words: [
				{ end: 0.5, id: id(), start: 0, text: "Meet" },
				{ end: 1, id: id(), start: 0.5, text: "rye" },
				{ end: 1.6, id: id(), start: 1, text: "you" },
				{ end: 2.2, id: id(), start: 1.6, text: "today." },
			],
		};
		const result = applyGlossaryToCaptions(
			[caption],
			[{ from: "rye you", to: "Ryu" }]
		);
		expect(result.replacements).toBe(1);
		const [fixed] = result.captions;
		expect(fixed?.text).toBe("Meet Ryu today.");
		expect(fixed?.words?.map((word) => word.text)).toEqual([
			"Meet",
			"Ryu",
			"today.",
		]);
		expect(fixed?.words?.[1]).toMatchObject({ end: 1.6, start: 0.5 });
		const untouched = applyGlossaryToCaptions(
			[caption],
			[{ from: "absent", to: "Present" }]
		);
		expect(untouched.replacements).toBe(0);
		expect(untouched.captions[0]).toBe(caption);
	});

	test("merging keeps one pair per term and drops no-ops", () => {
		expect(
			mergeGlossary(
				[{ from: "Teh", to: "The" }],
				[
					{ from: "teh", to: "the" },
					{ from: "same", to: "same" },
				]
			)
		).toEqual([{ from: "teh", to: "the" }]);
	});

	test("model suggestions are parsed leniently", () => {
		const request = glossarySuggestionRequest(
			[{ end: 1, id: id(), start: 0, text: "rye you studio" }],
			{ title: "Ryu launch" }
		);
		expect(JSON.parse(request.prompt).title).toBe("Ryu launch");
		expect(
			parseGlossarySuggestions(
				'Sure! {"fixes":[{"from":"rye you","to":"Ryu"},{"from":"x"},{"from":"a","to":"a"}]}'
			)
		).toEqual([{ from: "rye you", to: "Ryu" }]);
		expect(() => parseGlossarySuggestions("no json")).toThrow();
		expect(() => glossarySuggestionRequest([])).toThrow("captions");
	});
});
