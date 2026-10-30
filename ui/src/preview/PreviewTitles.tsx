import "../fonts.css";
import type { CSSProperties, ReactNode } from "react";
import type { Project } from "../../../shared/project.ts";
import {
	activeWordAt,
	glyphOffsetAt,
	glyphVisibleAt,
	titleAt,
	titleLayout,
	titleMotionAt,
	titleTimingOf,
	usesGlyphMotion,
} from "../../../shared/text-animation.ts";
import {
	glyphFillColor,
	isStyledTitle,
	TITLE_FONTS,
	titleStyleOf,
	WORD_BLOCK_PADDING,
} from "../../../shared/text-style.ts";
import { fontChoiceCss, useProjectFontFaces } from "../imported-fonts.ts";
import type { PreviewStyle } from "./preview-style.ts";

type Title = Project["titles"][number];
type Canvas = Pick<Project, "height" | "width">;

const slideTransforms: Partial<
	Record<Title["animation"], (offset: number) => string>
> = {
	"slide-down": (offset) => `translateY(${-offset * 100}%)`,
	"slide-left": (offset) => `translateX(${offset * 100}%)`,
	"slide-right": (offset) => `translateX(${-offset * 100}%)`,
	"slide-up": (offset) => `translateY(${offset * 100}%)`,
};

/** A canvas-height fraction as container-width units. */
const heightCqw = (fraction: number, project: Canvas) =>
	`${(fraction * project.height * 100) / project.width}cqw`;

