import type { Project } from "../../shared/project.ts";
import {
	captionDialogue,
	captionStyleLine,
} from "./render-stages/ass-captions.ts";
import { titleEvents, titleStyles } from "./render-stages/ass-titles.ts";

/**
 * The ASS script burned in by the `subtitles` filter: the script header, the
 * caption style plus any title styles, the caption events, then the title events.
 */
export function assCaptions(p: Project): string {
	const styles = [captionStyleLine(p), ...titleStyles(p)].join("\n");
	const captions = captionDialogue(p).join("\n");
	const titles = p.titles.flatMap((title) => titleEvents(title, p)).join("\n");
	return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${p.width}\nPlayResY: ${p.height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${captions}\n${titles}\n`;
}
