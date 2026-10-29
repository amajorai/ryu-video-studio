import { SOUNDTRACK_STYLES } from "../../../../shared/soundtrack.ts";
import {
	planSoundtrack,
	soundtrackPlanInput,
} from "../../../../shared/soundtrack-plan.ts";
import {
	createSoundtrack,
	placeAtRange,
	soundtrackBody,
} from "../../SoundtrackPanel.tsx";
import { clock } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";

/** Shortest range the range actions accept, in seconds. */
const MIN_RANGE = 0.04;
/** Shortest range a soundtrack can be scored for. */
const MIN_SCORE_RANGE = 0.5;

/** The marked range, or null with a status line when none is usable. */
function usableRange(
	runtime: Pick<EditorRuntime, "range" | "rangeMarked" | "setStatus">,
	minimum = MIN_RANGE
) {
	const { end, start } = runtime.range;
	if (!runtime.rangeMarked || end - start < minimum) {
		runtime.setStatus(
			minimum > MIN_RANGE
				? `Mark a range of at least ${minimum} seconds first (I and O, or Shift+drag on the ruler).`
				: "Mark a range first (I and O, or Shift+drag on the ruler)."
		);
		return null;
	}
	return { end, start };
}

/**
 * Open the export panel with "Only the marked range" on, optionally also
 * "Save to media library", so the viewer can review the settings and render.
 */
export function openRangeExport(
	runtime: Pick<
		EditorRuntime,
		"range" | "rangeMarked" | "setPanel" | "setStatus" | "store"
	>,
	options: { saveAsAsset?: boolean } = {}
) {
	const range = usableRange(runtime);
	if (!range) {
		return;
	}
	runtime.store.setState({
		exportPreset: {
			rangeOnly: true,
			saveAsAsset: options.saveAsAsset === true,
		},
	});
	runtime.setPanel("exports");
	runtime.setStatus(
		options.saveAsAsset
			? `Export ${clock(range.start)}–${clock(range.end)} to the media library: review the settings, then render.`
			: `Export ${clock(range.start)}–${clock(range.end)}: review the settings, then render.`
	);
}

/**
 * Score the marked range: plan with Ryu's model when it is available (the
 * plan covers only the range), otherwise use the cinematic style, then
 * create the soundtrack and place it at the range start on a free audio
 * track as one undo step.
 */
export function scoreRange(runtime: EditorRuntime) {
	const range = usableRange(runtime, MIN_SCORE_RANGE);
	const { project } = runtime;
	if (!(range && project)) {
		return;
	}
	return runtime.act(async () => {
		const complete = window.ryu?.model?.complete;
		const duration = range.end - range.start;
		runtime.setStatus(
			complete
				? `Planning music for ${clock(range.start)}–${clock(range.end)} with Ryu…`
				: `Creating music for ${clock(range.start)}–${clock(range.end)}…`
		);
		const style = SOUNDTRACK_STYLES.cinematic;
		const planned = complete
			? await planSoundtrack(
					soundtrackPlanInput(project, runtime.assets, range),
					complete
				)
			: undefined;
		const asset = await createSoundtrack(
			soundtrackBody({
				bpm: planned?.bpm ?? style.bpm,
				downbeatOffset: planned?.downbeatOffset,
				duration,
				layers: planned?.layers,
				mood: planned?.style ?? "cinematic",
				sections: planned?.sections ?? [],
			}),
			{
				onBackground: () =>
					runtime.setStatus(
						"Composing the range's music in the background on the node…"
					),
			}
		);
		runtime.setAssets((current) => [asset, ...current]);
		runtime.latestEdit(
			(current) => placeAtRange(current, runtime.assets, asset, range),
			() => `Score ${clock(range.start)}–${clock(range.end)}`
		);
		runtime.setStatus(
			`Scored ${clock(range.start)}–${clock(range.end)} and placed the music at the range start.`
		);
	});
}
