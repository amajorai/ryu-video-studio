import { describe, expect, test } from "bun:test";
import {
	browserCaptureEnvironment,
	type CaptureEnvironment,
	type CaptureMediaRecorder,
	CaptureRecorder,
	type CaptureRecorderHandlers,
	type CaptureStream,
	captureErrorMessage,
	captureSupport,
	MAX_CAPTURE_SECONDS,
	recorderMimeType,
} from "./screen.ts";

class FakeTrack {
	stopped = false;
	private readonly ended: (() => void)[] = [];
	addEventListener(_type: "ended", listener: () => void) {
		this.ended.push(listener);
	}
	stop() {
		this.stopped = true;
	}
	/** The viewer ended the share from the browser's own controls. */
	end() {
		for (const listener of this.ended) {
			listener();
		}
	}
}

class FakeRecorder implements CaptureMediaRecorder {
	handlers: CaptureRecorderHandlers | null = null;
	state = "inactive";
	timeslice: number | undefined;
	readonly mimeType: string;
	constructor(mimeType: string | undefined) {
		this.mimeType = mimeType ?? "video/webm";
	}
	listen(handlers: CaptureRecorderHandlers | null) {
		this.handlers = handlers;
	}
	start(timeslice?: number) {
		this.state = "recording";
		this.timeslice = timeslice;
		this.handlers?.data(new Blob(["chunk-1"]));
	}
	stop() {
		this.state = "inactive";
		this.handlers?.data(new Blob(["chunk-2"]));
		this.handlers?.stop();
	}
}

function fakeEnvironment(overrides: Partial<CaptureEnvironment> = {}) {
	const tracks = [new FakeTrack(), new FakeTrack()];
	const stream: CaptureStream = { getTracks: () => tracks };
	const recorders: FakeRecorder[] = [];
	const requests: string[] = [];
	const environment: CaptureEnvironment = {
		createRecorder: (_stream, mimeType) => {
			const recorder = new FakeRecorder(mimeType);
			recorders.push(recorder);
			return recorder;
		},
		getDisplayMedia: () => {
			requests.push("screen");
			return Promise.resolve(stream);
		},
		getUserMedia: () => {
			requests.push("camera");
			return Promise.resolve(stream);
		},
		isTypeSupported: (type) => type === "video/webm;codecs=vp8,opus",
		...overrides,
	};
	return { environment, recorders, requests, tracks };
}

function clock(start = 1000) {
	let value = start;
	return {
		advance: (ms: number) => {
			value += ms;
		},
		now: () => value,
	};
}

describe("capture feature detection", () => {
	test("reports each missing source with a reason", () => {
		expect(captureSupport({})).toEqual({
			camera: {
				available: false,
				reason:
					"Ryu has not granted Video Studio camera capture on this surface.",
			},
			screen: {
				available: false,
				reason:
					"Ryu has not granted Video Studio screen capture on this surface.",
			},
		});
		const { environment } = fakeEnvironment();
		expect(captureSupport(environment)).toEqual({
			camera: { available: true },
			screen: { available: true },
		});
		const noRecorder = captureSupport({
			getDisplayMedia: environment.getDisplayMedia,
		});
		expect(noRecorder.screen.available).toBe(false);
		expect(noRecorder.screen.reason).toContain("MediaRecorder");
	});

	test("detects nothing in an environment without media devices", () => {
		const bare = { navigator: {} } as unknown as typeof globalThis;
		expect(browserCaptureEnvironment(bare)).toEqual({});
	});

	test("picks the first supported WebM type", () => {
		expect(recorderMimeType(undefined)).toBeUndefined();
		expect(recorderMimeType(() => false)).toBeUndefined();
		expect(recorderMimeType((type) => type.includes("vp8"))).toBe(
			"video/webm;codecs=vp8,opus"
		);
		expect(
			recorderMimeType(() => {
				throw new Error("unsupported");
			})
		).toBeUndefined();
	});

	test("explains refused capture requests", () => {
		const denied = Object.assign(new Error("x"), { name: "NotAllowedError" });
		expect(captureErrorMessage("screen", denied)).toContain(
			"declined or the host has not granted"
		);
		const missing = Object.assign(new Error("x"), { name: "NotFoundError" });
		expect(captureErrorMessage("camera", missing)).toBe("No camera was found.");
		expect(captureErrorMessage("camera", "odd")).toBe(
			"The camera capture did not start."
		);
	});
});

