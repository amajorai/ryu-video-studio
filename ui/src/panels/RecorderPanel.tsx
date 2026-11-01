import { RyuAppField, RyuAppSection } from "@ryu/blocks/companion/app-ui";
import { Button, Switch } from "@ryu/blocks/companion/controls";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import {
	addRecordingToTimeline,
	defaultRecordingImport,
	type RecordedMedia,
	type RecordingImportDependencies,
	recordingName,
} from "../recording/import.ts";
import {
	CAPTURE_LABELS,
	type CaptureRecorder,
	type CaptureSource,
	type CaptureState,
	sharedCaptureRecorder,
} from "../recording/screen.ts";
import {
	COUNT_IN_SECONDS,
	elapsedSeconds,
	prerollPlan,
	type VoiceoverDependencies,
	VoiceoverRecorder,
	type VoiceoverState,
} from "../recording/voiceover.ts";
import type { PanelTab } from "./types.ts";

/** The recorder has its own library tab. */
export const recorderPanelTab: PanelTab | null = {
	label: "Record",
	value: "record",
};

const PREROLL_KEY = "recorder.preroll";

export interface RecorderPanelDependencies {
	capture?: CaptureRecorder;
	importer?: RecordingImportDependencies;
	now?: () => number;
	voiceover?: Partial<VoiceoverDependencies>;
}

type PlacementRuntime = Parameters<typeof addRecordingToTimeline>[0];

/** Import a take and place it at `time`; resolves with the status line. */
async function placeTake(
	runtime: PlacementRuntime,
	media: RecordedMedia,
	time: number,
	label: string,
	importer: RecordingImportDependencies
): Promise<string> {
	const placed = await addRecordingToTimeline(runtime, media, time, importer);
	if (placed.placementError) {
		return placed.placementError;
	}
	const added = `${label} added at ${clock(time)}.`;
	return placed.warning ? `${added} ${placed.warning}` : added;
}

/** Big 3-2-1 count-in drawn over the preview frame (or the window without one). */
function CountInOverlay({ remaining }: { remaining: number }) {
	const [target] = useState(() =>
		document.querySelector<HTMLElement>(".studio-preview-frame")
	);
	const overlay = (
		<div
			className={`pointer-events-none inset-0 z-[90] flex items-center justify-center bg-black/40 ${target ? "absolute" : "fixed"}`}
			data-recorder-count-in=""
		>
			<span className="font-semibold text-7xl text-white tabular-nums drop-shadow-lg">
				{remaining}
			</span>
		</div>
	);
	return createPortal(overlay, target ?? document.body);
}

function useNow(active: boolean, now: () => number) {
	const [value, setValue] = useState(now);
	useEffect(() => {
		if (!active) {
			return;
		}
		setValue(now());
		const timer = setInterval(() => setValue(now()), 250);
		return () => clearInterval(timer);
	}, [active, now]);
	return value;
}

function voiceoverStatus(
	state: VoiceoverState,
	tl: LiteralMessage
): string | null {
	switch (state.phase) {
		case "checking":
			return "Checking the microphone…";
		case "unavailable":
			return state.message;
		case "idle":
			return state.error ?? state.notice ?? null;
		case "recording":
			return state.error
				? tl("{error} The take is still recording; stop it when ready.", {
						error: state.error,
					})
				: null;
		case "stopping":
			return "Finishing the take…";
		case "importing":
			return "Adding the voiceover to the timeline…";
		case "pending":
			return (
				state.error ??
				"A recorded take is waiting. Add it at the playhead or discard it."
			);
		default:
			return null;
	}
}

