/**
 * Preview guide geometry in project pixels. Guides are viewer aids only:
 * they are drawn over the preview and never reach a render or export.
 */

export const PREVIEW_GUIDE_IDS = [
	"action-safe",
	"title-safe",
	"thirds",
	"center",
	"aspect-9:16",
	"aspect-4:5",
	"aspect-1:1",
	"aspect-1.85",
	"aspect-2.39",
	"vertical-ui",
	"vertical-captions",
	"vertical-rail",
	"vertical-sheet",
	"grid",
	"custom",
] as const;

export type PreviewGuideId = (typeof PREVIEW_GUIDE_IDS)[number];

export const PREVIEW_GUIDE_LABELS: Record<PreviewGuideId, string> = {
	"action-safe": "Action safe (90%)",
	"aspect-1.85": "1.85:1",
	"aspect-1:1": "1:1",
	"aspect-2.39": "2.39:1",
	"aspect-4:5": "4:5",
	"aspect-9:16": "9:16",
	center: "Center cross",
	thirds: "Rule of thirds",
	custom: "Custom guide",
	grid: "Grid",
	"title-safe": "Title safe (80%)",
	"vertical-captions": "Vertical layout · caption-heavy",
	"vertical-rail": "Vertical layout · right action rail",
	"vertical-sheet": "Vertical layout · bottom sheet",
	"vertical-ui": "Vertical video UI zones",
};

/**
 * The viewer's own guide: an optional centered aspect box (width / height),
 * optional margins (fractions of the frame inset from each edge), and the
 * density of the Grid guide. Stored per viewer, never in the project.
 */
export interface CustomGuide {
	/** Width / height of a centered box; null draws none. */
	aspect: number | null;
	gridColumns: number;
	gridRows: number;
	/** Inset fractions; all zero draws no margin box. */
	margins: { bottom: number; left: number; right: number; top: number };
}

export const DEFAULT_CUSTOM_GUIDE: CustomGuide = {
	aspect: null,
	gridColumns: 4,
	gridRows: 4,
	margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
};

/** Bounds the custom guide is kept within. */
export const CUSTOM_GUIDE_LIMITS = {
	maxAspect: 10,
	maxGrid: 24,
	maxMargin: 0.45,
	minAspect: 0.1,
	minGrid: 2,
} as const;

const clampNumber = (
	value: number,
	min: number,
	max: number,
	fallback: number
) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** A custom guide with every field inside `CUSTOM_GUIDE_LIMITS`. */
export function normalizeCustomGuide(
	guide: Partial<CustomGuide> | undefined
): CustomGuide {
	const base = DEFAULT_CUSTOM_GUIDE;
	const margin = (key: keyof CustomGuide["margins"]) =>
		clampNumber(
			guide?.margins?.[key] ?? base.margins[key],
			0,
			CUSTOM_GUIDE_LIMITS.maxMargin,
			base.margins[key]
		);
	const grid = (value: number | undefined, fallback: number) =>
		Math.round(
			clampNumber(
				value ?? fallback,
				CUSTOM_GUIDE_LIMITS.minGrid,
				CUSTOM_GUIDE_LIMITS.maxGrid,
				fallback
			)
		);
	const aspect = guide?.aspect ?? base.aspect;
	return {
		aspect:
			aspect === null
				? null
				: clampNumber(
						aspect,
						CUSTOM_GUIDE_LIMITS.minAspect,
						CUSTOM_GUIDE_LIMITS.maxAspect,
						1
					),
		gridColumns: grid(guide?.gridColumns, base.gridColumns),
		gridRows: grid(guide?.gridRows, base.gridRows),
		margins: {
			bottom: margin("bottom"),
			left: margin("left"),
			right: margin("right"),
			top: margin("top"),
		},
	};
}

/**
 * Parse "W:H" or a decimal ratio ("2.35") into width / height, or null for
 * an empty or invalid entry.
 */
export function parseGuideAspect(text: string): number | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	const parts = trimmed.split(/[:/x×]/).map((part) => Number(part.trim()));
	const ratio =
		parts.length === 2 ? (parts[0] ?? 0) / (parts[1] ?? 0) : Number(trimmed);
	return Number.isFinite(ratio) &&
		ratio >= CUSTOM_GUIDE_LIMITS.minAspect &&
		ratio <= CUSTOM_GUIDE_LIMITS.maxAspect
		? ratio
		: null;
}

/** Guides shown when the viewer turns guides on without having picked any. */
export const DEFAULT_PREVIEW_GUIDES: readonly PreviewGuideId[] = [
	"action-safe",
	"title-safe",
];

export function isPreviewGuideId(value: string): value is PreviewGuideId {
	return (PREVIEW_GUIDE_IDS as readonly string[]).includes(value);
}

