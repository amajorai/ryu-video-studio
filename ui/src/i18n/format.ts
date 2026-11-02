/**
 * Messages the editor builds at runtime from values ("Marked 0:02.0–0:06.0",
 * "Imported 3 captions.", errors that name a clip), in the host language.
 *
 * The DOM localizer only swaps text that matches a catalogued English literal
 * exactly, so text with values in it needs formatting before it reaches the
 * DOM. `studioFormat` looks the English ICU template up in the runtime catalog
 * (`STUDIO_RUNTIME_MESSAGES`, plus the extra-locale drafts) for the active host
 * locale and formats it with the host's ICU formatter; anything missing falls
 * back to the English template. `StudioLocaleSync`, mounted inside the app
 * shell, keeps the module's locale in step with the host's language pack.
 * Values (names, times, counts, codec and format names) are inserted as given.
 */
import { formatMessage } from "@ryu/i18n/core";
import { useI18n } from "@ryu/i18n/react";
import { useEffect, useSyncExternalStore } from "react";
import {
	isStudioErrorCode,
	STUDIO_ERROR_MESSAGES,
} from "../../../shared/studio-error.ts";
import {
	STUDIO_LOCALES,
	STUDIO_MESSAGES,
	STUDIO_RUNTIME_MESSAGES,
} from "./catalog.ts";
import { EXTRA_LOCALE_CATALOGS } from "./extra/index.ts";

type MessageValues = Readonly<Record<string, string | number>>;

let activeLocale = "en";
const listeners = new Set<() => void>();

/** `language-script` of a locale, matching how the host keys its overlays. */
export function languageAndScript(locale: string): string {
	try {
		const maximized = new Intl.Locale(locale).maximize();
		return `${maximized.language.toLowerCase()}-${(maximized.script ?? "").toLowerCase()}`;
	} catch {
		return `${locale.split("-")[0]?.toLowerCase() ?? locale.toLowerCase()}-`;
	}
}

/** The catalog locale (official or extra) that serves `locale`, if any. */
export function catalogLocaleFor(locale: string): string | null {
	const key = languageAndScript(locale);
	if (key === languageAndScript("en")) {
		return null;
	}
	const official = STUDIO_LOCALES.find(
		(candidate) => languageAndScript(candidate) === key
	);
	if (official) {
		return official;
	}
	return (
		Object.keys(EXTRA_LOCALE_CATALOGS).find(
			(candidate) => languageAndScript(candidate) === key
		) ?? null
	);
}

/** The host locale runtime messages are formatted in. */
export function studioLocale(): string {
	return activeLocale;
}

/** Set the host locale (from `StudioLocaleSync`, or a test). */
export function setStudioLocale(locale: string): void {
	if (locale === activeLocale) {
		return;
	}
	activeLocale = locale;
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Re-render when the host language changes (for text built during render). */
export function useStudioLocale(): string {
	return useSyncExternalStore(subscribe, studioLocale, studioLocale);
}

/**
 * Mirror the shell's active locale (which the shell's host sync keeps in step
 * with Desktop's language pack) into this module. Mount once inside
 * `RyuAppShell`.
 */
export function StudioLocaleSync() {
	const { locale } = useI18n();
	useEffect(() => {
		setStudioLocale(locale);
	}, [locale]);
	return null;
}

/** The translation of `english` (a template or literal) for `locale`. */
function translated(english: string, locale: string): string | undefined {
	const catalogLocale = catalogLocaleFor(locale);
	if (!catalogLocale) {
		return;
	}
	const official = (STUDIO_RUNTIME_MESSAGES[english] ??
		STUDIO_MESSAGES[english]) as Readonly<Record<string, string>> | undefined;
	const text =
		official?.[catalogLocale] ??
		EXTRA_LOCALE_CATALOGS[catalogLocale]?.[english];
	return text?.trim() ? text : undefined;
}

/**
 * Format the English ICU template `template` with `values` in the active host
 * locale. A template the active locale lacks is formatted in English.
 */
export function studioFormat(
	template: string,
	values: MessageValues = {},
	locale: string = activeLocale
): string {
	const text = translated(template, locale);
	return text
		? formatMessage(text, values, locale)
		: formatMessage(template, values, "en");
}

/** A catalogued literal (no values) in the active host locale. */
export function studioText(literal: string, locale = activeLocale): string {
	return translated(literal, locale) ?? literal;
}

/**
 * The message for a failed operation: a sidecar error that carries a message
 * code is shown in the host language; anything else keeps its own text.
 */
export function localizedErrorMessage(error: unknown): string | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const detail = error as Error & {
		messageCode?: unknown;
		params?: MessageValues;
	};
	if (isStudioErrorCode(detail.messageCode)) {
		return studioFormat(
			STUDIO_ERROR_MESSAGES[detail.messageCode],
			detail.params ?? {}
		);
	}
	return error.message;
}
