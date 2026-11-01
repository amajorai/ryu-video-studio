import "../fonts.css";
import type { CSSProperties, ReactNode } from "react";
import {
	captionDisplayText,
	captionLineBreaks,
	captionsAreStyled,
	captionWordState,
	effectiveCaptionStyle,
	speakerColorOf,
} from "../../../shared/caption-style.ts";
import {
	activeCaptions,
	type Caption,
	type Project,
} from "../../../shared/project.ts";
import type { ResolvedCaptionStyle } from "../../../shared/schema/defaults.ts";
import { TITLE_FONTS } from "../../../shared/text-style.ts";
import { fontChoiceCss, useProjectFontFaces } from "../imported-fonts.ts";
import type { PreviewStyle } from "./preview-style.ts";

/** Caption box CSS, sized like the burned-in ASS captions. */
export function captionBoxStyle(
	project: Pick<Project, "height" | "width">
): PreviewStyle {
	return {
		"--studio-caption-font-size": `${(Math.round(project.height * 0.045) / project.width) * 100}cqw`,
		"--studio-caption-inset": `${(40 / project.width) * 100}%`,
	};
}

/** A canvas-height fraction as a `cqw` length (the stage is a width container). */
const cqw = (fraction: number, project: Pick<Project, "height" | "width">) =>
	`${((fraction * project.height) / project.width) * 100}cqw`;

