import { describe, expect, test } from "bun:test";
import type {
	MediaRecordingInput,
	MediaRecordingResult,
} from "@ryu/app-host/media-recording";
import type { Asset } from "../../../shared/project.ts";
import { createTestRuntime, testProject } from "../editor/test-runtime.ts";
import { addRecordingToTimeline, type RecordedMedia } from "./import.ts";
import {
	COUNT_IN_SECONDS,
	elapsedSeconds,
	hostRecordingBridge,
	prerollPlan,
	UNAVAILABLE_MESSAGE,
	VoiceoverRecorder,
	type VoiceoverState,
	voiceoverTransition,
} from "./voiceover.ts";

const WAV = `data:audio/wav;base64,${btoa("RIFF....WAVEfmt ")}`;

/** A host `media.recording` double with the host's status semantics. */
function mockHost(options: { available?: boolean; startFails?: string } = {}) {
	const calls: MediaRecordingInput[] = [];
	let state: MediaRecordingResult["state"] = "idle";
	const id = "take-1";
	const available = options.available ?? true;
	const status = (): MediaRecordingResult => ({
		available,
		background: false,
		state,
		...(state === "idle"
			? {}
			: {
					durationMs: 2500,
					id,
					startedAt: "2026-10-14T10:00:00.000Z",
				}),
	});
	const bridge = (input: MediaRecordingInput) => {
		calls.push(input);
		switch (input.action) {
			case "start":
				if (options.startFails) {
					return Promise.reject(new Error(options.startFails));
				}
				if (available) {
					state = "recording";
				}
				return Promise.resolve(status());
			case "stop":
				state = "pending";
				return Promise.resolve(status());
			case "read":
				return Promise.resolve({
					...status(),
					audio: WAV,
					filename: "recording.wav",
				});
			case "discard":
				state = "idle";
				return Promise.resolve(status());
			default:
				return Promise.resolve(status());
		}
	};
	return {
		bridge,
		calls,
		setState: (next: MediaRecordingResult["state"]) => {
			state = next;
		},
	};
}

const instantWait = (_ms: number, signal: AbortSignal) =>
	signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();

describe("voiceoverTransition", () => {
	const recording: VoiceoverState = {
		id: "a",
		phase: "recording",
		startedAt: 0,
	};

	test("maps host status replies to phases", () => {
		const now = Date.parse("2026-10-14T10:00:05.000Z");
		expect(
			voiceoverTransition(
				{ phase: "checking" },
				{
					now,
					result: { available: false, state: "idle" },
					type: "status",
				}
			)
		).toEqual({ message: UNAVAILABLE_MESSAGE, phase: "unavailable" });
		expect(
			voiceoverTransition(
				{ phase: "checking" },
				{
					now,
					result: {
						available: true,
						id: "a",
						startedAt: "2026-10-14T10:00:00.000Z",
						state: "recording",
					},
					type: "status",
				}
			)
		).toEqual({ id: "a", phase: "recording", startedAt: now - 5000 });
		expect(
			voiceoverTransition(recording, {
				now,
				result: { available: true, durationMs: 900, id: "a", state: "pending" },
				type: "status",
			})
		).toEqual({ durationMs: 900, id: "a", phase: "pending" });
	});

	test("counts only from idle, and cancel returns a count-in to idle", () => {
		const counting = voiceoverTransition(
			{ phase: "idle" },
			{ remaining: 3, type: "count" }
		);
		expect(counting).toEqual({ phase: "counting", remaining: 3 });
		expect(voiceoverTransition(counting, { type: "cancel" })).toEqual({
			phase: "idle",
		});
		expect(
			voiceoverTransition(recording, { remaining: 2, type: "count" })
		).toBe(recording);
		expect(voiceoverTransition(recording, { type: "cancel" })).toBe(recording);
	});

	test("a failure keeps a captured take pending so it can be retried", () => {
		expect(
			voiceoverTransition(
				{ id: "a", phase: "importing" },
				{ error: "offline", type: "failed" }
			)
		).toEqual({ error: "offline", id: "a", phase: "pending" });
		expect(
			voiceoverTransition(
				{ phase: "counting", remaining: 1 },
				{
					error: "denied",
					type: "failed",
				}
			)
		).toEqual({ error: "denied", phase: "idle" });
	});

	test("a failure while recording or stopping keeps the take live", () => {
		expect(
			voiceoverTransition(
				{ id: "a", phase: "recording", startedAt: 5 },
				{ error: "rpc timeout", type: "failed" }
			)
		).toEqual({
			error: "rpc timeout",
			id: "a",
			phase: "recording",
			startedAt: 5,
		});
		expect(
			voiceoverTransition(
				{ id: "a", phase: "stopping", startedAt: 5 },
				{ error: "rpc timeout", type: "failed" }
			)
		).toEqual({
			error: "rpc timeout",
			id: "a",
			phase: "recording",
			startedAt: 5,
		});
	});
});