/** Safe-area fractions of the frame. */
export const SAFE_AREAS = { "action-safe": 0.9, "title-safe": 0.8 } as const;

/** Width / height of each aspect guide. */
export const ASPECT_GUIDES = {
	"aspect-1.85": 1.85,
	"aspect-1:1": 1,
	"aspect-2.39": 2.39,
	"aspect-4:5": 4 / 5,
	"aspect-9:16": 9 / 16,
} as const;

/** Generic short-form vertical video app chrome, as fractions of the 9:16 area. */
export const VERTICAL_UI_ZONES = {
	bottomCaption: 0.2,
	rightRail: 0.15,
	topBar: 0.08,
} as const;

/**
 * Generic, unbranded vertical layouts that approximate common short-form
 * apps: fractions of the 9:16 area covered by the top bar, the right rail
 * of action buttons, and the bottom caption or sheet.
 */
export const VERTICAL_LAYOUTS = {
	"vertical-captions": { bottom: 0.32, rail: 0.14, top: 0.06 },
	"vertical-rail": { bottom: 0.14, rail: 0.2, top: 0.06 },
	"vertical-sheet": { bottom: 0.4, rail: 0, top: 0.08 },
	"vertical-ui": {
		bottom: VERTICAL_UI_ZONES.bottomCaption,
		rail: VERTICAL_UI_ZONES.rightRail,
		top: VERTICAL_UI_ZONES.topBar,
	},
} as const;
type VerticalLayoutId = keyof typeof VERTICAL_LAYOUTS;

/** Length of each center-cross arm as a fraction of the frame's shorter side. */
export const CENTER_CROSS_ARM = 0.04;

export type GuideTone = "aspect" | "grid" | "safe" | "zone";

export interface GuideRect {
	height: number;
	id: string;
	kind: "rect";
	label?: string;
	tone: GuideTone;
	width: number;
	x: number;
	y: number;
}

export interface GuideLine {
	id: string;
	kind: "line";
	tone: GuideTone;
	x1: number;
	x2: number;
	y1: number;
	y2: number;
}

export type GuideShape = GuideLine | GuideRect;