describe("CaptureRecorder", () => {
	test("records the screen to WebM and hands the take to commit", async () => {
		const { environment, recorders, requests, tracks } = fakeEnvironment();
		const time = clock();
		const capture = new CaptureRecorder({
			environment,
			now: time.now,
			schedule: () => () => undefined,
		});
		expect(await capture.start("screen")).toBe(true);
		expect(requests).toEqual(["screen"]);
		expect(recorders[0]?.mimeType).toBe("video/webm;codecs=vp8,opus");
		expect(recorders[0]?.timeslice).toBe(1000);
		expect(capture.getState()).toEqual({
			phase: "recording",
			source: "screen",
			startedAt: 1000,
		});
		time.advance(4000);
		await capture.stop();
		const ready = capture.getState();
		if (ready.phase !== "ready") {
			throw new Error(`expected ready, got ${ready.phase}`);
		}
		expect(ready.durationMs).toBe(4000);
		expect(await ready.blob.text()).toBe("chunk-1chunk-2");
		expect(ready.blob.type).toBe("video/webm;codecs=vp8,opus");
		expect(tracks.every((track) => track.stopped)).toBe(true);
		const committed: string[] = [];
		expect(
			await capture.commit((_blob, source) => {
				committed.push(source);
				return Promise.resolve("Screen recording added.");
			})
		).toBe(true);
		expect(committed).toEqual(["screen"]);
		expect(capture.getState()).toEqual({
			notice: "Screen recording added.",
			phase: "idle",
		});
	});

	test("ending the share from the browser stops the recording", async () => {
		const { environment, tracks } = fakeEnvironment();
		const capture = new CaptureRecorder({
			environment,
			schedule: () => () => undefined,
		});
		await capture.start("camera");
		tracks[0]?.end();
		await capture.stop();
		expect(capture.getState().phase).toBe("ready");
	});

	test("stops on its own at the capture length limit", async () => {
		const { environment } = fakeEnvironment();
		let limit: (() => void) | undefined;
		let delay = 0;
		const capture = new CaptureRecorder({
			environment,
			schedule: (ms, run) => {
				delay = ms;
				limit = run;
				return () => undefined;
			},
		});
		await capture.start("screen");
		expect(delay).toBe(MAX_CAPTURE_SECONDS * 1000);
		limit?.();
		await capture.stop();
		expect(capture.getState().phase).toBe("ready");
	});

	test("an unavailable source explains why and requests nothing", async () => {
		const { environment, requests } = fakeEnvironment({
			getDisplayMedia: undefined,
		});
		const capture = new CaptureRecorder({ environment });
		expect(await capture.start("screen")).toBe(false);
		expect(requests).toEqual([]);
		expect(capture.getState()).toEqual({
			error: "Ryu has not granted Video Studio screen capture on this surface.",
			phase: "idle",
		});
	});

	test("a declined request returns to idle with the reason", async () => {
		const { environment } = fakeEnvironment({
			getUserMedia: () =>
				Promise.reject(
					Object.assign(new Error("denied"), { name: "NotAllowedError" })
				),
		});
		const capture = new CaptureRecorder({ environment });
		expect(await capture.start("camera")).toBe(false);
		const state = capture.getState();
		expect(state.phase).toBe("idle");
		expect(state.phase === "idle" && state.error).toContain("camera capture");
	});

	test("a failed import keeps the take ready, and discard drops it", async () => {
		const { environment } = fakeEnvironment();
		const capture = new CaptureRecorder({
			environment,
			schedule: () => () => undefined,
		});
		await capture.start("screen");
		await capture.stop();
		expect(
			await capture.commit(() => Promise.reject(new Error("Disk full")))
		).toBe(false);
		const state = capture.getState();
		expect(state.phase).toBe("ready");
		expect(state.phase === "ready" && state.error).toBe("Disk full");
		capture.discard();
		expect(capture.getState()).toEqual({
			notice: "Recording discarded.",
			phase: "idle",
		});
	});

	test("discarding a running capture releases the source", async () => {
		const { environment, tracks } = fakeEnvironment();
		const capture = new CaptureRecorder({
			environment,
			schedule: () => () => undefined,
		});
		await capture.start("camera");
		capture.discard();
		expect(tracks.every((track) => track.stopped)).toBe(true);
		expect(capture.getState().phase).toBe("idle");
		await capture.stop();
		expect(capture.getState().phase).toBe("idle");
	});
});
