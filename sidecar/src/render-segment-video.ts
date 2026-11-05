import { ffmpegFrameRate } from "../../shared/frame-rate.ts";
import type { Project, Segment } from "../../shared/project.ts";
import {
	clipSpeedAt,
	hasSpeedCurve,
	speedCurveSetpts,
} from "../../shared/speed-curve.ts";
import { compositeLayer } from "./render-composite.ts";
import { clipBackgroundFilters } from "./render-stages/background.ts";
import { advancedColorFilters } from "./render-stages/color-advanced.ts";
import { basicColorFilters } from "./render-stages/color-basic.ts";
import { cropFilters } from "./render-stages/crop.ts";
import { edgeFilters } from "./render-stages/edges.ts";
import { segmentEffectFilters } from "./render-stages/effects.ts";
import { flipFilters } from "./render-stages/flip.ts";
import { keyFilters } from "./render-stages/key.ts";
import { maskStage } from "./render-stages/mask.ts";
import { opacityFilter } from "./render-stages/opacity.ts";
import {
	overlayPosition,
	padFilter,
	rotateFilter,
	scaleFilters,
} from "./render-stages/transform.ts";
import {
	entryOffset,
	entryScale,
	fadeFilters,
	revealFilters,
} from "./render-stages/transitions.ts";
import type { ExtraInput, RenderStageContext } from "./render-stages/types.ts";

/**
 * The video chain of one clip and its placement on the composite.
 *
 * Stage order (fixed; features rewrite their stage file, not this order):
 *
 * 1. source timing (`setpts`, or a speed curve's remap, then `fps` for
 *    exports of real video)
 * 2. key → crop → flip → basic color → advanced color → effects
 * 3. mask (may split the chain into its own statements)
 * 4. rotate → `format=rgba` → scale (`scaledSize`) → pad → opacity → edges
 * 5. fades → reveal → `setpts` to the clip start (`fps` again for waveforms)
 * 6. clip background → `compositeLayer`
 *
 * Adjustment layers run in the orchestrator after each track
 * (`adjustmentAfterTrack`). Every stage returns whole filters, so a stage that
 * returns none leaves the chain byte-identical.
 */

export interface SegmentVideoInput {
	/** Label of the composite so far, without brackets. */
	base: string;
	context: RenderStageContext;
	/** Set for single-frame renders; exports leave it undefined. */
	frameTime?: number;
	length: number;
	/** One-based segment number, matching its FFmpeg input index. */
	n: number;
	p: Project;
	/** The previous clip on the same track, in start order. */
	previous?: Segment;
	s: Segment;
	/** Whether the clip is a waveform rendered from `[waveVideo<n>]`. */
	visualize: boolean;
}

export interface SegmentVideoOutput {
	filters: string[];
	/** Extra FFmpeg inputs the stages read, in order. */
	inputs: ExtraInput[];
	/** Label of the composite after this clip, without brackets. */
	last: string;
}

function sourceTiming({ frameTime, n, p, s, visualize }: SegmentVideoInput): {
	chain: string[];
	input: string;
} {
	const offset =
		frameTime === undefined ? "" : `+${Math.max(0, frameTime - s.start)}/TB`;
	if (visualize) {
		return {
			chain: [
				"settb=AVTB",
				`setpts=(N-1)/(${ffmpegFrameRate(p.fps)}*TB)${offset}`,
			],
			input: `waveVideo${n}`,
		};
	}
	if (hasSpeedCurve(s)) {
		// A speed curve remaps every frame along the curve; a single frame only
		// needs the curve's speed at that moment.
		return {
			chain:
				frameTime === undefined
					? [speedCurveSetpts(s), `fps=${ffmpegFrameRate(p.fps)}`]
					: [
							`setpts=(PTS-STARTPTS)/${clipSpeedAt(s, frameTime - s.start)}${offset}`,
						],
			input: `${n}:v`,
		};
	}
	return {
		chain: [
			`setpts=(PTS-STARTPTS)/${s.speed}${offset}`,
			...(frameTime === undefined ? [`fps=${ffmpegFrameRate(p.fps)}`] : []),
		],
		input: `${n}:v`,
	};
}

export function segmentVideoFilters(
	input: SegmentVideoInput
): SegmentVideoOutput {
	const { base, context, frameTime, length, n, p, previous, s, visualize } =
		input;
	const filters: string[] = [];
	const timing = sourceTiming(input);
	const sourceChain = [
		...timing.chain,
		...keyFilters(s),
		...cropFilters(s),
		...flipFilters(s),
		...basicColorFilters(s),
		...advancedColorFilters(s, context),
		...segmentEffectFilters(s),
	];
	const maskInput = `mask${n}in`;
	const mask = maskStage(s, { ...context, input: maskInput, n });
	const masked = mask.filters.length > 0 || mask.label !== maskInput;
	const placementChain = [
		rotateFilter(s),
		"format=rgba",
		...scaleFilters(s, p, entryScale(s)),
		padFilter(s, p),
		opacityFilter(s),
		...edgeFilters(s),
		...fadeFilters(s, length),
		...revealFilters(s, previous, length),
		`setpts=PTS+${s.start}/TB`,
		...(visualize && frameTime === undefined
			? [`fps=${ffmpegFrameRate(p.fps)}`]
			: []),
	];
	if (masked) {
		filters.push(`[${timing.input}]${sourceChain.join(",")}[${maskInput}]`);
		filters.push(...mask.filters);
		filters.push(`[${mask.label}]${placementChain.join(",")}[v${n}]`);
	} else {
		filters.push(
			`[${timing.input}]${[...sourceChain, ...placementChain].join(",")}[v${n}]`
		);
	}
	const background = clipBackgroundFilters(s, p, `v${n}`, context);
	filters.push(...background.filters);
	const position = overlayPosition(s, (axis) => entryOffset(s, axis));
	const out = `out${n}`;
	filters.push(
		...compositeLayer({
			base,
			enable: `between(t,${s.start},${s.start + length})`,
			layer: background.label,
			out,
			s,
			x: position.x,
			y: position.y,
		})
	);
	return { filters, inputs: mask.inputs, last: out };
}
