/**
 * Preview ducking. Clips that are not set to duck feed a silent key bus
 * (post clip gain, as the export's sidechain mix is); an analyser on it is
 * polled, and every "Duck under voice" clip's duck gain heads for the
 * shared `previewDuckTarget` with the clip's attack or release, so the dip
 * is audible while editing and follows the same threshold and depth as
 * the exported file.
 */
import {
	previewDuckTarget,
	type ResolvedDuck,
} from "../../../shared/ducking.ts";

/** Samples per key reading: about 21 ms at 48 kHz. */
export const DUCK_KEY_BLOCK = 1024;
/** Milliseconds between key readings (shorter than the fastest attack). */
export const DUCK_POLL_MS = 10;

/** One clip's place in the ducking: its output tap and its duck gain. */
export interface DuckMember {
	/** Gain after `tap` that the ducker turns down on ducked clips. */
	readonly duck: GainNode;
	/** The clip's gain node; key members connect it to the key bus. */
	readonly tap: AudioNode;
}

export interface PreviewDucker {
	/**
	 * Make `member` a ducked clip with `duck` settings, or (with null) a key
	 * clip that drives the ducking.
	 */
	assign(member: DuckMember, duck: ResolvedDuck | null): void;
	dispose(): void;
	/** Stop tracking `member` (its nodes are being disposed). */
	remove(member: DuckMember): void;
	/** Read the key once and steer the ducked clips; the timer calls it. */
	tick(): void;
}

export interface DuckTimers {
	clear(handle: unknown): void;
	every(callback: () => void, ms: number): unknown;
}

const defaultTimers: DuckTimers = {
	clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	every: (callback, ms) => setInterval(callback, ms),
};

/** RMS of one block of samples. */
export function blockRms(block: ArrayLike<number>): number {
	if (!block.length) {
		return 0;
	}
	let sum = 0;
	for (let index = 0; index < block.length; index++) {
		const sample = block[index] ?? 0;
		sum += sample * sample;
	}
	return Math.sqrt(sum / block.length);
}

interface DuckedState {
	duck: ResolvedDuck;
	/** Last gain the duck node was sent toward. */
	target: number;
}

/** A ducker for `audio`, or null when the context cannot analyse audio. */
export function createPreviewDucker(
	audio: BaseAudioContext,
	timers: DuckTimers = defaultTimers
): PreviewDucker | null {
	if (typeof audio.createAnalyser !== "function") {
		return null;
	}
	const bus = audio.createGain();
	const analyser = audio.createAnalyser();
	analyser.fftSize = DUCK_KEY_BLOCK;
	analyser.smoothingTimeConstant = 0;
	bus.connect(analyser);
	const block = new Float32Array(DUCK_KEY_BLOCK);
	const keys = new Set<DuckMember>();
	const ducked = new Map<DuckMember, DuckedState>();
	let timer: unknown;

	const restore = (member: DuckMember) => {
		member.duck.gain.cancelScheduledValues(audio.currentTime);
		member.duck.gain.value = 1;
	};
	const unkey = (member: DuckMember) => {
		if (keys.delete(member)) {
			try {
				member.tap.disconnect(bus);
			} catch {
				// Already disconnected with the rest of the clip graph.
			}
		}
	};
	const schedule = () => {
		const needed = ducked.size > 0;
		if (needed && timer === undefined) {
			timer = timers.every(tick, DUCK_POLL_MS);
		} else if (!needed && timer !== undefined) {
			timers.clear(timer);
			timer = undefined;
		}
	};
	function tick() {
		let level = 0;
		if (keys.size) {
			analyser.getFloatTimeDomainData(block);
			level = blockRms(block);
		}
		for (const [member, state] of ducked) {
			const next = previewDuckTarget(level, state.duck);
			if (next.gain !== state.target) {
				state.target = next.gain;
				member.duck.gain.setTargetAtTime(
					next.gain,
					audio.currentTime,
					next.timeConstant
				);
			}
		}
	}

	return {
		assign(member, duck) {
			if (duck) {
				unkey(member);
				const current = ducked.get(member);
				if (current) {
					current.duck = duck;
				} else {
					ducked.set(member, { duck, target: 1 });
				}
			} else {
				if (ducked.delete(member)) {
					restore(member);
				}
				if (!keys.has(member)) {
					member.tap.connect(bus);
					keys.add(member);
				}
			}
			schedule();
		},
		remove(member) {
			unkey(member);
			ducked.delete(member);
			schedule();
		},
		tick,
		dispose() {
			for (const member of [...keys]) {
				unkey(member);
			}
			for (const member of ducked.keys()) {
				restore(member);
			}
			ducked.clear();
			schedule();
			bus.disconnect();
		},
	};
}
