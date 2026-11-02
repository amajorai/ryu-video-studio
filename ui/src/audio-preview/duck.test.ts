import { describe, expect, test } from "bun:test";
import { DUCK_DEFAULTS, duckGain } from "../../../shared/ducking.ts";
import {
	blockRms,
	createPreviewDucker,
	DUCK_POLL_MS,
	type DuckMember,
	type DuckTimers,
} from "./duck.ts";

class FakeNode {
	readonly edges: FakeNode[] = [];
	constructor(readonly name: string) {}
	connect(target: FakeNode) {
		this.edges.push(target);
		return target;
	}
	/** Spec behaviour: a targeted disconnect of a missing edge throws. */
	disconnect(target?: FakeNode) {
		if (!target) {
			this.edges.length = 0;
			return;
		}
		const index = this.edges.indexOf(target);
		if (index === -1) {
			throw new DOMException("not connected", "InvalidAccessError");
		}
		this.edges.splice(index, 1);
	}
}

interface Scheduled {
	target: number;
	timeConstant: number;
}

function fakeParam() {
	return {
		cancelled: 0,
		scheduled: [] as Scheduled[],
		value: 1,
		cancelScheduledValues() {
			this.cancelled++;
		},
		setTargetAtTime(target: number, _at: number, timeConstant: number) {
			this.scheduled.push({ target, timeConstant });
		},
	};
}

class FakeContext {
	currentTime = 0;
	level = 0;
	readonly analysers: FakeNode[] = [];
	createGain() {
		return Object.assign(new FakeNode("gain"), { gain: fakeParam() });
	}
	createAnalyser() {
		const node = Object.assign(new FakeNode("analyser"), {
			fftSize: 0,
			getFloatTimeDomainData: (block: Float32Array) => {
				block.fill(this.level);
			},
			smoothingTimeConstant: 1,
		});
		this.analysers.push(node);
		return node;
	}
}

function fakeTimers() {
	const running = new Set<number>();
	let next = 0;
	const timers: DuckTimers & { running: Set<number>; lastMs: number } = {
		clear(handle) {
			running.delete(handle as number);
		},
		every(_callback, ms) {
			timers.lastMs = ms;
			next++;
			running.add(next);
			return next;
		},
		lastMs: 0,
		running,
	};
	return timers;
}

function member(context: FakeContext) {
	const tap = context.createGain();
	const duck = context.createGain();
	return {
		duck,
		member: { duck, tap } as unknown as DuckMember,
		tap,
	};
}

describe("preview ducker", () => {
	test("block RMS of a constant is its magnitude", () => {
		expect(blockRms([])).toBe(0);
		expect(blockRms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 9);
	});

	test("ducks while the key clip sounds and recovers when it stops", () => {
		const context = new FakeContext();
		const timers = fakeTimers();
		const ducker = createPreviewDucker(
			context as unknown as BaseAudioContext,
			timers
		);
		if (!ducker) {
			throw new Error("ducker unavailable");
		}
		const voice = member(context);
		const music = member(context);
		ducker.assign(voice.member, null);
		// The voice feeds the key bus; nothing ducks yet, so no timer runs.
		expect(voice.tap.edges.map((node) => node.name)).toEqual(["gain"]);
		expect(timers.running.size).toBe(0);
		const duck = { amountDb: 12, attackMs: 44, releaseMs: 660 };
		ducker.assign(music.member, duck);
		expect(music.tap.edges).toEqual([]);
		expect(timers.running.size).toBe(1);
		expect(timers.lastMs).toBe(DUCK_POLL_MS);

		context.level = 0.2;
		ducker.tick();
		ducker.tick();
		expect(music.duck.gain.scheduled).toEqual([
			{ target: duckGain(12), timeConstant: 0.044 / Math.log(9) },
		]);
		context.level = 0;
		ducker.tick();
		expect(music.duck.gain.scheduled.at(-1)).toEqual({
			target: 1,
			timeConstant: 0.66 / Math.log(9),
		});
	});

	test("a clip switched off ducking returns to full level and keys", () => {
		const context = new FakeContext();
		const timers = fakeTimers();
		const ducker = createPreviewDucker(
			context as unknown as BaseAudioContext,
			timers
		);
		if (!ducker) {
			throw new Error("ducker unavailable");
		}
		const voice = member(context);
		const music = member(context);
		ducker.assign(voice.member, null);
		ducker.assign(music.member, DUCK_DEFAULTS);
		context.level = 0.2;
		ducker.tick();
		ducker.assign(music.member, null);
		expect(music.duck.gain.cancelled).toBe(1);
		expect(music.duck.gain.value).toBe(1);
		expect(music.tap.edges.map((node) => node.name)).toEqual(["gain"]);
		expect(timers.running.size).toBe(0);
		ducker.remove(voice.member);
		ducker.remove(music.member);
		expect(voice.tap.edges).toEqual([]);
		expect(() => ducker.dispose()).not.toThrow();
	});

	test("with no key clips the ducked clip stays at full level", () => {
		const context = new FakeContext();
		const ducker = createPreviewDucker(
			context as unknown as BaseAudioContext,
			fakeTimers()
		);
		const music = member(context);
		ducker?.assign(music.member, DUCK_DEFAULTS);
		context.level = 0.5;
		ducker?.tick();
		expect(music.duck.gain.scheduled).toEqual([]);
	});

	test("contexts without analysers get no ducker", () => {
		expect(
			createPreviewDucker({} as unknown as BaseAudioContext, fakeTimers())
		).toBeNull();
	});
});