function VoiceoverSection({
	dependencies,
	importer,
	now,
	runtime,
}: {
	dependencies?: Partial<VoiceoverDependencies>;
	importer: RecordingImportDependencies;
	now: () => number;
	runtime: EditorRuntime;
}) {
	const tl = useLiteralMessages();
	const [recorder] = useState(
		() => new VoiceoverRecorder({ now, ...dependencies })
	);
	const state = useSyncExternalStore(
		recorder.subscribe,
		recorder.getState,
		recorder.getState
	);
	const [preroll, setPreroll] = useState(() =>
		readViewerValue(PREROLL_KEY, z.boolean(), false)
	);
	const anchor = useRef<number | null>(null);
	const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const recording = state.phase === "recording";
	const clockNow = useNow(recording, now);

	useEffect(() => {
		recorder.refresh().catch(() => undefined);
		return () => {
			recorder.cancel();
			if (playTimer.current) {
				clearTimeout(playTimer.current);
			}
		};
	}, [recorder]);

	// The host may stop a long take on its own; poll so the panel notices.
	useEffect(() => {
		if (!recording) {
			return;
		}
		const timer = setInterval(() => {
			recorder.refresh().catch(() => undefined);
		}, 2000);
		return () => clearInterval(timer);
	}, [recorder, recording]);

	const stopPlayback = () => {
		if (playTimer.current) {
			clearTimeout(playTimer.current);
			playTimer.current = null;
		}
		if (preroll) {
			runtime.setPlaying(false);
		}
	};

	const commit = async () => {
		const time = anchor.current ?? runtime.time;
		const ok = await recorder.commit(
			(media) => placeTake(runtime, media, time, "Voiceover", importer),
			recordingName("Voiceover", new Date(now()))
		);
		if (ok) {
			anchor.current = null;
		}
	};

	const start = async () => {
		const time = runtime.time;
		anchor.current = time;
		if (preroll) {
			const plan = prerollPlan(time);
			runtime.setPlaying(false);
			runtime.setTime(plan.startTime);
			playTimer.current = setTimeout(() => {
				playTimer.current = null;
				runtime.setPlaying(true);
			}, plan.delayMs);
		}
		const started = await recorder.start(COUNT_IN_SECONDS);
		if (!started) {
			stopPlayback();
			if (preroll) {
				runtime.setTime(time);
			}
		}
	};

	const stop = async () => {
		await recorder.stop();
		stopPlayback();
		if (recorder.getState().phase === "pending") {
			await commit();
		}
	};

	const status = voiceoverStatus(state, tl);
	return (
		<RyuAppSection title="Voiceover">
			{state.phase === "counting" && (
				<CountInOverlay remaining={state.remaining} />
			)}
			<p aria-live="polite" className="text-muted-foreground text-xs">
				{state.phase === "counting"
					? tl("Recording in {remaining}…", { remaining: state.remaining })
					: recording
						? tl("Recording {elapsed}", {
								elapsed: clock(elapsedSeconds(state, clockNow)),
							})
						: status}
			</p>
			<div className="flex flex-wrap gap-2">
				{state.phase === "idle" && (
					<Button onClick={() => start()} size="sm">
						Record voiceover
					</Button>
				)}
				{state.phase === "counting" && (
					<Button
						onClick={() => {
							recorder.cancel();
						}}
						size="sm"
						variant="outline"
					>
						Cancel
					</Button>
				)}
				{recording && (
					<Button onClick={() => stop()} size="sm" variant="destructive">
						Stop and add
					</Button>
				)}
				{state.phase === "pending" && (
					<>
						<Button onClick={() => commit()} size="sm">
							{anchor.current === null
								? "Add at playhead"
								: tl("Add at {time}", { time: clock(anchor.current) })}
						</Button>
						<Button
							onClick={() => recorder.discard()}
							size="sm"
							variant="ghost"
						>
							Discard
						</Button>
					</>
				)}
			</div>
			{state.phase !== "unavailable" && (
				<RyuAppField label="Play the timeline while recording">
					<Switch
						aria-label="Play the timeline while recording"
						checked={preroll}
						disabled={state.phase !== "idle"}
						onCheckedChange={(checked) => {
							setPreroll(checked);
							writeViewerValue(PREROLL_KEY, checked);
						}}
					/>
					<small>
						{tl(
							"Starts playback {countIn} s before the playhead so you hear the lead-in. Use headphones so the mix is not recorded.",
							{ countIn: COUNT_IN_SECONDS }
						)}
					</small>
				</RyuAppField>
			)}
			<small className="text-muted-foreground">
				{tl(
					"After a {countIn}-2-1 count-in, the take is recorded through Ryu and placed at the playhead on a free audio track.",
					{ countIn: COUNT_IN_SECONDS }
				)}
			</small>
		</RyuAppSection>
	);
}