describe("VoiceoverRecorder", () => {
	test("a failed status poll while recording keeps the take stoppable", async () => {
		const host = mockHost();
		host.setState("recording");
		let pollFails = false;
		const recorder = new VoiceoverRecorder({
			bridge: (input) =>
				pollFails && input.action === "status"
					? Promise.reject(new Error("rpc timeout"))
					: host.bridge(input),
		});
		await recorder.refresh();
		expect(recorder.getState().phase).toBe("recording");
		pollFails = true;
		await recorder.refresh();
		expect(recorder.getState()).toMatchObject({
			error: "rpc timeout",
			id: "take-1",
			phase: "recording",
		});
		await recorder.stop();
		expect(host.calls.map((call) => call.action)).toEqual(["status", "stop"]);
		expect(recorder.getState()).toMatchObject({
			id: "take-1",
			phase: "pending",
		});
		expect(recorder.getState()).not.toHaveProperty("error");
	});

	test("a failed stop can be retried", async () => {
		const host = mockHost();
		host.setState("recording");
		let stopFails = true;
		const recorder = new VoiceoverRecorder({
			bridge: (input) =>
				stopFails && input.action === "stop"
					? Promise.reject(new Error("rpc timeout"))
					: host.bridge(input),
		});
		await recorder.refresh();
		await recorder.stop();
		expect(recorder.getState()).toMatchObject({
			error: "rpc timeout",
			phase: "recording",
		});
		stopFails = false;
		await recorder.stop();
		expect(recorder.getState().phase).toBe("pending");
	});

	test("is unavailable without a host bridge", async () => {
		const recorder = new VoiceoverRecorder({ bridge: null });
		await recorder.refresh();
		expect(recorder.getState()).toEqual({
			message: UNAVAILABLE_MESSAGE,
			phase: "unavailable",
		});
		expect(await recorder.start()).toBe(false);
	});

	test("shows the host's reason when capture is unavailable on this surface", async () => {
		const recorder = new VoiceoverRecorder({
			bridge: () =>
				Promise.resolve({
					available: false,
					background: false,
					message: "Microphone capture is unavailable on this surface.",
					state: "idle",
				}),
		});
		await recorder.refresh();
		expect(recorder.getState()).toEqual({
			message: "Microphone capture is unavailable on this surface.",
			phase: "unavailable",
		});
	});

	test("counts in 3-2-1, records, stops, and commits the take", async () => {
		const host = mockHost();
		const counts: number[] = [];
		const phases: string[] = [];
		const recorder = new VoiceoverRecorder({
			bridge: host.bridge,
			now: () => Date.parse("2026-10-14T10:00:02.000Z"),
			wait: instantWait,
		});
		recorder.subscribe(() => phases.push(recorder.getState().phase));
		await recorder.refresh();
		expect(recorder.getState().phase).toBe("idle");
		expect(await recorder.start(COUNT_IN_SECONDS, (n) => counts.push(n))).toBe(
			true
		);
		expect(counts).toEqual([3, 2, 1, 0]);
		const state = recorder.getState();
		expect(state.phase).toBe("recording");
		expect(elapsedSeconds(state, Date.parse("2026-10-14T10:00:04.000Z"))).toBe(
			4
		);
		await recorder.stop();
		expect(recorder.getState()).toEqual({
			durationMs: 2500,
			id: "take-1",
			phase: "pending",
		});
		const placed: RecordedMedia[] = [];
		expect(
			await recorder.commit((media) => {
				placed.push(media);
				return Promise.resolve("Voiceover added.");
			}, "Voiceover take")
		).toBe(true);
		expect(placed).toEqual([
			{
				base64: btoa("RIFF....WAVEfmt "),
				mimeType: "audio/wav",
				name: "Voiceover take",
			},
		]);
		expect(recorder.getState()).toEqual({
			notice: "Voiceover added.",
			phase: "idle",
		});
		expect(host.calls.map((call) => call.action)).toEqual([
			"status",
			"start",
			"stop",
			"read",
			"discard",
		]);
		expect(phases).toEqual([
			"idle",
			"counting",
			"counting",
			"counting",
			"recording",
			"stopping",
			"pending",
			"importing",
			"idle",
		]);
	});

	test("cancelling the count-in never opens the microphone", async () => {
		const host = mockHost();
		let release: (() => void) | undefined;
		const recorder = new VoiceoverRecorder({
			bridge: host.bridge,
			wait: (_ms, signal) =>
				new Promise((resolve, reject) => {
					release = resolve;
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		});
		await recorder.refresh();
		const started = recorder.start();
		expect(recorder.getState()).toEqual({ phase: "counting", remaining: 3 });
		recorder.cancel();
		expect(await started).toBe(false);
		expect(release).toBeDefined();
		expect(recorder.getState()).toEqual({ phase: "idle" });
		expect(host.calls.map((call) => call.action)).toEqual(["status"]);
	});

	test("a failed start reports the reason and stays idle", async () => {
		const host = mockHost({ startFails: "Permission denied" });
		const recorder = new VoiceoverRecorder({
			bridge: host.bridge,
			wait: instantWait,
		});
		await recorder.refresh();
		expect(await recorder.start()).toBe(false);
		expect(recorder.getState()).toEqual({
			error: "Permission denied",
			phase: "idle",
		});
	});

	test("a failed import keeps the take on the host for a retry", async () => {
		const host = mockHost();
		host.setState("pending");
		const recorder = new VoiceoverRecorder({
			bridge: host.bridge,
			wait: instantWait,
		});
		await recorder.refresh();
		expect(
			await recorder.commit(
				() => Promise.reject(new Error("Sidecar offline")),
				"Take"
			)
		).toBe(false);
		expect(recorder.getState()).toEqual({
			error: "Sidecar offline",
			id: "take-1",
			phase: "pending",
		});
		expect(host.calls.map((call) => call.action)).not.toContain("discard");
		expect(await recorder.commit(() => Promise.resolve("Added."), "Take")).toBe(
			true
		);
		expect(host.calls.at(-1)?.action).toBe("discard");
	});

	test("picks up a take left recording or pending by an earlier mount", async () => {
		const host = mockHost();
		host.setState("recording");
		const recorder = new VoiceoverRecorder({ bridge: host.bridge });
		await recorder.refresh();
		expect(recorder.getState().phase).toBe("recording");
		// The host auto-stopped the take; polling notices.
		host.setState("pending");
		await recorder.refresh();
		expect(recorder.getState().phase).toBe("pending");
		await recorder.discard();
		expect(recorder.getState()).toEqual({
			notice: "Recording discarded.",
			phase: "idle",
		});
	});

	test("rejects a malformed host reply", async () => {
		const recorder = new VoiceoverRecorder({
			bridge: () => Promise.resolve({ state: "bogus" }),
		});
		await recorder.refresh();
		expect(recorder.getState().phase).toBe("idle");
		expect(recorder.getState()).toHaveProperty("error");
	});

	test("a mocked recording produces an asset and a clip at the playhead", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.time = 7.5;
		const host = mockHost();
		const recorder = new VoiceoverRecorder({
			bridge: host.bridge,
			wait: instantWait,
		});
		const imported: Asset = {
			createdAt: new Date(0).toISOString(),
			duration: 2.5,
			hasAudio: true,
			height: 0,
			id: crypto.randomUUID(),
			kind: "audio",
			name: "Voiceover",
			width: 0,
		};
		await recorder.refresh();
		await recorder.start();
		await recorder.stop();
		await recorder.commit(async (media) => {
			const placed = await addRecordingToTimeline(
				runtime,
				media,
				runtime.time,
				{
					importAsset: () => Promise.resolve(imported),
					upload: () => Promise.reject(new Error("unused")),
				}
			);
			return placed.placementError ?? "added";
		}, "Voiceover");
		const clip = runtime.project?.segments.find(
			(segment) => segment.assetId === imported.id
		);
		expect(clip).toMatchObject({ start: 7.5, track: 1 });
		expect(recorder.getState()).toEqual({ notice: "added", phase: "idle" });
	});
});

describe("hostRecordingBridge", () => {
	test("returns null when the host has no recording bridge", () => {
		expect(hostRecordingBridge(undefined)).toBeNull();
		expect(hostRecordingBridge({ media: {} })).toBeNull();
	});

	test("calls the host's media.recording with its receiver", async () => {
		const media = {
			recording(this: unknown, input: MediaRecordingInput) {
				return Promise.resolve({ input, self: this === media });
			},
		};
		const bridge = hostRecordingBridge({ media });
		expect(await bridge?.({ action: "status" })).toEqual({
			input: { action: "status" },
			self: true,
		});
	});
});

describe("prerollPlan", () => {
	test("starts playback a count-in early so the playhead meets the anchor", () => {
		expect(prerollPlan(10)).toEqual({ delayMs: 0, startTime: 7 });
		expect(prerollPlan(1)).toEqual({ delayMs: 2000, startTime: 0 });
		expect(prerollPlan(-5)).toEqual({ delayMs: 3000, startTime: 0 });
	});
});
