import type { Title } from "./project.ts";
import type { CustomFont } from "./schema/font.ts";
import type { FontFamily, TextAlign } from "./schema/text-style.ts";

/** One selectable title font: its ASS name, CSS stack, and bundled files. */
export interface TitleFont {
	/** Family name libass matches (the font's own family name). */
	assName: string;
	category: "display" | "mono" | "sans" | "script" | "serif";
	/** CSS `font-family` for the preview (`ui/src/fonts.css` names faces "Studio …"). */
	css: string;
	/** Bundled TTF files under `sidecar/assets/fonts/` (none for the system face). */
	files: readonly string[];
	id: FontFamily;
	label: string;
	/** Average advance of a lowercase glyph, in ems, for box size estimates. */
	widthFactor: number;
}

const font = (
	id: FontFamily,
	label: string,
	assName: string,
	category: TitleFont["category"],
	files: readonly string[],
	widthFactor: number,
	fallback: string
): TitleFont => ({
	assName,
	category,
	css: `"Studio ${assName}", "${assName}", ${fallback}`,
	files,
	id,
	label,
	widthFactor,
});

/** Every title font, in picker order. `system-sans` keeps the legacy face. */
export const TITLE_FONTS: Readonly<Record<FontFamily, TitleFont>> = {
	"system-sans": {
		assName: "Arial",
		category: "sans",
		css: "var(--font-sans, sans-serif)",
		files: [],
		id: "system-sans",
		label: "System sans",
		widthFactor: 0.55,
	},
	inter: font(
		"inter",
		"Inter",
		"Inter",
		"sans",
		["Inter-Regular.ttf", "Inter-Bold.ttf"],
		0.56,
		"sans-serif"
	),
	roboto: font(
		"roboto",
		"Roboto",
		"Roboto",
		"sans",
		["Roboto-Regular.ttf", "Roboto-Bold.ttf"],
		0.53,
		"sans-serif"
	),
	montserrat: font(
		"montserrat",
		"Montserrat",
		"Montserrat",
		"sans",
		["Montserrat-Regular.ttf", "Montserrat-Bold.ttf"],
		0.62,
		"sans-serif"
	),
	poppins: font(
		"poppins",
		"Poppins",
		"Poppins",
		"sans",
		["Poppins-Regular.ttf", "Poppins-Bold.ttf"],
		0.6,
		"sans-serif"
	),
	oswald: font(
		"oswald",
		"Oswald",
		"Oswald",
		"display",
		["Oswald-Regular.ttf", "Oswald-Bold.ttf"],
		0.42,
		"sans-serif"
	),
	"bebas-neue": font(
		"bebas-neue",
		"Bebas Neue",
		"Bebas Neue",
		"display",
		["BebasNeue-Regular.ttf"],
		0.4,
		"sans-serif"
	),
	anton: font(
		"anton",
		"Anton",
		"Anton",
		"display",
		["Anton-Regular.ttf"],
		0.46,
		"sans-serif"
	),
	"playfair-display": font(
		"playfair-display",
		"Playfair Display",
		"Playfair Display",
		"serif",
		["PlayfairDisplay-Regular.ttf", "PlayfairDisplay-Bold.ttf"],
		0.52,
		"serif"
	),
	merriweather: font(
		"merriweather",
		"Merriweather",
		"Merriweather",
		"serif",
		["Merriweather-Regular.ttf", "Merriweather-Bold.ttf"],
		0.58,
		"serif"
	),
	"source-code-pro": font(
		"source-code-pro",
		"Source Code Pro",
		"Source Code Pro",
		"mono",
		["SourceCodePro-Regular.ttf", "SourceCodePro-Bold.ttf"],
		0.6,
		"monospace"
	),
	"permanent-marker": font(
		"permanent-marker",
		"Permanent Marker",
		"Permanent Marker",
		"script",
		["PermanentMarker-Regular.ttf"],
		0.6,
		"cursive"
	),
	lobster: font(
		"lobster",
		"Lobster",
		"Lobster",
		"script",
		["Lobster-Regular.ttf"],
		0.46,
		"cursive"
	),
};

/** Every bundled TTF file name, deduplicated, in catalog order. */
export const BUNDLED_FONT_FILES: readonly string[] = [
	...new Set(Object.values(TITLE_FONTS).flatMap((entry) => entry.files)),
];

/** The legacy title outline: 2px at 1080p, as the ASS `Default` style draws it. */
export const DEFAULT_TITLE_OUTLINE = 2 / 1080;
export const DEFAULT_TITLE_HIGHLIGHT = "#ffd43b";
export const DEFAULT_TITLE_LINE_HEIGHT = 1.2;
export const DEFAULT_BOX_PADDING = 0.012;

