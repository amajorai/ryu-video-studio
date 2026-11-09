/**
 * Accessible names for the background fields (W2-V8). Each owner and color
 * field pair is one whole catalog message, so translators see "Canvas start
 * color" as a sentence instead of an English owner glued to a lowercased
 * field name.
 */
import type { LiteralMessage } from "@ryu/i18n/react";

/** The color pickers a background shows: a fill, or a gradient's two stops. */
export type BackgroundColorField = "color" | "end" | "start";

interface OwnerLabels {
	readonly colors: Readonly<Record<BackgroundColorField, string>>;
	readonly owner: string;
}

/** Owners the editor renders, keyed by the `label` prop callers pass. */
const KNOWN_OWNERS: Readonly<
	Record<string, (tl: LiteralMessage) => OwnerLabels>
> = {
	Canvas: (tl) => ({
		colors: {
			color: tl("Canvas color"),
			end: tl("Canvas end color"),
			start: tl("Canvas start color"),
		},
		owner: tl("Canvas"),
	}),
	Clip: (tl) => ({
		colors: {
			color: tl("Clip color"),
			end: tl("Clip end color"),
			start: tl("Clip start color"),
		},
		owner: tl("Clip"),
	}),
};

/**
 * The translated owner name and its color-field names. An owner without its
 * own messages keeps its given name inside whole-sentence templates.
 */
export function backgroundFieldLabels(
	tl: LiteralMessage,
	owner: string
): OwnerLabels {
	const known = Object.hasOwn(KNOWN_OWNERS, owner)
		? KNOWN_OWNERS[owner]
		: undefined;
	if (known) {
		return known(tl);
	}
	return {
		colors: {
			color: tl("{label} color", { label: owner }),
			end: tl("{label} end color", { label: owner }),
			start: tl("{label} start color", { label: owner }),
		},
		owner,
	};
}
