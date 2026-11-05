import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/lite";
import { type Credits, creditsMarkdown } from "../../shared/credits.ts";
import { localizedCreditsMarkdown } from "./credits-markdown.ts";

// A stub German catalog stands in for the shipped one.
const DE: Record<string, string> = {
	"Consent: the sender confirmed the people shown agreed to this use.":
		"Einwilligung: Der Absender hat bestätigt, dass die gezeigten Personen dieser Nutzung zugestimmt haben.",
	"Credits — {title}": "Mitwirkende — {title}",
	Fonts: "Schriften",
	"Generated media": "Generierte Medien",
	"License: {license}": "Lizenz: {license}",
	"License: {license} ({licenseUrl})": "Lizenz: {license} ({licenseUrl})",
	"No attributed source media is used by this project.":
		"Dieses Projekt verwendet keine Quellmedien mit Quellenangabe.",
	"Project revision: {revision}": "Projektrevision: {revision}",
	"Provider: {provider}; identifier: {identifier}":
		"Anbieter: {provider}; Kennung: {identifier}",
	"Provider: {provider}; model: {model}":
		"Anbieter: {provider}; Modell: {model}",
	"Rights: {rights}": "Rechte: {rights}",
	"Ryu default": "Ryu-Standard",
	"Source: {source}": "Quelle: {source}",
	Sources: "Quellen",
	"Talking avatar": "Sprechender Avatar",
	Image: "Bild",
};
const de = (source: string, values?: MessageValuesInput) =>
	formatMessage(DE[source] ?? source, values, "de");
const english = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");

const base: Credits = {
	entries: [],
	projectId: "project-1",
	projectRevision: 1234,
	projectTitle: "Harbour film",
};
const full: Credits = {
	...base,
	entries: [
		{
			assetId: "asset-1",
			assetName: "Harbour at dawn",
			attribution: "Photo by A. Example",
			identifier: "pexels-42",
			licenseUrl: "https://example.com/license",
			pageUrl: "https://example.com/photo/42",
			provider: "pexels",
			rights: "Free to use",
		},
	],
	fonts: [
		{
			family: "Inter",
			fontId: "font-1",
			origin: {
				attribution: "Inter by Rasmus Andersson",
				identifier: "inter-latin-400-normal",
				license: "OFL-1.1",
				licenseUrl: "https://openfontlicense.org",
				pageUrl: "https://fontsource.org/fonts/inter",
				provider: "fontsource",
			},
		},
	],
	generated: [
		{
			assetId: "asset-2",
			assetName: "Presenter",
			consent: "subjects-agreed",
			kind: "video",
			model: "Ryu default",
			provider: "Ryu default",
			task: "avatar",
		},
		{
			assetId: "asset-3",
			assetName: "Poster",
			kind: "image",
			model: "flux",
			provider: "fal",
		},
	],
};

describe("localizedCreditsMarkdown in German", () => {
	const markdown = localizedCreditsMarkdown(full, de);

	test("headings, labels and sentences are translated", () => {
		expect(markdown).toContain("# Mitwirkende — Harbour film\n");
		expect(markdown).toContain("Projektrevision: 1234");
		expect(markdown).toContain("## Quellen\n");
		expect(markdown).toContain("  Anbieter: pexels; Kennung: pexels-42");
		expect(markdown).toContain("  Rechte: Free to use");
		expect(markdown).toContain("  Quelle: https://example.com/photo/42");
		expect(markdown).toContain("  Lizenz: https://example.com/license");
		expect(markdown).toContain("## Schriften\n");
		expect(markdown).toContain(
			"  Lizenz: OFL-1.1 (https://openfontlicense.org)"
		);
		expect(markdown).toContain("## Generierte Medien\n");
		expect(markdown).toContain("- **Presenter** — Sprechender Avatar");
		expect(markdown).toContain(
			"  Anbieter: Ryu-Standard; Modell: Ryu-Standard"
		);
		expect(markdown).toContain("  Einwilligung: Der Absender");
		expect(markdown).toContain("- **Poster** — Bild");
		expect(markdown).toContain("  Anbieter: fal; Modell: flux");
		for (const label of ["## Sources", "Provider:", "Rights:", "Consent:"]) {
			expect(markdown).not.toContain(label);
		}
	});

	test("an empty credit list says so in German", () => {
		expect(localizedCreditsMarkdown(base, de)).toContain(
			"Dieses Projekt verwendet keine Quellmedien mit Quellenangabe."
		);
	});
});

describe("localizedCreditsMarkdown in English", () => {
	test("keeps the sidecar document's structure", () => {
		const markdown = localizedCreditsMarkdown(full, english);
		const sidecar = creditsMarkdown(full);
		expect(markdown.split("\n").length).toBe(sidecar.split("\n").length);
		expect(markdown).toContain("  Provider: pexels; identifier: pexels-42");
		expect(markdown).toContain("- **Presenter** — Talking avatar");
	});

	test("matches the sidecar document except the capitalised media kind", () => {
		// The only intended English change: a generated asset without a task
		// is labelled "Image" (a catalog word), not the raw `image` enum.
		const sidecar = creditsMarkdown(full).replace(
			"- **Poster** — image",
			"- **Poster** — Image"
		);
		expect(localizedCreditsMarkdown(full, english)).toBe(sidecar);
	});

	test("the empty state reuses the panel's sentence", () => {
		expect(localizedCreditsMarkdown(base, english)).toBe(
			creditsMarkdown(base).replace(
				"is used in this project.",
				"is used by this project."
			)
		);
	});
});
