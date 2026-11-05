import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { glossaryPair } from "./CaptionGlossary-pair.tsx";

const ar: LiteralMessage = (source, values) =>
	formatMessage(
		source === "{from} → {to}" ? "{from} ← {to}" : source,
		values,
		"ar"
	);
const en: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

test("each side is its own isolated node around the catalog arrow", () => {
	expect(
		renderToStaticMarkup(
			<span>{glossaryPair(en, <s>rye you</s>, <b>Ryu</b>)}</span>
		)
	).toBe("<span><bdi><s>rye you</s></bdi> → <bdi><b>Ryu</b></bdi></span>");
});

test("Arabic takes the mirrored arrow and keeps both words isolated", () => {
	expect(
		renderToStaticMarkup(<span>{glossaryPair(ar, "رايو", "Ryu")}</span>)
	).toBe("<span><bdi>رايو</bdi> ← <bdi>Ryu</bdi></span>");
});