/** A title's text style with every optional field resolved. */
export interface ResolvedTitleStyle {
	align: TextAlign;
	/** Box fill, or null for no box. */
	backgroundColor: string | null;
	/** Box shift right of the text, as a fraction of the canvas width. */
	backgroundOffsetX: number;
	/** Box shift below the text, as a fraction of the canvas height. */
	backgroundOffsetY: number;
	backgroundOpacity: number;
	/** Box padding as a fraction of the canvas height. */
	backgroundPadding: number;
	/** Left and right box padding as a fraction of the canvas height. */
	backgroundPaddingX: number;
	/** Top and bottom box padding as a fraction of the canvas height. */
	backgroundPaddingY: number;
	/** Corner radius as a fraction of the box height (0.5 is a pill). */
	backgroundRadius: number;
	/** An imported font chosen for the title, or null for `fontFamily`. */
	customFont: CustomFont | null;
	fontFamily: FontFamily;
	fontWeight: number;
	/** End color of a gradient fill; null fills with the title color. */
	gradientColor: string | null;
	highlightColor: string;
	italic: boolean;
	/** Extra spacing between glyphs, in ems. */
	letterSpacing: number;
	/** Distance between baselines, in multiples of the font size. */
	lineHeight: number;
	outlineColor: string;
	/** Outline width as a fraction of the canvas height. */
	outlineWidth: number;
	/** Clockwise rotation in degrees. */
	rotation: number;
	shadowBlur: number;
	shadowColor: string;
	/** Shadow offset as a fraction of the canvas height. */
	shadowDepth: number;
	strike: boolean;
	/** An installed system font by family, or null; `customFont` wins. */
	systemFont: string | null;
	/** Text blur as a fraction of the canvas height. */
	textBlur: number;
	underline: boolean;
}

/** Resolve a title's optional style fields (absent fields keep legacy looks). */
export function titleStyleOf(title: Title): ResolvedTitleStyle {
	const padding = title.backgroundPadding ?? DEFAULT_BOX_PADDING;
	return {
		align: title.align ?? "center",
		backgroundColor: title.backgroundColor ?? null,
		backgroundOpacity: title.backgroundOpacity ?? 1,
		backgroundOffsetX: title.backgroundOffsetX ?? 0,
		backgroundOffsetY: title.backgroundOffsetY ?? 0,
		backgroundPadding: padding,
		backgroundPaddingX: title.backgroundPaddingX ?? padding,
		backgroundPaddingY: title.backgroundPaddingY ?? padding,
		backgroundRadius: title.backgroundRadius ?? 0,
		customFont: title.customFont ?? null,
		fontFamily: title.fontFamily ?? "system-sans",
		fontWeight: title.fontWeight ?? 700,
		gradientColor:
			title.fillMode === "gradient"
				? (title.gradientColor ?? DEFAULT_GRADIENT_END)
				: null,
		highlightColor: title.highlightColor ?? DEFAULT_TITLE_HIGHLIGHT,
		italic: title.italic ?? false,
		letterSpacing: title.letterSpacing ?? 0,
		lineHeight: title.lineHeight ?? DEFAULT_TITLE_LINE_HEIGHT,
		outlineColor: title.outlineColor ?? "#000000",
		outlineWidth: title.outlineWidth ?? DEFAULT_TITLE_OUTLINE,
		rotation: title.rotation ?? 0,
		shadowBlur: title.shadowBlur ?? 0,
		shadowColor: title.shadowColor ?? "#000000",
		shadowDepth: title.shadowDepth ?? 0,
		strike: title.strike ?? false,
		systemFont: title.systemFont ?? null,
		textBlur: title.textBlur ?? 0,
		underline: title.underline ?? false,
	};
}

/** Padding of the word-highlight-block box, as a fraction of the font size. */
export const WORD_BLOCK_PADDING = 0.12;

/** Gradient end color when a gradient title has none set. */
export const DEFAULT_GRADIENT_END = "#7c3aed";

