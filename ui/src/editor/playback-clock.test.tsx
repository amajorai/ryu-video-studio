import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});

/** A controllable clock: `performance.now()` and a manual rAF queue. */
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const realNow = performance.now.bind(performance);
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
performance.now = () => now;
globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
	const id = nextFrame++;
	frames.set(id, callback);
	return id;
};
globalThis.cancelAnimationFrame = (id: number) => {
	frames.delete(id);
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
	clockPosition,
	loopWindow,
	nextShuttleRate,
	playAroundWindow,
	playbackTransport,
	previewMediaSync,
	usePlaybackClock,
} = await import("./playback-clock.ts");

afterAll(() => {
	performance.now = realNow;
	globalThis.requestAnimationFrame = realRaf;
	globalThis.cancelAnimationFrame = realCancel;
	GlobalRegistrator.unregister();
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

describe("clockPosition", () => {
	const origin = { at: 1000, time: 2 };

	test("keeps the legacy shape without options", () => {
		expect(clockPosition(origin, 1500, 1, 10)).toEqual({
			ended: false,
			time: 2.5,
		});
		expect(clockPosition(origin, 20_000, -1, 10)).toEqual({
			ended: true,
			time: 0,
		});
	});

	test("rate scales the speed in either direction", () => {
		expect(clockPosition(origin, 1500, 1, 10, { rate: 4 }).time).toBe(4);
		expect(clockPosition(origin, 1250, -1, 10, { rate: 8 }).time).toBe(0);
		// Invalid rates fall back to 1x.
		expect(clockPosition(origin, 1500, 1, 10, { rate: 0 }).time).toBe(2.5);
	});

	test("a loop wraps forward playback from out to in", () => {
		const loop = { end: 3, start: 1 };
		expect(clockPosition(origin, 1900, 1, 10, { loop })).toEqual({
			ended: false,
			time: 2.9,
		});
		expect(clockPosition(origin, 2000, 1, 10, { loop })).toEqual({
			ended: false,
			time: 1,
			wrapped: true,
		});
	});

	test("a loop wraps reverse playback from in to out", () => {
		const loop = { end: 3, start: 1 };
		expect(clockPosition(origin, 2100, -1, 10, { loop })).toEqual({
			ended: false,
			time: 3,
			wrapped: true,
		});
	});

	test("looping the whole timeline never ends", () => {
		const loop = { end: 10, start: 0 };
		expect(clockPosition(origin, 20_000, 1, 10, { loop })).toEqual({
			ended: false,
			time: 0,
			wrapped: true,
		});
	});

	test("stopAt ends forward playback (play around)", () => {
		expect(clockPosition(origin, 4000, 1, 10, { stopAt: 4 })).toEqual({
			ended: true,
			time: 4,
		});
		// It does not apply in reverse.
		expect(clockPosition(origin, 1500, -1, 10, { stopAt: 4 }).ended).toBe(
			false
		);
	});
});

describe("loop and play-around windows", () => {
	test("range mode loops the I/O range; all mode loops the timeline", () => {
		expect(loopWindow("off", { end: 4, start: 1 }, 10)).toBeNull();
		expect(loopWindow("range", { end: 4, start: 1 }, 10)).toEqual({
			end: 4,
			start: 1,
		});
		expect(loopWindow("range", { end: 40, start: 8 }, 10)).toEqual({
			end: 10,
			start: 8,
		});
		expect(loopWindow("all", { end: 4, start: 1 }, 10)).toEqual({
			end: 10,
			start: 0,
		});
	});

	test("spans too short to loop, or empty timelines, do not loop", () => {
		expect(loopWindow("range", { end: 1.01, start: 1 }, 10)).toBeNull();
		expect(loopWindow("all", { end: 1, start: 0 }, 0)).toBeNull();
	});

	test("play around spans two seconds either side, clamped", () => {
		expect(playAroundWindow(5, 10)).toEqual({ end: 7, returnTo: 5, start: 3 });
		expect(playAroundWindow(1, 10)).toEqual({ end: 3, returnTo: 1, start: 0 });
		expect(playAroundWindow(9.5, 10)).toEqual({
			end: 10,
			returnTo: 9.5,
			start: 7.5,
		});
		expect(playAroundWindow(5, 10, { postroll: 1, preroll: 3 })).toEqual({
			end: 6,
			returnTo: 5,
			start: 2,
		});
	});

	test("shuttle rates double up to 8x and restart at 1x", () => {
		expect(nextShuttleRate(1, true)).toBe(2);
		expect(nextShuttleRate(2, true)).toBe(4);
		expect(nextShuttleRate(4, true)).toBe(8);
		expect(nextShuttleRate(8, true)).toBe(8);
		expect(nextShuttleRate(8, false)).toBe(1);
	});
});

type Clock = ReturnType<typeof usePlaybackClock>;

async function mountClock(duration: number) {
	const state: { clock: Clock | null } = { clock: null };
	function Harness() {
		state.clock = usePlaybackClock(duration);
		return null;
	}
	const host = document.createElement("div");
	const root = createRoot(host);
	await act(async () => {
		root.render(<Harness />);
	});
	const clock = () => {
		if (!state.clock) {
			throw new Error("Clock not mounted.");
		}
		return state.clock;
	};
	/** Advance fake time and run the frames queued so far. */
	const advance = async (milliseconds: number) => {
		now += milliseconds;
		const queued = [...frames.values()];
		frames = new Map();
		await act(async () => {
			for (const callback of queued) {
				callback(now);
			}
		});
	};
	return {
		advance,
		clock,
		unmount: async () => {
			await act(async () => root.unmount());
		},
	};
}

describe("previewMediaSync", () => {
	test("scales the media rate and drift tolerance with the shuttle rate", () => {
		expect(previewMediaSync(1, 1)).toEqual({
			driftTolerance: 0.15,
			playbackRate: 1,
		});
		expect(previewMediaSync(0.5, 4)).toEqual({
			driftTolerance: 0.6,
			playbackRate: 2,
		});
		expect(previewMediaSync(4, 8).playbackRate).toBe(16);
		expect(previewMediaSync(Number.NaN, 0)).toEqual({
			driftTolerance: 0.15,
			playbackRate: 1,
		});
	});
});

describe("usePlaybackClock with fake timers", () => {
	beforeEach(() => {
		now = 0;
		frames = new Map();
	});

	test("plays to the end and stops without a loop", async () => {
		const harness = await mountClock(2);
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(1000);
		expect(harness.clock().time).toBe(1);
		await harness.advance(1500);
		expect(harness.clock().time).toBe(2);
		expect(harness.clock().playing).toBe(false);
		await harness.unmount();
	});

	test("a configured loop wraps from out to in and keeps playing", async () => {
		const harness = await mountClock(10);
		const transport = playbackTransport(harness.clock());
		expect(transport).toBeDefined();
		transport?.configure({ loop: { end: 3, start: 1 }, rate: 1 });
		await act(async () => harness.clock().setTime(2));
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(500);
		expect(harness.clock().time).toBeCloseTo(2.5, 9);
		await harness.advance(600);
		// Crossed out (3): jumped to in (1).
		expect(harness.clock().time).toBe(1);
		expect(harness.clock().playing).toBe(true);
		await harness.advance(1000);
		expect(harness.clock().time).toBeCloseTo(2, 9);
		await harness.unmount();
	});

	test("looping the whole timeline restarts at 0", async () => {
		const harness = await mountClock(2);
		playbackTransport(harness.clock())?.configure({
			loop: { end: 2, start: 0 },
			rate: 1,
		});
		await act(async () => harness.clock().setTime(1.5));
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(600);
		expect(harness.clock().time).toBe(0);
		expect(harness.clock().playing).toBe(true);
		await harness.unmount();
	});

	test("changing the rate mid-play applies from the current position", async () => {
		const harness = await mountClock(100);
		const transport = playbackTransport(harness.clock());
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(1000);
		expect(harness.clock().time).toBe(1);
		transport?.configure({ loop: null, rate: 4 });
		await harness.advance(1000);
		expect(harness.clock().time).toBe(5);
		expect(transport?.settings()).toEqual({ loop: null, rate: 4 });
		await harness.unmount();
	});

	test("play around stops at the postroll and returns to the playhead", async () => {
		const harness = await mountClock(10);
		const transport = playbackTransport(harness.clock());
		await act(async () => harness.clock().setTime(3));
		transport?.playAround({ end: 7, returnTo: 5, start: 3 });
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(2000);
		expect(harness.clock().time).toBe(5);
		expect(harness.clock().playing).toBe(true);
		await harness.advance(2500);
		expect(harness.clock().playing).toBe(false);
		expect(harness.clock().time).toBe(5);
		await harness.unmount();
	});

	test("seeking cancels a pending play around", async () => {
		const harness = await mountClock(10);
		const transport = playbackTransport(harness.clock());
		transport?.playAround({ end: 2, returnTo: 1, start: 0 });
		await act(async () => harness.clock().setTime(4));
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(3000);
		expect(harness.clock().time).toBe(7);
		expect(harness.clock().playing).toBe(true);
		await harness.unmount();
	});

	test("a play-around ignores a loop that ends before its postroll", async () => {
		const harness = await mountClock(10);
		const transport = playbackTransport(harness.clock());
		transport?.configure({
			loop: loopWindow("range", { end: 3, start: 0 }, 10),
			rate: 1,
		});
		const window = playAroundWindow(2.5, 10);
		await act(async () => harness.clock().setTime(window.start));
		transport?.playAround(window);
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(1000);
		expect(harness.clock().time).toBeCloseTo(1.5, 9);
		// Past the loop out (3) without wrapping.
		await harness.advance(2000);
		expect(harness.clock().time).toBeCloseTo(3.5, 9);
		expect(harness.clock().playing).toBe(true);
		await harness.advance(1500);
		expect(harness.clock().playing).toBe(false);
		expect(harness.clock().time).toBe(2.5);
		// Normal playback afterwards loops again.
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(600);
		expect(harness.clock().time).toBe(0);
		expect(harness.clock().playing).toBe(true);
		await harness.unmount();
	});

	test("reversing during a play-around cancels it", async () => {
		const harness = await mountClock(10);
		const transport = playbackTransport(harness.clock());
		await act(async () => harness.clock().setTime(3));
		transport?.playAround({ end: 7, returnTo: 5, start: 3 });
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(1000);
		await act(async () => harness.clock().setDirection(-1));
		await harness.advance(10_000);
		expect(harness.clock().playing).toBe(false);
		// Reverse playback ended at 0 and stayed there.
		expect(harness.clock().time).toBe(0);
		await harness.unmount();
	});

	test("setting the same direction keeps a play-around armed", async () => {
		const harness = await mountClock(10);
		const transport = playbackTransport(harness.clock());
		await act(async () => harness.clock().setTime(3));
		transport?.playAround({ end: 7, returnTo: 5, start: 3 });
		await act(async () => harness.clock().setDirection(1));
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(5000);
		expect(harness.clock().playing).toBe(false);
		expect(harness.clock().time).toBe(5);
		await harness.unmount();
	});

	test("a rate change during a play-around cancels it", async () => {
		const harness = await mountClock(100);
		const transport = playbackTransport(harness.clock());
		await act(async () => harness.clock().setTime(3));
		transport?.playAround({ end: 7, returnTo: 5, start: 3 });
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(1000);
		transport?.configure({ loop: null, rate: 2 });
		await harness.advance(5000);
		expect(harness.clock().playing).toBe(true);
		expect(harness.clock().time).toBe(14);
		await harness.unmount();
	});

	test("cancelPlayAround lets playback continue past the postroll", async () => {
		const harness = await mountClock(100);
		const transport = playbackTransport(harness.clock());
		await act(async () => harness.clock().setTime(3));
		transport?.playAround({ end: 7, returnTo: 5, start: 3 });
		await act(async () => harness.clock().setPlaying(true));
		await harness.advance(1000);
		transport?.cancelPlayAround();
		await harness.advance(9000);
		expect(harness.clock().playing).toBe(true);
		expect(harness.clock().time).toBe(13);
		await harness.unmount();
	});

	test("a plain function is not a clock transport", () => {
		expect(playbackTransport({ setTime: () => undefined })).toBeUndefined();
	});
});
