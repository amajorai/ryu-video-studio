import { beforeEach, describe, expect, mock, test } from "bun:test";

const resumed: string[] = [];
const realAudioPreview = await import("../../audio-preview.ts");
mock.module("../../audio-preview.ts", () => ({
	...realAudioPreview,
	resumePreviewAudio: () => {
		resumed.push("resume");
		return Promise.resolve();
	},
}));

const { pausePlayback, playAround, playbackActions, shuttle, toggleLoop } =
	await import("./playback.ts");
const { createTestRuntime, lastStatus, testProject } = await import(
	"../test-runtime.ts"
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
	const { project } = testProject();
	const runtime = createTestRuntime(project);
	return runtime;
}

beforeEach(() => {
	resumed.length = 0;
});

describe("J/L acceleration", () => {
	test("repeated L presses step through 1x, 2x, 4x, 8x and hold at 8x", async () => {
		const runtime = setup();
		const rates: number[] = [];
		for (let press = 0; press < 5; press += 1) {
			shuttle(runtime, 1);
			await flush();
			rates.push(runtime.store.getState().playbackRate);
		}
		expect(rates).toEqual([1, 2, 4, 8, 8]);
		expect(runtime.playing).toBe(true);
		expect(lastStatus(runtime)).toBe("Playing at 8x.");
	});

	test("J after L restarts at 1x in reverse, then accelerates", async () => {
		const runtime = setup();
		shuttle(runtime, 1);
		await flush();
		shuttle(runtime, 1);
		await flush();
		expect(runtime.store.getState().playbackRate).toBe(2);
		shuttle(runtime, -1);
		await flush();
		expect(runtime.store.getState().playbackRate).toBe(1);
		expect(runtime.calls).toContainEqual(["setPlaybackDirection", -1]);
		shuttle(runtime, -1);
		await flush();
		expect(runtime.store.getState().playbackRate).toBe(2);
		expect(lastStatus(runtime)).toBe("Playing in reverse at 2x.");
	});

	test("K stops and resets the speed; the next L plays at 1x", async () => {
		const runtime = setup();
		shuttle(runtime, 1);
		await flush();
		shuttle(runtime, 1);
		await flush();
		pausePlayback(runtime);
		expect(runtime.playing).toBe(false);
		expect(runtime.store.getState().playbackRate).toBe(1);
		shuttle(runtime, 1);
		await flush();
		expect(runtime.store.getState().playbackRate).toBe(1);
	});

	test("pressing L while paused never accelerates", async () => {
		const runtime = setup();
		runtime.store.setState({ playbackRate: 4 });
		shuttle(runtime, 1);
		await flush();
		expect(runtime.store.getState().playbackRate).toBe(1);
	});

	test("Space starts at normal speed", async () => {
		const runtime = setup();
		runtime.store.setState({ playbackRate: 8 });
		playbackActions["playback.toggle"]?.(runtime);
		await flush();
		expect(runtime.playing).toBe(true);
		expect(runtime.store.getState().playbackRate).toBe(1);
	});
});

describe("loop toggle", () => {
	test("Cmd+L cycles off, range, whole timeline, off", () => {
		const runtime = setup();
		runtime.range = { end: 4, start: 1 };
		expect(toggleLoop(runtime)).toBe("range");
		expect(runtime.store.getState().loop.mode).toBe("range");
		expect(lastStatus(runtime)).toBe("Looping the range 0:01.0–0:04.0.");
		expect(toggleLoop(runtime)).toBe("all");
		expect(lastStatus(runtime)).toBe("Looping the whole timeline.");
		expect(toggleLoop(runtime)).toBe("off");
		expect(lastStatus(runtime)).toBe("Loop playback off.");
	});
});

describe("play around", () => {
	test("starts two seconds before the playhead at 1x, playing forward", async () => {
		const runtime = setup();
		runtime.time = 5;
		runtime.store.setState({ playbackRate: 4 });
		playAround(runtime);
		await flush();
		expect(runtime.calls).toContainEqual(["setTime", 3]);
		expect(runtime.calls).toContainEqual(["setPlaybackDirection", 1]);
		expect(runtime.playing).toBe(true);
		expect(runtime.store.getState().playbackRate).toBe(1);
		expect(resumed).toHaveLength(1);
	});

	test("clamps the preroll at the timeline start", async () => {
		const runtime = setup();
		runtime.time = 0.5;
		playAround(runtime);
		await flush();
		expect(runtime.calls).toContainEqual(["setTime", 0]);
	});

	test("does nothing on an empty timeline", () => {
		const runtime = createTestRuntime(null);
		expect(playAround(runtime)).toBe(false);
		expect(runtime.calls).toEqual([]);
	});
});