interface Box {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** A centered `fraction` of the frame on both axes. */
export function safeAreaRect(
	width: number,
	height: number,
	fraction: number
): Box {
	const boxWidth = width * fraction;
	const boxHeight = height * fraction;
	return {
		height: boxHeight,
		width: boxWidth,
		x: (width - boxWidth) / 2,
		y: (height - boxHeight) / 2,
	};
}

/**
 * The largest centered box with aspect `ratio` (width / height) inside the
 * frame: pillarboxed when narrower than the frame, letterboxed when wider.
 */
export function aspectRect(width: number, height: number, ratio: number): Box {
	const frameRatio = width / height;
	if (ratio < frameRatio) {
		const boxWidth = height * ratio;
		return { height, width: boxWidth, x: (width - boxWidth) / 2, y: 0 };
	}
	const boxHeight = width / ratio;
	return { height: boxHeight, width, x: 0, y: (height - boxHeight) / 2 };
}

const sameAspect = (width: number, height: number, ratio: number) =>
	Math.abs(width / height - ratio) < 0.005;

function rect(
	id: string,
	box: Box,
	tone: GuideTone,
	label?: string
): GuideRect {
	return label === undefined
		? { ...box, id, kind: "rect", tone }
		: { ...box, id, kind: "rect", label, tone };
}

function line(
	id: string,
	tone: GuideTone,
	[x1, y1]: readonly [number, number],
	[x2, y2]: readonly [number, number]
): GuideLine {
	return { id, kind: "line", tone, x1, x2, y1, y2 };
}

/** The vertical-video area: the frame when it is 9:16 or narrower, else a centered 9:16 box. */
export function verticalArea(width: number, height: number): Box {
	const ratio = ASPECT_GUIDES["aspect-9:16"];
	return width / height <= ratio + 0.005
		? { height, width, x: 0, y: 0 }
		: aspectRect(width, height, ratio);
}

function verticalUiZones(
	width: number,
	height: number,
	id: VerticalLayoutId = "vertical-ui"
): GuideRect[] {
	const area = verticalArea(width, height);
	const layout = VERTICAL_LAYOUTS[id];
	const top = area.height * layout.top;
	const bottom = area.height * layout.bottom;
	const rail = area.width * layout.rail;
	const bottomLabel = id === "vertical-sheet" ? "Bottom sheet" : "Caption";
	const zones = [
		rect(
			`${id}:top`,
			{ height: top, width: area.width, x: area.x, y: area.y },
			"zone",
			"Top bar"
		),
		rect(
			`${id}:rail`,
			{
				height: area.height - top - bottom,
				width: rail,
				x: area.x + area.width - rail,
				y: area.y + top,
			},
			"zone",
			"Side actions"
		),
		rect(
			`${id}:bottom`,
			{
				height: bottom,
				width: area.width,
				x: area.x,
				y: area.y + area.height - bottom,
			},
			"zone",
			bottomLabel
		),
	];
	return zones.filter((zone) => zone.width > 0 && zone.height > 0);
}

function gridLines(
	width: number,
	height: number,
	columns: number,
	rows: number
): GuideLine[] {
	const lines: GuideLine[] = [];
	for (let column = 1; column < columns; column++) {
		const x = (width * column) / columns;
		lines.push(line(`grid:v${column}`, "grid", [x, 0], [x, height]));
	}
	for (let row = 1; row < rows; row++) {
		const y = (height * row) / rows;
		lines.push(line(`grid:h${row}`, "grid", [0, y], [width, y]));
	}
	return lines;
}

const ratioLabel = (ratio: number) => {
	for (let denominator = 1; denominator <= 20; denominator++) {
		const numerator = ratio * denominator;
		if (Math.abs(numerator - Math.round(numerator)) < 0.005) {
			return `${Math.round(numerator)}:${denominator}`;
		}
	}
	return `${ratio.toFixed(2)}:1`;
};

function customGuideShapes(
	width: number,
	height: number,
	guide: CustomGuide
): GuideRect[] {
	const shapes: GuideRect[] = [];
	const { bottom, left, right, top } = guide.margins;
	if (left + right + top + bottom > 0) {
		shapes.push(
			rect(
				"custom:margins",
				{
					height: height * Math.max(0, 1 - top - bottom),
					width: width * Math.max(0, 1 - left - right),
					x: width * left,
					y: height * top,
				},
				"safe",
				"Custom margins"
			)
		);
	}
	if (guide.aspect !== null && !sameAspect(width, height, guide.aspect)) {
		shapes.push(
			rect(
				"custom:aspect",
				aspectRect(width, height, guide.aspect),
				"aspect",
				`Custom ${ratioLabel(guide.aspect)}`
			)
		);
	}
	return shapes;
}

function guideShape(
	id: PreviewGuideId,
	width: number,
	height: number,
	custom: CustomGuide
): GuideShape[] {
	switch (id) {
		case "action-safe":
		case "title-safe":
			return [
				rect(
					id,
					safeAreaRect(width, height, SAFE_AREAS[id]),
					"safe",
					PREVIEW_GUIDE_LABELS[id]
				),
			];
		case "thirds":
			return [1, 2].flatMap((part) => [
				line(
					`thirds:v${part}`,
					"grid",
					[(width * part) / 3, 0],
					[(width * part) / 3, height]
				),
				line(
					`thirds:h${part}`,
					"grid",
					[0, (height * part) / 3],
					[width, (height * part) / 3]
				),
			]);
		case "center": {
			const arm = Math.min(width, height) * CENTER_CROSS_ARM;
			const cx = width / 2;
			const cy = height / 2;
			return [
				line("center:h", "grid", [cx - arm, cy], [cx + arm, cy]),
				line("center:v", "grid", [cx, cy - arm], [cx, cy + arm]),
			];
		}
		case "vertical-ui":
		case "vertical-captions":
		case "vertical-rail":
		case "vertical-sheet":
			return verticalUiZones(width, height, id);
		case "grid":
			return gridLines(width, height, custom.gridColumns, custom.gridRows);
		case "custom":
			return customGuideShapes(width, height, custom);
		default: {
			const ratio = ASPECT_GUIDES[id];
			// A guide matching the frame's own aspect would trace its edges.
			return sameAspect(width, height, ratio)
				? []
				: [
						rect(
							id,
							aspectRect(width, height, ratio),
							"aspect",
							PREVIEW_GUIDE_LABELS[id]
						),
					];
		}
	}
}

/**
 * Shapes for the active guides on a `width` × `height` frame, in the fixed
 * order of `PREVIEW_GUIDE_IDS` so drawing order is stable. Unknown ids and an
 * empty frame produce nothing.
 */
export function previewGuideShapes(
	active: Iterable<string>,
	width: number,
	height: number,
	custom: Partial<CustomGuide> = DEFAULT_CUSTOM_GUIDE
): GuideShape[] {
	if (!(width > 0 && height > 0)) {
		return [];
	}
	const wanted = new Set(active);
	const guide = normalizeCustomGuide(custom);
	return PREVIEW_GUIDE_IDS.filter((id) => wanted.has(id)).flatMap((id) =>
		guideShape(id, width, height, guide)
	);
}