/** `#rrggbb` plus an opacity as `rgb(r g b / a)`. */
function rgba(hex: string, alpha: number): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`;
}

function legacyTitleStyle(
	title: Title,
	project: Canvas,
	time: number
): PreviewStyle {
	const elapsed = time - title.start;
	const remaining = title.end - time;
	const entryProgress = title.fadeIn
		? Math.min(1, Math.max(0, elapsed / title.fadeIn))
		: 1;
	const entryOffset = (1 - entryProgress) * 0.08;
	const transform = slideTransforms[title.animation]?.(entryOffset);
	const opacity = Math.max(
		0,
		Math.min(
			1,
			title.fadeIn ? elapsed / title.fadeIn : 1,
			title.fadeOut ? remaining / title.fadeOut : 1
		)
	);
	return {
		"--studio-title-left": `${title.x * 100}%`,
		"--studio-title-top": `${title.y * 100}%`,
		"--studio-title-font-size": `${((title.fontSize * project.height) / project.width) * 100}cqw`,
		"--studio-title-color": title.color,
		"--studio-title-opacity": `${opacity}`,
		"--studio-title-transform": transform ?? "translate(-50%, -50%)",
	};
}

/**
 * Horizontal anchor shift and transform origin per alignment. The text itself
 * (not a background box's padded edge) sits at the title's x, as in the ASS
 * export, which anchors the text and grows the box outward by the padding.
 */
function anchorFor(
	align: "center" | "left" | "right",
	padding: string | null
): { origin: string; shift: string } {
	if (align === "center" || !padding) {
		const percent = { center: 50, left: 0, right: 100 }[align];
		return { origin: `${percent}% 50%`, shift: `${-percent}%` };
	}
	return align === "left"
		? { origin: `${padding} 50%`, shift: `calc(-1 * ${padding})` }
		: {
				origin: `calc(100% - ${padding}) 50%`,
				shift: `calc(-100% + ${padding})`,
			};
}

type ResolvedStyle = ReturnType<typeof titleStyleOf>;

/**
 * The background box: padding per axis, a radius relative to the padded box
 * height (as the ASS drawing), and the fill. An offset box is painted by the
 * element's `::before` (shifted by `--studio-title-box-x/y`, see studio.css)
 * so the text keeps its place; otherwise the element's own background is it.
 */
function boxStyle(
	style: ResolvedStyle,
	project: Canvas,
	fontPx: number,
	rows: number
): PreviewStyle {
	const fill = rgba(
		style.backgroundColor ?? "#000000",
		style.backgroundOpacity
	);
	const boxHeight =
		fontPx * (1 + (rows - 1) * style.lineHeight) +
		2 * style.backgroundPaddingY * project.height;
	const result: PreviewStyle = {
		borderRadius: heightCqw(
			(style.backgroundRadius * boxHeight) / project.height,
			project
		),
		padding:
			style.backgroundPaddingX === style.backgroundPaddingY
				? heightCqw(style.backgroundPaddingY, project)
				: `${heightCqw(style.backgroundPaddingY, project)} ${heightCqw(style.backgroundPaddingX, project)}`,
	};
	if (style.backgroundOffsetX === 0 && style.backgroundOffsetY === 0) {
		result.backgroundColor = fill;
		return result;
	}
	result["--studio-title-box"] = fill;
	result["--studio-title-box-x"] = `${style.backgroundOffsetX * 100}cqw`;
	result["--studio-title-box-y"] = heightCqw(style.backgroundOffsetY, project);
	return result;
}

/**
 * CSS for one title at `time` (which must lie inside the title). Legacy titles
 * keep their original variables; styled titles follow the shared motion
 * functions the ASS renderer samples, so preview and export agree.
 */
export function titleStyle(
	keyed: Title,
	project: Canvas,
	time: number
): PreviewStyle {
	if (!isStyledTitle(keyed)) {
		return legacyTitleStyle(keyed, project, time);
	}
	// Keyframed text styles and colors, resolved like the ASS events.
	const title = titleAt(keyed, time);
	const style = titleStyleOf(title);
	const motion = titleMotionAt(title, time);
	const rows = title.text.split(/\r?\n/).length;
	const fontPx = title.fontSize * project.height;
	const boxPaddingX = style.backgroundColor
		? heightCqw(style.backgroundPaddingX, project)
		: null;
	const anchor = anchorFor(style.align, boxPaddingX);
	const result: PreviewStyle = {
		"--studio-title-left": `${motion.x * 100}%`,
		"--studio-title-top": `${motion.y * 100}%`,
		"--studio-title-font-size": heightCqw(title.fontSize, project),
		"--studio-title-color": title.color,
		"--studio-title-opacity": `${motion.opacity}`,
		"--studio-title-transform": `translate(${anchor.shift}, -50%) scale(${motion.scale}) rotate(${motion.rotation}deg)`,
		fontFamily: fontChoiceCss(style, TITLE_FONTS[style.fontFamily].css),
		fontStyle: style.italic ? "italic" : "normal",
		fontWeight: style.fontWeight,
		letterSpacing: `${style.letterSpacing}em`,
		lineHeight: style.lineHeight,
		textAlign: style.align,
		textDecorationLine:
			[style.underline && "underline", style.strike && "line-through"]
				.filter(Boolean)
				.join(" ") || "none",
		transformOrigin: anchor.origin,
	};
	if (style.outlineWidth > 0) {
		// ASS outlines grow outward; a stroke painted under the fill shows half
		// its width, so the stroke is twice the outline.
		result.WebkitTextStroke = `${heightCqw(style.outlineWidth * 2, project)} ${style.outlineColor}`;
		result.paintOrder = "stroke fill";
	}
	result.textShadow =
		style.shadowDepth > 0 || style.shadowBlur > 0
			? `${heightCqw(style.shadowDepth, project)} ${heightCqw(style.shadowDepth, project)} ${heightCqw(style.shadowBlur / 1080, project)} ${rgba(style.shadowColor, style.shadowBlur > 0 ? 0.7 : 0.5)}`
			: "none";
	const blur = motion.blur + style.textBlur;
	if (blur > 0) {
		result.filter = `blur(${heightCqw(blur, project)})`;
	}
	if (style.backgroundColor) {
		Object.assign(result, boxStyle(style, project, fontPx, rows));
	}
	return result;
}

const glyphBase: CSSProperties = { whiteSpace: "pre" };

/**
 * Title text at `time`: plain text, or per-glyph spans when typewriter,
 * word reveal, word highlight, or wave motion needs them. Hidden glyphs keep
 * their space, as in the rendered ASS.
 */
export function titleContent(
	keyed: Title,
	project: Canvas,
	time: number
): ReactNode {
	if (!isStyledTitle(keyed)) {
		return keyed.text;
	}
	const title = titleAt(keyed, time);
	const timing = titleTimingOf(title);
	const style = titleStyleOf(title);
	const perGlyph =
		usesGlyphMotion(timing) ||
		Boolean(style.gradientColor) ||
		[
			"typewriter",
			"word-reveal",
			"word-highlight",
			"word-highlight-block",
		].includes(timing.animationIn);
	if (!perGlyph) {
		return title.text;
	}
	const layout = titleLayout(title.text);
	const active = activeWordAt(timing, layout, time);
	const highlight = style.highlightColor;
	const block = timing.animationIn === "word-highlight-block";
	const wave = usesGlyphMotion(timing);
	return layout.rows.map((row, rowIndex) => (
		<span data-title-row={rowIndex} key={`row-${rowIndex}`}>
			{rowIndex > 0 && <br />}
			{row.map((glyph) => {
				const glyphStyle: CSSProperties = { ...glyphBase };
				if (!glyphVisibleAt(timing, layout, glyph, time)) {
					glyphStyle.visibility = "hidden";
				}
				const position = row.indexOf(glyph);
				if (style.gradientColor) {
					glyphStyle.color = glyphFillColor(title, style, position, row.length);
				}
				if (active !== null && glyph.word === active) {
					if (block) {
						// A box behind the active word, padded like the ASS box.
						glyphStyle.backgroundColor = highlight;
						glyphStyle.boxShadow = `0 0 0 ${heightCqw(WORD_BLOCK_PADDING * title.fontSize, project)} ${highlight}`;
					} else {
						glyphStyle.color = highlight;
					}
				}
				if (wave) {
					glyphStyle.display = "inline-block";
					glyphStyle.transform = `translateY(${heightCqw(glyphOffsetAt(timing, layout, glyph, time), project)})`;
				}
				return (
					<span
						className="studio-title-glyph"
						data-active={
							active !== null && glyph.word === active ? "true" : undefined
						}
						key={glyph.index}
						style={glyphStyle}
					>
						{glyph.char}
					</span>
				);
			})}
		</span>
	));
}

/** Titles visible at `time`, in project order. */
export function PreviewTitles({
	project,
	time,
}: {
	project: Project;
	time: number;
}) {
	useProjectFontFaces(project.titles);
	return project.titles
		.filter((title) => time >= title.start && time < title.end)
		.map((title) => (
			<div
				className="studio-title"
				data-template={title.templateId}
				key={title.id}
				style={titleStyle(title, project, time)}
			>
				{titleContent(title, project, time)}
			</div>
		));
}