/** `#rrggbb` plus an opacity as `rgb(r g b / a)`. */
export function hexAlpha(hex: string, opacity: number): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${opacity})`;
}

/**
 * The styled caption block: anchored at (positionX, positionY) by its bottom
 * centre, like the ASS `\an2\pos` the render uses.
 */
export function styledCaptionStyle(
	style: ResolvedCaptionStyle,
	project: Pick<Project, "height" | "width">
): CSSProperties {
	const boxed = style.backgroundOpacity > 0;
	const outline = cqw(style.outlineWidth, project);
	const shadow = cqw(style.shadowDepth, project);
	const css: CSSProperties = {
		color: style.color,
		fontFamily: fontChoiceCss(style, TITLE_FONTS[style.fontFamily].css),
		fontSize: cqw(style.fontSize, project),
		fontWeight: style.fontWeight,
		left: `${style.positionX * 100}%`,
		lineHeight: 1.2,
		maxWidth: "90%",
		pointerEvents: "none",
		position: "absolute",
		textAlign: "center",
		top: `${style.positionY * 100}%`,
		transform: "translate(-50%, -100%)",
		whiteSpace: "pre-line",
		width: "max-content",
		zIndex: 20,
	};
	if (boxed) {
		css.backgroundColor = hexAlpha(
			style.backgroundColor,
			style.backgroundOpacity
		);
		css.padding = `0 ${cqw(style.fontSize * 0.15, project)}`;
	} else if (style.outlineWidth > 0) {
		// The stroke is centred on the glyph edge, so paint it under the fill.
		css.WebkitTextStroke = `calc(${outline} * 2) ${style.outlineColor}`;
		css.paintOrder = "stroke fill";
	}
	if (!boxed && style.shadowDepth > 0) {
		css.textShadow = `${shadow} ${shadow} 0 rgb(0 0 0 / 0.5)`;
	}
	return css;
}

/** Inline style for one word at `time`, mirroring the ASS word animation. */
export function captionWordStyle(
	style: ResolvedCaptionStyle,
	time: number,
	word: { end: number; start: number },
	base: string,
	highlight: string
): CSSProperties {
	const state = captionWordState(style.wordAnimation, time, word);
	const css: CSSProperties = {
		color: state.highlighted ? highlight : base,
		display: "inline-block",
		whiteSpace: "pre",
	};
	if (state.scale !== 1) {
		css.transform = `scale(${Number(state.scale.toFixed(3))})`;
	}
	if (!state.visible) {
		css.visibility = "hidden";
	}
	if (state.boxed) {
		css.backgroundColor = highlight;
		css.borderRadius = "0.15em";
		css.padding = "0 0.12em";
	}
	if (style.wordAnimation === "karaoke") {
		const fill = `${state.fill * 100}%`;
		css.backgroundImage = `linear-gradient(90deg, ${highlight} ${fill}, ${base} ${fill})`;
		css.backgroundClip = "text";
		css.WebkitBackgroundClip = "text";
		css.color = "transparent";
	}
	return css;
}

/**
 * The box behind one shown word of a boxed `reveal` caption (with the space
 * before it), padded at the start of the caption and after the newest word.
 */
export function revealWordBoxStyle(
	style: ResolvedCaptionStyle,
	project: Pick<Project, "height" | "width">,
	index: number,
	lastShown: number
): CSSProperties {
	const pad = cqw(style.fontSize * 0.15, project);
	return {
		backgroundColor: hexAlpha(style.backgroundColor, style.backgroundOpacity),
		paddingLeft: index === 0 ? pad : undefined,
		paddingRight: index === lastShown ? pad : undefined,
	};
}

/** What goes before word `index`: a line break, a space, or nothing. */
function separator(index: number, breaks: ReadonlySet<number>): ReactNode {
	if (breaks.has(index)) {
		return <br />;
	}
	return index ? " " : "";
}

function StyledCaption({
	caption,
	project,
	style,
	time,
}: {
	caption: Caption;
	project: Project;
	style: ResolvedCaptionStyle;
	time: number;
}) {
	const highlight = caption.highlightColor ?? style.highlightColor;
	const words = caption.words ?? [];
	const breaks = new Set(
		captionLineBreaks(
			words.length
				? words.map((word) => word.text)
				: caption.text.split(/\s+/).filter(Boolean),
			style,
			project
		)
	);
	const base = (speakerId: string | undefined) =>
		speakerColorOf(project, speakerId ?? caption.speakerId) ?? style.color;
	if (!words.length || style.wordAnimation === "none") {
		const text = caption.text.includes("\n")
			? caption.text
			: caption.text
					.split(/\s+/)
					.filter(Boolean)
					.map((token, index) =>
						index === 0 ? token : `${breaks.has(index) ? "\n" : " "}${token}`
					)
					.join("");
		return (
			<div
				className="studio-caption-styled"
				data-caption-id={caption.id}
				style={{
					...styledCaptionStyle(style, project),
					color: base(undefined),
				}}
			>
				{words.length
					? words.map((word, index) => (
							<span key={word.id} style={{ color: base(word.speakerId) }}>
								{separator(index, breaks)}
								{captionDisplayText(word.text, style)}
							</span>
						))
					: captionDisplayText(text, style)}
			</div>
		);
	}
	// The render hides unspoken `reveal` words with `\alpha&HFF&`, which also
	// hides their BorderStyle-3 box, so the box grows word by word: draw it per
	// word here instead of on the block.
	const revealBox =
		style.backgroundOpacity > 0 && style.wordAnimation === "reveal";
	const blockStyle = styledCaptionStyle(style, project);
	if (revealBox) {
		blockStyle.backgroundColor = undefined;
		blockStyle.padding = undefined;
	}
	const lastShown = words.findLastIndex((word) => time >= word.start);
	return (
		<div
			className="studio-caption-styled"
			data-caption-id={caption.id}
			style={blockStyle}
		>
			{words.map((word, index) => (
				<span
					data-caption-box={
						revealBox && index <= lastShown ? "true" : undefined
					}
					key={word.id}
					style={
						revealBox && index <= lastShown
							? revealWordBoxStyle(style, project, index, lastShown)
							: undefined
					}
				>
					{separator(index, breaks)}
					<span
						className="studio-caption-word"
						data-active={
							time >= word.start && time < word.end ? "true" : undefined
						}
						style={captionWordStyle(
							style,
							time,
							word,
							base(word.speakerId),
							highlight
						)}
					>
						{captionDisplayText(word.text, style)}
					</span>
				</span>
			))}
		</div>
	);
}

/** Active-track captions at `time`, with word-level highlighting. */
export function PreviewCaptions({
	project,
	time,
}: {
	project: Project;
	time: number;
}) {
	const visible = activeCaptions(project).filter(
		(c) => time >= c.start && time < c.end
	);
	const style = captionsAreStyled(project)
		? effectiveCaptionStyle(project)
		: null;
	useProjectFontFaces(style ? [style] : []);
	if (style) {
		return visible.map((caption) => (
			<StyledCaption
				caption={caption}
				key={caption.id}
				project={project}
				style={style}
				time={time}
			/>
		));
	}
	const legacyStyle = captionBoxStyle(project);
	return visible.map((c) => (
		<div className="studio-caption" key={c.id} style={legacyStyle}>
			{c.words?.length
				? c.words.map((word, index) => {
						const captionHighlightStyle: PreviewStyle = {
							"--studio-caption-highlight-color":
								c.highlightColor ?? "var(--warning)",
						};
						return (
							<span
								className="studio-caption-word"
								data-active={
									time >= word.start && time < word.end ? "true" : undefined
								}
								key={word.id}
								style={captionHighlightStyle}
							>
								{index ? " " : ""}
								{word.text}
							</span>
						);
					})
				: c.text}
		</div>
	));
}
