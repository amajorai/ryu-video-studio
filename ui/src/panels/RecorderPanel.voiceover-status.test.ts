import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { voiceoverStatus } from "./RecorderPanel.tsx";

// A failed stop keeps the take recording and splices the recorder's error into
// a translated sentence; the error is an English literal from voiceover.ts and
// must be translated too, or a German user reads half a sentence in English.
const STOP_FAILED = "The recording did not stop cleanly.";
const DE: Record<string, string> = {
	[STOP_FAILED]: "Die Aufnahme wurde nicht sauber beendet.",
	"{error} The take is still recording; stop it when ready.":
		"{error} Die Aufnahme läuft noch; beende sie, wenn du so weit bist.",
};
const german: LiteralMessage = (source, values = {}) =>
	formatMessage(DE[source] ?? source, values, "de");

test("a recording-phase error reads as one German status", () => {
	expect(
		voiceoverStatus(
			{ error: STOP_FAILED, id: "take-1", phase: "recording", startedAt: 0 },
			german
		)
	).toBe(
		"Die Aufnahme wurde nicht sauber beendet. Die Aufnahme läuft noch; beende sie, wenn du so weit bist."
	);
});

test("host text without a catalog entry is kept as sent", () => {
	expect(
		voiceoverStatus(
			{ error: "rpc timeout", id: "take-1", phase: "recording", startedAt: 0 },
			german
		)
	).toBe(
		"rpc timeout Die Aufnahme läuft noch; beende sie, wenn du so weit bist."
	);
});

test("a clean recording has no status line", () => {
	expect(
		voiceoverStatus({ id: "take-1", phase: "recording", startedAt: 0 }, german)
	).toBeNull();
});