function captureStatus(state: CaptureState, tl: LiteralMessage): string | null {
	switch (state.phase) {
		case "idle":
			return state.error ?? state.notice ?? null;
		case "requesting":
			return state.source === "screen"
				? tl("Waiting for a screen to share…")
				: tl("Waiting for the camera…");
		case "stopping":
			return "Finishing the recording…";
		case "importing":
			return state.source === "screen"
				? tl("Adding the screen recording to the timeline…")
				: tl("Adding the camera recording to the timeline…");
		case "ready":
			return (
				state.error ??
				"A recording is ready. Add it at the playhead or discard it."
			);
		default:
			return null;
	}
}

function CaptureSection({
	capture,
	importer,
	now,
	runtime,
}: {
	capture: CaptureRecorder;
	importer: RecordingImportDependencies;
	now: () => number;
	runtime: EditorRuntime;
}) {
	const tl = useLiteralMessages();
	const state = useSyncExternalStore(
		capture.subscribe,
		capture.getState,
		capture.getState
	);
	const [support] = useState(() => capture.support());
	const recording = state.phase === "recording";
	const clockNow = useNow(recording, now);

	const commit = (time: number) =>
		capture.commit((blob, source) =>
			placeTake(
				runtime,
				{
					blob,
					mimeType: blob.type || "video/webm",
					name: recordingName(CAPTURE_LABELS[source], new Date(now())),
				},
				time,
				CAPTURE_LABELS[source],
				importer
			)
		);

	const start = (source: CaptureSource) => {
		capture.start(source).catch(() => undefined);
	};

	const stop = async () => {
		const time = runtime.time;
		await capture.stop();
		await commit(time);
	};

	const sources: readonly CaptureSource[] = ["screen", "camera"];
	const anyAvailable = sources.some((source) => support[source].available);
	const status = captureStatus(state, tl);
	return (
		<RyuAppSection title="Screen and camera">
			{anyAvailable ? (
				<>
					<p aria-live="polite" className="text-muted-foreground text-xs">
						{recording
							? `${CAPTURE_LABELS[state.source]} ${clock(Math.max(0, (clockNow - state.startedAt) / 1000))}`
							: status}
					</p>
					<div className="flex flex-wrap gap-2">
						{state.phase === "idle" &&
							sources.map((source) => (
								<Button
									disabled={!support[source].available}
									key={source}
									onClick={() => start(source)}
									size="sm"
									title={support[source].reason}
									variant="outline"
								>
									{source === "screen" ? "Record screen" : "Record camera"}
								</Button>
							))}
						{recording && (
							<Button onClick={() => stop()} size="sm" variant="destructive">
								Stop and add
							</Button>
						)}
						{state.phase === "ready" && (
							<>
								<Button onClick={() => commit(runtime.time)} size="sm">
									Add at playhead
								</Button>
								<Button
									onClick={() => capture.discard()}
									size="sm"
									variant="ghost"
								>
									Discard
								</Button>
							</>
						)}
					</div>
					{sources.map((source) =>
						support[source].available ? null : (
							<small className="text-muted-foreground" key={source}>
								{support[source].reason}
							</small>
						)
					)}
				</>
			) : (
				<p className="text-muted-foreground text-xs">
					Ryu has not granted Video Studio screen or camera capture in this
					view. Record with another app and import the file from Media.
				</p>
			)}
		</RyuAppSection>
	);
}

/**
 * Voiceover, screen, and camera recorder. Voiceovers use the host
 * microphone bridge with a count-in; screen and camera capture are offered
 * only where the webview exposes them. Every take is imported into the
 * library and placed at the playhead.
 */
export function RecorderPanel({
	dependencies,
}: {
	/** Bridge, capture, and import overrides (tests). */
	dependencies?: RecorderPanelDependencies;
} = {}) {
	const runtime = useEditorProject();
	const [capture] = useState(
		() => dependencies?.capture ?? sharedCaptureRecorder()
	);
	const importer = dependencies?.importer ?? defaultRecordingImport;
	const now = dependencies?.now ?? Date.now;
	return (
		<>
			<VoiceoverSection
				dependencies={dependencies?.voiceover}
				importer={importer}
				now={now}
				runtime={runtime}
			/>
			<CaptureSection
				capture={capture}
				importer={importer}
				now={now}
				runtime={runtime}
			/>
		</>
	);
}
