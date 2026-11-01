import { expect, test } from "bun:test";
import { appendResearchSource, removeResearchSource } from "./research.ts";

const source = (url = "https://example.com/article") => ({
	id: crypto.randomUUID(),
	retrievedAt: new Date().toISOString(),
	title: "Example research",
	url,
});

test("research sources append, deduplicate, and remove with HTTPS bounds", () => {
	const first = source();
	const next = appendResearchSource([], first);
	expect(next).toHaveLength(1);
	expect(() => appendResearchSource(next, source())).toThrow("already saved");
	expect(() =>
		appendResearchSource([], { ...first, url: "http://example.com" })
	).toThrow("HTTPS");
	expect(removeResearchSource(next, first.id)).toEqual([]);
});
