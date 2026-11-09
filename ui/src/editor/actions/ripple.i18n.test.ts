// Ripple edits name their undo step through the caller's translator, so the
// History panel and the "Jumped to" notice read in the editor's language.
import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { newProject, newSegment } from "../../../../shared/project.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import { deleteRange, rippleDeleteGapAt } from "./ripple.ts";

const GERMAN: Record<string, string> = {
	"Closed a {duration} gap on track {trackNumber}.":
		"Lücke von {duration} auf Spur {trackNumber} geschlossen.",
	"Ripple delete gap": "Lücke löschen und nachrücken",
	"Ripple delete range": "Bereich löschen und nachrücken",
	"Ripple-deleted {duration} from the timeline.":
		"{duration} aus der Zeitleiste gelöscht.",
};

const germanMessages: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values, "de");

function gapRuntime() {
	const video = testVideo("clip.mp4", 30);
	const first = { ...newSegment(video, 0, 0), sourceOut: 2 };
	const second = { ...newSegment(video, 5, 0), sourceOut: 2 };
	return createTestRuntime(
		{ ...newProject("Gap"), segments: [first, second] },
		[video]
	);
}

const lastLabel = (runtime: ReturnType<typeof gapRuntime>) =>
	runtime.store.getState().history.past.at(-1)?.label;

describe("ripple undo labels", () => {
	test("ripple delete gap records the translated label", () => {
		const runtime = gapRuntime();
		rippleDeleteGapAt(runtime, 0, 3, germanMessages);
		expect(lastLabel(runtime)).toBe("Lücke löschen und nachrücken");
		expect(lastStatus(runtime)).toBe(
			"Lücke von 0:03.0 auf Spur 1 geschlossen."
		);
	});

	test("range ripple records the translated label", () => {
		const runtime = gapRuntime();
		runtime.setRangeStart(0);
		runtime.setRangeEnd(1);
		runtime.refresh();
		deleteRange(runtime, germanMessages);
		expect(lastLabel(runtime)).toBe("Bereich löschen und nachrücken");
	});

	test("without a provider the labels stay English", () => {
		const runtime = gapRuntime();
		rippleDeleteGapAt(runtime, 0, 3);
		expect(lastLabel(runtime)).toBe("Ripple delete gap");
	});
});
