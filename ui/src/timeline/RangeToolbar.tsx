import { Button } from "@ryu/blocks/companion/controls";
import {
	agentHandoffAvailable,
	requestAgentHandoff,
} from "../editor/actions/ai.ts";
import { clearRange } from "../editor/actions/navigation.ts";
import { openRangeExport, scoreRange } from "../editor/actions/range.ts";
import { deleteRange } from "../editor/actions/ripple.ts";
import { useEditorProject } from "../editor/context.tsx";
import { NumberField } from "../NumberField.tsx";

/** Shortest range the ripple delete accepts, in seconds. */
const MIN_RANGE = 0.04;
/** Shortest range a soundtrack is scored for. */
const MIN_SCORE_RANGE = 0.5;

/**
 * I/O range fields and range actions: ripple delete, clear (Alt+X), export
 * or save the range to the library, ask the agent about it, and score it.
 * The range itself is drawn on the timeline (`TimelineRange`).
 */
export function RangeToolbar() {
	const runtime = useEditorProject();
	const { busy, duration, range, rangeMarked } = runtime;
	const length = range.end - range.start;
	const noRange = !rangeMarked || duration < MIN_RANGE || length < MIN_RANGE;
	return (
		<div className="studio-range-toolbar flex-wrap">
			<strong>Range edit</strong>
			<NumberField
				label="Range start"
				max={Math.max(duration, MIN_RANGE)}
				min={0}
				onChange={(start) => {
					runtime.setRangeStart(start);
					runtime.setRangeMarked(true);
				}}
				value={range.start}
			/>
			<NumberField
				label="Range end"
				max={Math.max(duration, MIN_RANGE)}
				min={0}
				onChange={(end) => {
					runtime.setRangeEnd(end);
					runtime.setRangeMarked(true);
				}}
				value={range.end}
			/>
			<Button
				disabled={
					busy || duration < MIN_RANGE || range.end - range.start < MIN_RANGE
				}
				onClick={() => deleteRange(runtime)}
				size="sm"
				variant="outline"
			>
				Ripple delete range
			</Button>
			<Button
				disabled={busy || !rangeMarked}
				onClick={() => clearRange(runtime)}
				size="sm"
				title="Clear range (Alt+X)"
				variant="ghost"
			>
				Clear range
			</Button>
			<Button
				disabled={busy || noRange}
				onClick={() => openRangeExport(runtime)}
				size="sm"
				variant="ghost"
			>
				Export range
			</Button>
			<Button
				disabled={busy || noRange}
				onClick={() => openRangeExport(runtime, { saveAsAsset: true })}
				size="sm"
				variant="ghost"
			>
				Save range to library
			</Button>
			<Button
				disabled={busy || noRange || !agentHandoffAvailable()}
				onClick={() => {
					if (!requestAgentHandoff(runtime)) {
						runtime.setStatus("Ask agent is not available on this surface.");
					}
				}}
				size="sm"
				title={
					agentHandoffAvailable()
						? "Ask the agent about this range"
						: "Ask agent is not available on this surface"
				}
				variant="ghost"
			>
				Ask agent
			</Button>
			<Button
				disabled={busy || noRange || length < MIN_SCORE_RANGE}
				onClick={() => void scoreRange(runtime)}
				size="sm"
				title="Create music for the range and place it at the range start"
				variant="ghost"
			>
				Score this range
			</Button>
			<small>
				Shift+drag the ruler to mark a range; drag its edges to adjust it.
			</small>
		</div>
	);
}
