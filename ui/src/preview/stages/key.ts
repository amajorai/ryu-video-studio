/**
 * Preview stage: chroma/luma keying. Mirrors
 * `sidecar/src/render-stages/key.ts`. The key itself runs as a WebGL pass
 * (`../gl/passes/key.ts`, active only when `segment.key` is set); CSS cannot
 * key pixels, so this stage contributes no CSS for keyed or unkeyed clips.
 * When WebGL2 is unavailable the media layer reports it and shows the clip
 * unkeyed; exports still key through FFmpeg.
 */
import type { Segment } from "../../../../shared/project.ts";
import type { PreviewStyle } from "../preview-style.ts";

export function keyStyle(_segment: Segment, _elapsed: number): PreviewStyle {
	return {};
}
