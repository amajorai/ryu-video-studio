import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage } from "@ryu/i18n/core";
import { act } from "react";
import { STUDIO_ERROR_MESSAGES } from "../../../shared/studio-error.ts";
import {
	TIMELINE_CLIP_KIND_LABELS,
	TIMELINE_CLIP_KINDS,
} from "../../../shared/timeline-colors.ts";
import { StudioRequestError } from "../bridge.ts";
import { CATEGORY_ORDER } from "../shortcuts/catalog.ts";
import { ACTIONS } from "../shortcuts/defaults.ts";
import { CLIP_COLOR_LABELS, clipColorName } from "../timeline/clip-meta.ts";
import {
	STUDIO_CORE_MESSAGES,
	STUDIO_LOCALES,
	STUDIO_MESSAGES,
	STUDIO_RUNTIME_MESSAGES,
	studioMessageOverlays,
} from "./catalog.ts";
import {
	COVERED_SOURCES,
	EXCLUDED_SOURCES,
	extractUiLiterals,
	UNTRANSLATED_LITERALS,
} from "./coverage.ts";
import { EXTRA_CATALOGS } from "./extra/index.ts";
import { STUDIO_FEATURE_MESSAGES } from "./feature-messages.ts";
import {
	catalogLocaleFor,
	localizedErrorMessage,
	setStudioLocale,
	studioFormat,
} from "./format.ts";
import { STUDIO_WORKSPACE_MESSAGES } from "./workspace-messages.ts";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { createRoot } = await import("react-dom/client");
const { RyuAppShell } = await import("@ryu/blocks/companion/app-ui");

