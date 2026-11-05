import type { LiteralMessage } from "@ryu/i18n/react";
import { formatDb, gainToDb } from "../../../shared/decibels.ts";
import { clock } from "../editor/format.ts";

/**
 * The tooltip of one volume keyframe ("-6.0 dB at 0:02.0") as one whole
 * message, so the connector and word order follow the UI language.
 */
export function volumePointTitle(
	tl: LiteralMessage,
	frame: { time: number; value: number }
): string {
	return tl("{level} at {time}", {
		level: formatDb(gainToDb(frame.value)),
		time: clock(frame.time),
	});
}
