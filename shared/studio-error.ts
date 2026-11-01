/**
 * Sidecar errors that name a clip, track, scene or media item. The sidecar
 * still answers with English `message` text, and adds `messageCode` and
 * `params` so the editor can show the message in the host language (the
 * English ICU template below is the catalog key; see `ui/src/i18n/format.ts`).
 * Names inside `params` are user content and are never translated.
 */
export const STUDIO_ERROR_MESSAGES = {
	"avatar.clip-missing": "The {label} clip is not on this timeline.",
	"relink.replacement-in-use":
		'"{name}" is already used in a project. Upload the replacement as new media and relink to that.',
	"relink.replacement-offline": 'The replacement "{name}" is offline too.',
	"relink.target-online":
		'"{name}" is online. Only offline media can be relinked.',
	"storyboard.audio-range-empty": "The audio range for {scene} is empty.",
	"storyboard.media-missing": "Select available media for {scene}.",
	"storyboard.range-empty": "The selected range for {scene} is empty.",
	"storyboard.take-missing": "Select a take for {scene}.",
	"template.slot-too-short": '"{name}" is too short for a template slot.',
	"track.has-clips":
		"{track} has {count, plural, one {# clip} other {# clips}}. Remove them first or force the removal.",
	"track.locked": "Unlock {track} before removing it.",
} as const;

export type StudioErrorCode = keyof typeof STUDIO_ERROR_MESSAGES;
export type StudioErrorParams = Readonly<Record<string, string | number>>;

export interface StudioErrorDetail {
	messageCode: StudioErrorCode;
	params: StudioErrorParams;
}

const DETAIL = Symbol.for("ryu.video-studio.error-detail");

/** Find the `}` matching the `{` at `open`, or -1. */
function closingBrace(text: string, open: number): number {
	let depth = 0;
	for (let index = open; index < text.length; index++) {
		if (text[index] === "{") {
			depth++;
		} else if (text[index] === "}") {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

/** `one {…} other {…}` → option map. */
function pluralOptions(body: string): Map<string, string> {
	const options = new Map<string, string>();
	let cursor = 0;
	while (cursor < body.length) {
		const open = body.indexOf("{", cursor);
		if (open < 0) {
			break;
		}
		const close = closingBrace(body, open);
		if (close < 0) {
			break;
		}
		options.set(body.slice(cursor, open).trim(), body.slice(open + 1, close));
		cursor = close + 1;
	}
	return options;
}

/**
 * English rendering of an ICU template: `{name}` arguments and
 * `{count, plural, one {…} other {…}}` with `#`. The editor formats the same
 * templates (and their translations) with the host's ICU formatter.
 */
export function formatEnglishTemplate(
	template: string,
	params: StudioErrorParams,
	hash?: number
): string {
	let output = "";
	let cursor = 0;
	while (cursor < template.length) {
		const open = template.indexOf("{", cursor);
		const sharp = hash === undefined ? -1 : template.indexOf("#", cursor);
		if (open < 0 && sharp < 0) {
			output += template.slice(cursor);
			break;
		}
		if (sharp >= 0 && (open < 0 || sharp < open)) {
			output += `${template.slice(cursor, sharp)}${hash}`;
			cursor = sharp + 1;
			continue;
		}
		output += template.slice(cursor, open);
		const close = closingBrace(template, open);
		if (close < 0) {
			output += template.slice(open);
			break;
		}
		const [name = "", kind, ...rest] = template
			.slice(open + 1, close)
			.split(",");
		const value = params[name.trim()];
		if (kind?.trim() === "plural") {
			const count = Number(value);
			const options = pluralOptions(rest.join(","));
			const chosen =
				options.get(`=${count}`) ??
				options.get(count === 1 ? "one" : "other") ??
				options.get("other") ??
				"";
			output += formatEnglishTemplate(chosen, params, count);
		} else {
			output += value === undefined ? "" : String(value);
		}
		cursor = close + 1;
	}
	return output;
}

/**
 * Build an error whose English message comes from `code`'s template, with
 * the code and params attached for the editor to localize.
 */
export function studioError<E extends Error>(
	make: (message: string) => E,
	messageCode: StudioErrorCode,
	params: StudioErrorParams = {}
): E {
	const error = make(
		formatEnglishTemplate(STUDIO_ERROR_MESSAGES[messageCode], params)
	);
	Object.defineProperty(error, DETAIL, {
		enumerable: false,
		value: { messageCode, params } satisfies StudioErrorDetail,
	});
	return error;
}

/** The code and params a `studioError` carries, for the error response. */
export function studioErrorDetail(error: unknown): StudioErrorDetail | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const detail = (error as Error & { [DETAIL]?: StudioErrorDetail })[DETAIL];
	return detail ?? null;
}

/** Whether `code` is one of the localizable error codes. */
export function isStudioErrorCode(code: unknown): code is StudioErrorCode {
	return typeof code === "string" && Object.hasOwn(STUDIO_ERROR_MESSAGES, code);
}
