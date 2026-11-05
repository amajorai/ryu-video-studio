// The downloadable credits document, written in the UI language. The
// sidecar's `creditsMarkdown` stays for API callers; the Companion builds the
// file here so its headings, labels and sentences follow the chosen language.
// Attribution values (asset names, rights text, URLs, providers, models) are
// copied verbatim: they are the record the credit must carry unchanged.

import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type Credits,
	type GeneratedCredit,
	RYU_DEFAULT_GENERATOR,
} from "../../shared/credits.ts";
import { TASK_LABELS } from "../../shared/generation-models.ts";

function generatedKind(entry: GeneratedCredit, tl: LiteralMessage): string {
	if (entry.task) {
		return tl(TASK_LABELS[entry.task]);
	}
	switch (entry.kind) {
		case "image":
			return tl("Image");
		case "audio":
			return tl("Audio");
		default:
			return tl("Video");
	}
}

/** The host default stamp names no provider or model; say so in the UI language. */
function generator(value: string, tl: LiteralMessage): string {
	return value === RYU_DEFAULT_GENERATOR ? tl("Ryu default") : value;
}

function sourceLines(credits: Credits, tl: LiteralMessage): string[] {
	if (!credits.entries.length) {
		return [tl("No attributed source media is used by this project."), ""];
	}
	return credits.entries.flatMap((entry) => [
		`- **${entry.assetName}** — ${entry.attribution}`,
		`  ${tl("Provider: {provider}; identifier: {identifier}", {
			identifier: entry.identifier,
			provider: entry.provider,
		})}`,
		`  ${tl("Rights: {rights}", { rights: entry.rights })}`,
		`  ${tl("Source: {source}", { source: entry.pageUrl })}`,
		...(entry.licenseUrl
			? [`  ${tl("License: {license}", { license: entry.licenseUrl })}`]
			: []),
		"",
	]);
}

function fontLines(credits: Credits, tl: LiteralMessage): string[] {
	if (!credits.fonts?.length) {
		return [];
	}
	return [
		`## ${tl("Fonts")}`,
		...credits.fonts.flatMap(({ family, origin }) => [
			`- **${family}** — ${origin.attribution}`,
			`  ${tl("Provider: {provider}; identifier: {identifier}", {
				identifier: origin.identifier,
				provider: origin.provider,
			})}`,
			`  ${tl("License: {license} ({licenseUrl})", {
				license: origin.license,
				licenseUrl: origin.licenseUrl,
			})}`,
			`  ${tl("Source: {source}", { source: origin.pageUrl })}`,
			"",
		]),
	];
}

function generatedLines(credits: Credits, tl: LiteralMessage): string[] {
	if (!credits.generated?.length) {
		return [];
	}
	return [
		`## ${tl("Generated media")}`,
		...credits.generated.flatMap((entry) => [
			`- **${entry.assetName}** — ${generatedKind(entry, tl)}`,
			`  ${tl("Provider: {provider}; model: {model}", {
				model: generator(entry.model, tl),
				provider: generator(entry.provider, tl),
			})}`,
			...(entry.consent
				? [
						`  ${tl("Consent: the sender confirmed the people shown agreed to this use.")}`,
					]
				: []),
			"",
		]),
	];
}

/** The credits document as Markdown in the UI language. */
export function localizedCreditsMarkdown(
	credits: Credits,
	tl: LiteralMessage
): string {
	const lines = [
		`# ${tl("Credits — {title}", { title: credits.projectTitle })}`,
		"",
		tl("Project revision: {revision}", {
			revision: String(credits.projectRevision),
		}),
		"",
		`## ${tl("Sources")}`,
		...sourceLines(credits, tl),
		...fontLines(credits, tl),
		...generatedLines(credits, tl),
	];
	return `${lines.join("\n")}\n`;
}
