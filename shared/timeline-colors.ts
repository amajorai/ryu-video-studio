import { z } from "zod";

/**
 * Default timeline fill colors per clip kind (a per-viewer preference). A
 * clip with an explicit color tag keeps the tag; every other clip uses its
 * kind's color. Pure, so the UI pane, the timeline, and tests share it.
 */
export const TIMELINE_CLIP_KINDS = [
	"video",
	"audio",
	"image",
	"title",
	"caption",
	"graphic",
	"avatar",
	"adjustment",
] as const;
export type TimelineClipKind = (typeof TIMELINE_CLIP_KINDS)[number];

/** Built-in colors, chosen to stay readable under the clip's name. */
export const DEFAULT_TIMELINE_COLORS: Readonly<
	Record<TimelineClipKind, string>
> = {
	video: "#3e63dd",
	audio: "#30a46c",
	image: "#8e4ec6",
	title: "#d6409f",
	caption: "#8b8d98",
	graphic: "#0090ff",
	avatar: "#12a594",
	adjustment: "#f76b15",
};

/** Names shown in the Timeline colors pane. */
export const TIMELINE_CLIP_KIND_LABELS: Readonly<
	Record<TimelineClipKind, string>
> = {
	video: "Video clips",
	audio: "Audio clips",
	image: "Image clips",
	title: "Titles",
	caption: "Captions",
	graphic: "Graphics",
	avatar: "Avatars",
	adjustment: "Adjustment layers",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const SHORT_HEX_COLOR = /^#[0-9a-f]{3}$/;

/** `#RGB` or `#RRGGBB` (any case) as lowercase `#rrggbb`; anything else is null. */
export function normalizeHexColor(input: string): string | null {
	const value = input.trim().toLowerCase();
	if (HEX_COLOR.test(value)) {
		return value;
	}
	if (SHORT_HEX_COLOR.test(value)) {
		return `#${[...value.slice(1)].map((digit) => digit + digit).join("")}`;
	}
	return null;
}

/** Stored overrides: only kinds the viewer changed, as `#rrggbb`. */
export type TimelineColorOverrides = Partial<Record<TimelineClipKind, string>>;

/**
 * Parses stored overrides. Unknown kinds and malformed colors are dropped
 * rather than failing the whole preference.
 */
export const timelineColorOverridesSchema = z
	.record(z.string(), z.unknown())
	.transform((raw): TimelineColorOverrides => {
		const overrides: TimelineColorOverrides = {};
		for (const kind of TIMELINE_CLIP_KINDS) {
			const value = raw[kind];
			const color = typeof value === "string" ? normalizeHexColor(value) : null;
			if (color && color !== DEFAULT_TIMELINE_COLORS[kind]) {
				overrides[kind] = color;
			}
		}
		return overrides;
	});

/** Every kind's effective color: the override, else the default. */
export function resolveTimelineColors(
	overrides: TimelineColorOverrides
): Record<TimelineClipKind, string> {
	return Object.fromEntries(
		TIMELINE_CLIP_KINDS.map((kind) => [
			kind,
			overrides[kind] ?? DEFAULT_TIMELINE_COLORS[kind],
		])
	) as Record<TimelineClipKind, string>;
}

/**
 * Set one kind's color. A color equal to the default (or an invalid one)
 * removes the override, so stored preferences stay minimal.
 */
export function withTimelineColor(
	overrides: TimelineColorOverrides,
	kind: TimelineClipKind,
	color: string
): TimelineColorOverrides {
	const normalized = normalizeHexColor(color);
	const next = { ...overrides };
	if (!normalized || normalized === DEFAULT_TIMELINE_COLORS[kind]) {
		delete next[kind];
	} else {
		next[kind] = normalized;
	}
	return next;
}

/** The CSS custom property that carries `kind`'s fill on the timeline root. */
export const timelineColorVariable = (kind: TimelineClipKind) =>
	`--studio-clip-kind-${kind}` as const;

/** CSS custom properties for the timeline root, one per kind. */
export function timelineColorVariables(
	overrides: TimelineColorOverrides
): Record<`--studio-clip-kind-${TimelineClipKind}`, string> {
	const colors = resolveTimelineColors(overrides);
	return Object.fromEntries(
		TIMELINE_CLIP_KINDS.map((kind) => [
			timelineColorVariable(kind),
			colors[kind],
		])
	) as Record<`--studio-clip-kind-${TimelineClipKind}`, string>;
}

/** Timeline kind of a media clip, from its asset kind. */
export function mediaClipKind(
	assetKind: "audio" | "image" | "video" | undefined
): TimelineClipKind {
	return assetKind ?? "video";
}

/** Timeline kind of an overlay lane item. */
export function overlayClipKind(
	overlayKind:
		| "adjustmentLayers"
		| "avatars"
		| "captions"
		| "graphics"
		| "titles"
): TimelineClipKind {
	switch (overlayKind) {
		case "adjustmentLayers":
			return "adjustment";
		case "avatars":
			return "avatar";
		case "captions":
			return "caption";
		case "graphics":
			return "graphic";
		default:
			return "title";
	}
}