const hexChannels = (hex: string) =>
	[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

/** The color at `fraction` (0..1) between two `#rrggbb` colors. */
export function mixHex(from: string, to: string, fraction: number): string {
	const a = hexChannels(from);
	const b = hexChannels(to);
	const t = Math.min(1, Math.max(0, fraction));
	return `#${a
		.map((channel, index) =>
			Math.round(channel + ((b[index] ?? channel) - channel) * t)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

/**
 * The fill color of glyph `index` in a row of `count` glyphs: the title
 * color, or its point on the left-to-right gradient. Preview and render
 * both color per glyph, so they match exactly.
 */
export function glyphFillColor(
	title: Pick<Title, "color">,
	style: Pick<ResolvedTitleStyle, "gradientColor">,
	index: number,
	count: number
): string {
	if (!style.gradientColor) {
		return title.color;
	}
	return mixHex(
		title.color,
		style.gradientColor,
		count > 1 ? index / (count - 1) : 0
	);
}

/** Fields that switch a title from the legacy `Default` path to its own style. */
const STYLE_FIELDS = [
	"fontFamily",
	"customFont",
	"systemFont",
	"fontWeight",
	"italic",
	"underline",
	"strike",
	"letterSpacing",
	"lineHeight",
	"align",
	"outlineColor",
	"outlineWidth",
	"shadowColor",
	"shadowDepth",
	"shadowBlur",
	"backgroundColor",
	"backgroundOpacity",
	"backgroundPadding",
	"backgroundPaddingX",
	"backgroundPaddingY",
	"backgroundOffsetX",
	"backgroundOffsetY",
	"backgroundRadius",
	"animationIn",
	"animationOut",
	"animationLoop",
	"animationInDuration",
	"animationOutDuration",
	"highlightColor",
	"fillMode",
	"gradientColor",
	"textBlur",
	"rotation",
	"keyframes",
] as const satisfies readonly (keyof Title)[];

/**
 * Whether a title uses any W3 style or motion field. Legacy titles keep the
 * exact `Default`-style output so old projects render byte-identically.
 */
export function isStyledTitle(title: Title): boolean {
	return STYLE_FIELDS.some((field) => {
		const value = title[field];
		return Array.isArray(value) ? value.length > 0 : value !== undefined;
	});
}

/** The style fields a template or "copy style" carries, without timing or text. */
export type TitleStylePatch = Partial<
	Pick<Title, (typeof STYLE_FIELDS)[number] | "color" | "fontSize">
>;

/** Copy every style and motion field of `title` (not its text, place, or time). */
export function titleStylePatch(title: Title): TitleStylePatch {
	const patch: Record<string, unknown> = {
		color: title.color,
		fontSize: title.fontSize,
	};
	for (const field of STYLE_FIELDS) {
		if (field !== "keyframes" && title[field] !== undefined) {
			patch[field] = title[field];
		}
	}
	return patch as TitleStylePatch;
}

/** ASS numpad alignment for a horizontal alignment, vertically centered. */
export function assAlignment(align: TextAlign): 4 | 5 | 6 {
	if (align === "left") {
		return 4;
	}
	return align === "right" ? 6 : 5;
}

/**
 * The ASS `Bold` flag: libass reads style weights as on/off, so 600 and up
 * select the bundled Bold face (or synthesize bold for single-weight fonts).
 */
export function assBold(weight: number): -1 | 0 {
	return weight >= 600 ? -1 : 0;
}

const NARROW = new Set([..."ilIjtfr.,;:'!|()[]1`"]);
const WIDE = new Set([..."mwMW@%&"]);

/** Width of one glyph relative to an average lowercase letter. */
function glyphWeight(char: string): number {
	if (char === " ") {
		return 0.5;
	}
	if (NARROW.has(char)) {
		return 0.55;
	}
	if (WIDE.has(char)) {
		return 1.5;
	}
	return char === char.toLowerCase() ? 1 : 1.2;
}

/**
 * Estimated pixel size of `text` drawn at `fontPx`: libass does not report
 * glyph extents, so rounded boxes use this per-family estimate.
 */
export function estimateTextSize(
	text: string,
	style: Pick<
		ResolvedTitleStyle,
		"fontFamily" | "fontWeight" | "letterSpacing" | "lineHeight"
	>,
	fontPx: number
): { height: number; width: number } {
	const rows = text.split("\n");
	const factor =
		TITLE_FONTS[style.fontFamily].widthFactor *
		(style.fontWeight >= 600 ? 1.06 : 1);
	const widths = rows.map((row) => {
		const glyphs = Array.from(row);
		const advance = glyphs.reduce((sum, char) => sum + glyphWeight(char), 0);
		return (
			fontPx * factor * advance +
			Math.max(0, glyphs.length - 1) * style.letterSpacing * fontPx
		);
	});
	return {
		height: fontPx * (1 + (rows.length - 1) * style.lineHeight),
		width: Math.max(0, ...widths),
	};
}
