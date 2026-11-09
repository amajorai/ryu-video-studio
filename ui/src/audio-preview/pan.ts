/**
 * Preview pan and channel-mode insert. Sits after the effects insert and
 * before the clip gain. The input is shaped to two channels (a mono source is
 * copied to both sides), split, routed through a 2×2 gain matrix that matches
 * the render's `pan` filter (`panMatrix`), and merged back to stereo.
 * Keyframed balance previews at the clip's base value; the render animates it.
 * The track mixer's balance follows as a stereo gain on each output row,
 * like the render's per-track `pan=stereo` stage after the clip's own pan.
 */
import { panGains, panMatrix } from "../../../shared/audio.ts";
import type { Segment } from "../../../shared/project.ts";
import type { PreviewAudioInsert } from "./effects.ts";

export interface PreviewPanInsert extends PreviewAudioInsert {
	/** The clip's track balance (-1..1); applied on the next `update`. */
	setTrackPan(pan: number): void;
}

/**
 * The clip pan matrix followed by the track balance: row `output` of the
 * clip matrix scaled by the track's left or right gain.
 */
export function previewPanMatrix(
	segment: Pick<Segment, "channelMode" | "pan">,
	trackPan = 0
): number[][] {
	const matrix = panMatrix(segment.channelMode ?? "stereo", segment.pan ?? 0);
	if (!trackPan) {
		return matrix.map((row) => [...row]);
	}
	const { left, right } = panGains(trackPan);
	return matrix.map((row, output) =>
		row.map((value) => value * (output === 0 ? left : right))
	);
}

export function createPreviewPanInsert(
	audio: BaseAudioContext
): PreviewPanInsert {
	let trackPan = 0;
	const shaper = audio.createGain();
	shaper.channelCount = 2;
	shaper.channelCountMode = "explicit";
	shaper.channelInterpretation = "speakers";
	const splitter = audio.createChannelSplitter(2);
	const merger = audio.createChannelMerger(2);
	// routes[output][input]
	const routes = [0, 1].map((output) =>
		[0, 1].map((inputChannel) => {
			const gain = audio.createGain();
			gain.gain.value = output === inputChannel ? 1 : 0;
			splitter.connect(gain, inputChannel);
			gain.connect(merger, 0, output);
			return gain;
		})
	);
	shaper.connect(splitter);
	return {
		connect(node) {
			node.connect(shaper);
			return merger;
		},
		dispose() {
			// The upstream owner disconnects its own output; a targeted
			// `input.disconnect(shaper)` would throw once it has (InvalidAccessError).
			for (const node of [shaper, splitter, merger, ...routes.flat()]) {
				node.disconnect();
			}
		},
		setTrackPan(pan: number) {
			trackPan = Number.isFinite(pan) ? pan : 0;
		},
		update(segment: Segment) {
			const matrix = previewPanMatrix(segment, trackPan);
			for (const [output, row] of matrix.entries()) {
				for (const [inputChannel, value] of row.entries()) {
					const gain = routes[output]?.[inputChannel];
					if (gain && gain.gain.value !== value) {
						gain.gain.value = value;
					}
				}
			}
		},
	};
}