afterAll(() => {
	GlobalRegistrator.unregister();
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

const UI_ROOT = join(import.meta.dir, "..");

/** Non-test sources under `path` (a file or a directory), skipping i18n. */
function sourceFiles(path: string): string[] {
	if (!statSync(path).isDirectory()) {
		return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
	}
	return readdirSync(path).flatMap((name) =>
		name === "i18n" ? [] : sourceFiles(join(path, name))
	);
}

function uiSource(directory: string): string {
	return sourceFiles(directory)
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
}

/**
 * Copy the UI composes at runtime from tables outside the covered files:
 * shortcut labels and categories, clip color names, and Timeline colors
 * labels (with their swatch `aria-label`s).
 */
function composedCopy(): string[] {
	return [
		...Object.values(ACTIONS).map((action) => action.label),
		...CATEGORY_ORDER,
		...CLIP_COLOR_LABELS.map(clipColorName),
		...TIMELINE_CLIP_KINDS.flatMap((kind) => [
			TIMELINE_CLIP_KIND_LABELS[kind],
			`${TIMELINE_CLIP_KIND_LABELS[kind]} color`,
		]),
	].filter((text) => !UNTRANSLATED_LITERALS.has(text));
}

describe("Video Studio UI catalogs", () => {
	test("every entry is translated for every host locale", () => {
		for (const [source, translations] of Object.entries(STUDIO_MESSAGES)) {
			for (const locale of STUDIO_LOCALES) {
				expect(
					translations[locale]?.trim().length,
					`${source} lacks ${locale}`
				).toBeGreaterThan(0);
			}
		}
		expect(Object.keys(STUDIO_MESSAGES).length).toBeGreaterThanOrEqual(2000);
	});

	test("the core, workspace, and feature catalogs never define a string twice", () => {
		const catalogs = [
			STUDIO_CORE_MESSAGES,
			STUDIO_WORKSPACE_MESSAGES,
			STUDIO_FEATURE_MESSAGES,
		];
		const seen = new Set<string>();
		const twice: string[] = [];
		for (const catalog of catalogs) {
			for (const key of Object.keys(catalog)) {
				if (seen.has(key)) {
					twice.push(key);
				}
				seen.add(key);
			}
		}
		expect(twice).toEqual([]);
	});

	test("every static string in the covered UI is catalogued", () => {
		const excluded = EXCLUDED_SOURCES.map((path) => join(UI_ROOT, path));
		const files = COVERED_SOURCES.flatMap((path) =>
			sourceFiles(join(UI_ROOT, path))
		).filter((file) => !excluded.some((prefix) => file.startsWith(prefix)));
		expect(files.length).toBeGreaterThan(250);
		// Every feature panel is covered, not just the workspace shell.
		for (const panel of [
			"GenerationPanel.tsx",
			"SoundtrackPanel.tsx",
			"MulticamPanel.tsx",
			"SearchPanel.tsx",
			"SpeedRampPanel.tsx",
			"markers/MarkerEditor.tsx",
		]) {
			expect(files).toContain(join(UI_ROOT, panel));
		}
		const untranslated = new Set<string>();
		for (const file of files) {
			for (const literal of extractUiLiterals(readFileSync(file, "utf8"))) {
				if (!Object.hasOwn(STUDIO_MESSAGES, literal)) {
					untranslated.add(`${literal} (${file.slice(UI_ROOT.length + 1)})`);
				}
			}
		}
		for (const text of composedCopy()) {
			if (!Object.hasOwn(STUDIO_MESSAGES, text)) {
				untranslated.add(`${text} (composed)`);
			}
		}
		expect([...untranslated]).toEqual([]);
	});

	test("every key is copy the UI still renders", () => {
		// JSX collapses whitespace in text, so compare collapsed source.
		const source = uiSource(UI_ROOT).replace(/\s+/g, " ");
		const composed = new Set(composedCopy());
		const escapeRegExp = (text: string) =>
			text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const stale = Object.keys(STUDIO_MESSAGES).filter(
			(key) =>
				!(
					composed.has(key) ||
					source.includes(`"${key}"`) ||
					new RegExp(`> ?${escapeRegExp(key)} ?<`).test(source)
				)
		);
		expect(stale).toEqual([]);
	});

	test("the app shell shows Video Studio copy in the host language", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<RyuAppShell
					initialLocale="de"
					messageOverlays={studioMessageOverlays()}
				>
					<button aria-label="Timeline tools" type="button">
						Capture frame
					</button>
					<span>Unlisted project title</span>
					<h3 data-feature-copy="">Speed curve</h3>
					<input aria-label="Footage meaning query" type="search" />
					<p data-workspace-copy="" title="Timeline colors">
						Unlock this track to edit the clip.
					</p>
				</RyuAppShell>
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const button = container.querySelector("button");
		expect(button?.textContent).toBe("Frame erfassen");
		expect(button?.getAttribute("aria-label")).toBe("Timeline-Werkzeuge");
		expect(container.querySelector("span")?.textContent).toBe(
			"Unlisted project title"
		);
		expect(container.querySelector("[data-feature-copy]")?.textContent).toBe(
			"Geschwindigkeitskurve"
		);
		expect(container.querySelector("input")?.getAttribute("aria-label")).toBe(
			"Bedeutungsanfrage für Material"
		);
		const workspaceCopy = container.querySelector("[data-workspace-copy]");
		expect(workspaceCopy?.textContent?.trim()).toBe(
			"Entsperren Sie diese Spur, um den Clip zu bearbeiten."
		);
		expect(workspaceCopy?.getAttribute("title")).toBe("Timeline-Farben");
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});
});

/** Top-level and nested ICU argument names (`{name}`, `{count, plural, …}`). */
function argumentNames(message: string): string[] {
	const names = new Set<string>();
	for (const match of message.matchAll(/\{\s*([A-Za-z]\w*)\s*(?:,|\})/g)) {
		names.add(match[1] ?? "");
	}
	return [...names].sort();
}

function balanced(message: string): boolean {
	let depth = 0;
	for (const character of message) {
		depth += character === "{" ? 1 : character === "}" ? -1 : 0;
		if (depth < 0) {
			return false;
		}
	}
	return depth === 0;
}

const SAMPLE_VALUES = {
	count: 3,
	entity: "Clip",
	field: "volume",
	file: "scene.glb",
	label: "picture",
	license: "OFL-1.1",
	limit: 24,
	line: 4,
	mode: "Hard light",
	name: "Interview",
	percent: 40,
	range: "0:02.0–0:06.0",
	reason: "bad time",
	reasons: "line 4: bad time",
	revision: 7,
	scene: "Opening",
	selected: 2,
	total: 9,
	track: "Video 2",
};

interface PluralArgument {
	/** Branch selector (`one`, `few`, `=0`, …) → branch body. */
	branches: Map<string, string>;
	name: string;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function closingBrace(message: string, open: number): number {
	let depth = 0;
	for (let index = open; index < message.length; index += 1) {
		depth += message[index] === "{" ? 1 : message[index] === "}" ? -1 : 0;
		if (depth === 0) {
			return index;
		}
	}
	return -1;
}

/** Every `{arg, plural, …}` in `message`, nested ones included. */
function pluralArguments(message: string): PluralArgument[] {
	const found: PluralArgument[] = [];
	for (const match of message.matchAll(
		/\{\s*([A-Za-z]\w*)\s*,\s*plural\s*,/g
	)) {
		const end = closingBrace(message, match.index);
		if (end < 0) {
			continue;
		}
		const branches = new Map<string, string>();
		let cursor = match.index + match[0].length;
		while (cursor < end) {
			const selector = /^\s*(=?[\w-]+)\s*\{/.exec(message.slice(cursor, end));
			if (!selector) {
				break;
			}
			const open = cursor + selector[0].length - 1;
			const close = closingBrace(message, open);
			if (close < 0 || close > end) {
				break;
			}
			branches.set(selector[1] ?? "", message.slice(open + 1, close));
			cursor = close + 1;
		}
		found.push({ branches, name: match[1] ?? "" });
	}
	return found;
}

/**
 * Branches that may write the number out as a word: Hebrew and Arabic say a
 * single and a pair in words ("פריט אחד", "عنصران"), and Arabic's `zero` may
 * read "no items".
 */
const WORDED_PLURAL_BRANCHES: Readonly<Record<string, readonly string[]>> = {
	ar: ["zero", "one", "two"],
	he: ["one", "two"],
};

/**
 * Languages whose nouns stay singular after any numeral, so a plain `{count}`
 * is correct even though CLDR gives them `one` and `other`.
 */
const NUMBER_INVARIANT_LANGUAGES = new Set(["hu", "tr"]);

const CLDR_PLURAL_ORDER = ["zero", "one", "two", "few", "many", "other"];

/**
 * Counts in the editor are whole numbers (clips, captions, items), so a
 * translation needs every category an integer count up to 1000 selects. The
 * categories only reached by decimals or by millions (Czech `many`, Italian
 * and Spanish `many`) may be written but are not required.
 */
function requiredPluralCategories(locale: string): Set<string> {
	const rules = new Intl.PluralRules(locale);
	const required = new Set<string>();
	for (let count = 0; count <= 1000; count += 1) {
		required.add(rules.select(count));
	}
	return required;
}

/**
 * Plural problems in a translation: every `{arg, plural, …}` must cover the
 * categories integer counts select in the locale and use no selector outside
 * its CLDR set (besides `=N` exact matches), and each branch must keep the
 * number (`#` or `{arg}`) when the English template shows it. A locale with
 * only `other`, or a number-invariant language, may use plain `{arg}`.
 */
function pluralProblems(template: string, text: string, locale: string) {
	const englishPlurals = pluralArguments(template);
	if (locale === "en" || englishPlurals.length === 0) {
		return [];
	}
	const problems: string[] = [];
	const language = new Intl.Locale(locale).language;
	const allowed = new Set<string>(
		new Intl.PluralRules(locale).resolvedOptions().pluralCategories
	);
	const required = requiredPluralCategories(locale);
	const translatedPlurals = pluralArguments(text);
	const plainCountAllowed =
		required.size === 1 || NUMBER_INVARIANT_LANGUAGES.has(language);
	if (translatedPlurals.length === 0 && !plainCountAllowed) {
		problems.push(`${locale}: ${text} drops the plural`);
	}
	const worded = new Set(WORDED_PLURAL_BRANCHES[language] ?? []);
	for (const plural of translatedPlurals) {
		const selectors = [...plural.branches.keys()].filter(
			(selector) => !selector.startsWith("=")
		);
		const missing = CLDR_PLURAL_ORDER.filter(
			(category) => required.has(category) && !selectors.includes(category)
		);
		const extra = selectors.filter((selector) => !allowed.has(selector));
		if (missing.length > 0 || extra.length > 0) {
			problems.push(
				`${locale}: ${text} plural categories missing [${missing.join()}] extra [${extra.join()}]`
			);
		}
		const english = englishPlurals.find((item) => item.name === plural.name);
		const englishShowsNumber = [...(english?.branches.values() ?? [])].some(
			(body) => body.includes("#")
		);
		if (!englishShowsNumber) {
			continue;
		}
		for (const [selector, body] of plural.branches) {
			if (selector.startsWith("=") || worded.has(selector)) {
				continue;
			}
			if (!(body.includes("#") || body.includes(`{${plural.name}}`))) {
				problems.push(`${locale}: ${text} branch ${selector} drops the number`);
			}
		}
	}
	return problems;
}

/**
 * Problems with a translation of `template`: unbalanced braces, other
 * arguments than the template's, plural branches that miss the locale's
 * categories or the number, or text that does not format cleanly.
 */
function formatProblems(template: string, text: string, locale: string) {
	const problems: string[] = [...pluralProblems(template, text, locale)];
	if (!balanced(text)) {
		problems.push(`${locale}: unbalanced braces in ${text}`);
	}
	if (argumentNames(text).join() !== argumentNames(template).join()) {
		problems.push(`${locale}: arguments differ in ${text}`);
	}
	for (const count of [0, 1, 2, 5, 21]) {
		// Messages with two counts (clips moved across tracks) name each one.
		const formatted = formatMessage(
			text,
			{ ...SAMPLE_VALUES, clipCount: count, count, trackCount: count },
			locale
		);
		if (/[{}]/.test(formatted)) {
			problems.push(`${locale}: ${text} formats as ${formatted}`);
		}
	}
	return problems;
}

/** `studioFormat("…")` and `studioText("…")` literals in the UI source. */
function runtimeLiterals(): { format: Set<string>; text: Set<string> } {
	const format = new Set<string>();
	const text = new Set<string>();
	for (const file of sourceFiles(UI_ROOT)) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(
			/\bstudio(Format|Text)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g
		)) {
			const literal = JSON.parse(
				match[2]?.startsWith("'")
					? `"${match[2].slice(1, -1).replace(/"/g, '\\"')}"`
					: (match[2] ?? '""')
			) as string;
			(match[1] === "Format" ? format : text).add(literal);
		}
	}
	return { format, text };
}

describe("runtime messages", () => {
	test("every template is translated for every host locale and formats cleanly", () => {
		expect(Object.keys(STUDIO_RUNTIME_MESSAGES).length).toBeGreaterThan(40);
		const problems: string[] = [];
		for (const [template, translations] of Object.entries(
			STUDIO_RUNTIME_MESSAGES
		)) {
			problems.push(...formatProblems(template, template, "en"));
			for (const locale of STUDIO_LOCALES) {
				const text = translations[locale];
				if (!text?.trim()) {
					problems.push(`${template} lacks ${locale}`);
				}
				problems.push(...formatProblems(template, text ?? "", locale));
			}
		}
		expect(problems).toEqual([]);
	});

	test("templates and the UI's studioFormat calls match one to one", () => {
		const { format, text } = runtimeLiterals();
		const errors = new Set<string>(Object.values(STUDIO_ERROR_MESSAGES));
		for (const literal of format) {
			expect(
				Object.hasOwn(STUDIO_RUNTIME_MESSAGES, literal),
				`uncatalogued template: ${literal}`
			).toBe(true);
		}
		for (const literal of text) {
			expect(
				Object.hasOwn(STUDIO_RUNTIME_MESSAGES, literal) ||
					Object.hasOwn(STUDIO_MESSAGES, literal),
				`uncatalogued literal: ${literal}`
			).toBe(true);
		}
		const unused = Object.keys(STUDIO_RUNTIME_MESSAGES).filter(
			(key) => !(format.has(key) || text.has(key) || errors.has(key))
		);
		expect(unused).toEqual([]);
		// Every sidecar error that names a clip has a translation.
		for (const template of errors) {
			expect(Object.hasOwn(STUDIO_RUNTIME_MESSAGES, template), template).toBe(
				true
			);
		}
	});

	test("studioFormat follows the host locale and falls back to English", () => {
		const template =
			"Imported {count, plural, one {# caption} other {# captions}}.";
		try {
			setStudioLocale("ru");
			expect(studioFormat(template, { count: 1 })).toBe(
				"Импортировано 1 субтитр."
			);
			expect(studioFormat(template, { count: 3 })).toBe(
				"Импортировано 3 субтитра."
			);
			expect(studioFormat(template, { count: 5 })).toBe(
				"Импортировано 5 субтитров."
			);
			setStudioLocale("de-AT");
			expect(studioFormat("Marked {range}.", { range: "0:01.0–0:02.0" })).toBe(
				"0:01.0–0:02.0 markiert."
			);
			setStudioLocale("en-GB");
			expect(studioFormat(template, { count: 1 })).toBe("Imported 1 caption.");
			// A template with no catalog entry formats in English.
			setStudioLocale("fr");
			expect(studioFormat("Unlisted {thing}", { thing: "x" })).toBe(
				"Unlisted x"
			);
		} finally {
			setStudioLocale("en");
		}
	});

	test("sidecar errors that name a clip are shown in the host language", () => {
		const error = new StudioRequestError(
			"Unlock Video 2 before removing it.",
			"INVALID_REQUEST",
			{ messageCode: "track.locked", params: { track: "Video 2" } }
		);
		try {
			setStudioLocale("es");
			expect(localizedErrorMessage(error)).toBe(
				"Desbloquea Video 2 antes de quitarla."
			);
			setStudioLocale("en");
			expect(localizedErrorMessage(error)).toBe(
				"Unlock Video 2 before removing it."
			);
			// Unknown codes keep the sidecar's text.
			setStudioLocale("es");
			expect(
				localizedErrorMessage(
					new StudioRequestError("Plain failure.", "INVALID_REQUEST", {
						messageCode: "nope",
					})
				)
			).toBe("Plain failure.");
		} finally {
			setStudioLocale("en");
		}
	});
});

describe("extra-locale catalogs", () => {
	const englishKeys = new Set([
		...Object.keys(STUDIO_MESSAGES),
		...Object.keys(STUDIO_RUNTIME_MESSAGES),
	]);

	test("17 further locales, each a machine draft outside the official set", () => {
		expect(EXTRA_CATALOGS).toHaveLength(17);
		const locales = EXTRA_CATALOGS.map((catalog) => catalog.locale);
		expect(new Set(locales).size).toBe(17);
		for (const catalog of EXTRA_CATALOGS) {
			expect(STUDIO_LOCALES as readonly string[]).not.toContain(catalog.locale);
			expect(catalog.status).toBe("machine-drafted");
			expect(catalogLocaleFor(catalog.locale)).toBe(catalog.locale);
		}
	});

	test("each catalog's keys are English catalog keys", () => {
		const strays: string[] = [];
		for (const catalog of EXTRA_CATALOGS) {
			for (const key of Object.keys(catalog.messages)) {
				if (!englishKeys.has(key)) {
					strays.push(`${catalog.locale}: ${key}`);
				}
			}
		}
		expect(strays).toEqual([]);
	});

	test("every shipped locale has every key, with the template's placeholders", () => {
		const shipped: [string, (key: string) => string | undefined][] = [
			...STUDIO_LOCALES.map(
				(locale): [string, (key: string) => string | undefined] => [
					locale,
					(key) =>
						STUDIO_MESSAGES[key]?.[locale] ??
						STUDIO_RUNTIME_MESSAGES[key]?.[locale],
				]
			),
			...EXTRA_CATALOGS.map(
				(catalog): [string, (key: string) => string | undefined] => [
					catalog.locale,
					(key) => catalog.messages[key],
				]
			),
		];
		expect(shipped).toHaveLength(STUDIO_LOCALES.length + 17);
		const problems: string[] = [];
		for (const [locale, lookup] of shipped) {
			for (const key of englishKeys) {
				const text = lookup(key);
				if (!text?.trim()) {
					problems.push(`${locale}: missing ${key}`);
					continue;
				}
				problems.push(...formatProblems(key, text, locale));
			}
		}
		expect(problems).toEqual([]);
	});

	test("the plural check rejects missing categories and dropped numbers", () => {
		const template = "{count, plural, one {# more item} other {# more items}}";
		expect(
			pluralProblems(
				template,
				"{count, plural, one {jeszcze # element} few {jeszcze # elementy} many {jeszcze # elementów} other {jeszcze # elementu}}",
				"pl"
			)
		).toEqual([]);
		// Polish without `few`/`many` would render "jeszcze 5 elementu".
		expect(
			pluralProblems(
				template,
				"{count, plural, one {jeszcze # element} other {jeszcze # elementu}}",
				"pl"
			)
		).toEqual([
			"pl: {count, plural, one {jeszcze # element} other {jeszcze # elementu}} plural categories missing [few,many] extra []",
		]);
		// Hebrew needs `two`; its `one` and `two` may be words.
		expect(
			pluralProblems(
				template,
				"{count, plural, one {עוד פריט אחד} other {עוד # פריטים}}",
				"he"
			)
		).toEqual([
			"he: {count, plural, one {עוד פריט אחד} other {עוד # פריטים}} plural categories missing [two] extra []",
		]);
		// A branch that loses the number, and a selector the locale lacks.
		expect(
			pluralProblems(
				template,
				"{count, plural, one {# altro elemento} few {# altri} other {altri elementi}}",
				"it"
			)
		).toEqual([
			"it: {count, plural, one {# altro elemento} few {# altri} other {altri elementi}} plural categories missing [] extra [few]",
			"it: {count, plural, one {# altro elemento} few {# altri} other {altri elementi}} branch other drops the number",
		]);
		// A plain count only passes where nouns do not inflect, or with no plural.
		expect(pluralProblems(template, "jeszcze {count} elementów", "pl")).toEqual(
			["pl: jeszcze {count} elementów drops the plural"]
		);
		expect(pluralProblems(template, "{count} elem", "hu")).toEqual([]);
		expect(pluralProblems(template, "還有 {count} 個項目", "zh-TW")).toEqual(
			[]
		);
	});

	test("Hindi and Arabic runtime plurals agree with the count", () => {
		const template =
			"Imported {count, plural, one {# caption} other {# captions}}.";
		try {
			setStudioLocale("hi");
			expect(studioFormat(template, { count: 1 })).toBe(
				"1 कैप्शन आयात किया गया।"
			);
			expect(studioFormat(template, { count: 4 })).toBe("4 कैप्शन आयात किए गए।");
			setStudioLocale("ar");
			// The runtime writes the count in the locale's own digits.
			const zero = new Intl.NumberFormat("ar").format(0);
			expect(studioFormat(template, { count: 0 })).toBe(
				`تم استيراد ${zero} تسمية توضيحية.`
			);
		} finally {
			setStudioLocale("en");
		}
	});

	test("a catalogued template formats in an extra locale; an uncatalogued one stays English", () => {
		try {
			setStudioLocale("nl-NL");
			expect(studioFormat("Imported {name}.", { name: "a.mp4" })).toBe(
				"a.mp4 geïmporteerd."
			);
			expect(
				studioFormat(
					"Imported {name}. Review the source rights before publishing.",
					{ name: "a.mp4" }
				)
			).toBe(
				"a.mp4 geïmporteerd. Controleer de rechten op de bron voordat je publiceert."
			);
			expect(studioFormat("Unlisted {name}", { name: "a.mp4" })).toBe(
				"Unlisted a.mp4"
			);
			setStudioLocale("zh-Hant-TW");
			expect(
				studioFormat("{count, plural, one {# item} other {# items}}", {
					count: 4,
				})
			).toBe("4 個項目");
			setStudioLocale("pl-PL");
			expect(
				studioFormat(
					"{count, plural, one {# more item} other {# more items}}",
					{
						count: 5,
					}
				)
			).toBe("jeszcze 5 elementów");
		} finally {
			setStudioLocale("en");
		}
	});

	test("the shell overlays carry an extra locale's literal copy only", () => {
		const overlays = studioMessageOverlays();
		expect(overlays.nl?.["Export video"]).toBe("Video exporteren");
		expect(overlays.nl?.["Marked {range}."]).toBeUndefined();
		expect(Object.keys(overlays.de ?? {}).length).toBe(
			Object.keys(STUDIO_MESSAGES).length
		);
	});
});
