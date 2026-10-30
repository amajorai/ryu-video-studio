/**
 * Contracts shared by the render stage stubs. Each stage is a pure function so a
 * single feature item can rewrite its own file without touching the orchestrator
 * (`render.ts`) or the fixed per-segment order in `render-segment-video.ts`.
 */

/** FFmpeg input arguments for one extra input, ending with `-i <path>`. */
export interface ExtraInput {
	args: string[];
}

/** Filtergraph statements a stage adds, plus the label that carries its output. */
export interface StageOutput {
	filters: string[];
	label: string;
}

/** Filtergraph statements plus any extra FFmpeg inputs they read. */
export interface StageOutputWithInputs extends StageOutput {
	inputs: ExtraInput[];
}

/** Paths the orchestrator resolves on behalf of the stages. */
export interface RenderStageContext {
	/** Absolute FFmpeg input index of the `offset`-th extra input this stage returns. */
	inputIndex(offset: number): number;
	/** Local file path of an imported LUT (W2-V5). */
	lutPath(lutId: string): string;
	/** Local media path of a library asset. */
	mediaPath(assetId: string): string;
	/**
	 * Set for alpha exports, whose canvas is transparent: the project canvas
	 * background (including the blur fill drawn per base-track clip) is not
	 * drawn. A clip's own background still is.
	 */
	transparentCanvas?: boolean;
}
