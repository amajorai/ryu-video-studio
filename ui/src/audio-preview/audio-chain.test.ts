import { describe, expect, test } from "bun:test";
import {
	audioEffectFilterList,
	newAudioEffect,
} from "../../../shared/audio-effects.ts";
import {
	type Asset,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import type { AudioEffect } from "../../../shared/schema/audio-ext.ts";
import {
	BUTTERWORTH_Q_DB,
	createPreviewEffectsInsert,
	previewEffectStages,
	reverbImpulse,
} from "./effects.ts";
import { createPreviewPanInsert } from "./pan.ts";

class Node {
	readonly edges: Node[] = [];
	disconnected = 0;
	constructor(readonly name: string) {}
	connect(target: Node | { value: number }) {
		if (target instanceof Node) {
			this.edges.push(target);
		}
		return target;
	}
	/** Spec behaviour: a targeted disconnect of a missing edge throws. */
	disconnect(target?: Node) {
		this.disconnected++;
		if (target) {
			const index = this.edges.indexOf(target);
			if (index === -1) {
				throw new DOMException("not connected", "InvalidAccessError");
			}
			this.edges.splice(index, 1);
		} else {
			this.edges.length = 0;
		}
	}
}
const param = (value = 0) => ({ value });

class Context {
	readonly created: Node[] = [];
	readonly sampleRate = 1000;
	started = 0;
	stopped = 0;
	private make<T extends object>(name: string, extra: T) {
		const node = Object.assign(new Node(name), extra);
		this.created.push(node);
		return node;
	}
	createGain() {
		return this.make("gain", {
			channelCount: 2,
			channelCountMode: "max",
			channelInterpretation: "speakers",
			gain: param(1),
		});
	}
	createBiquadFilter() {
		return this.make("biquad", {
			frequency: param(),
			gain: param(),
			Q: param(),
			type: "lowpass",
		});
	}
	createDelay() {
		return this.make("delay", { delayTime: param() });
	}
	createConvolver() {
		return this.make("convolver", { buffer: null as unknown });
	}
	createOscillator() {
		return this.make("oscillator", {
			frequency: param(),
			start: () => {
				this.started++;
			},
			stop: () => {
				this.stopped++;
			},
		});
	}
	createChannelSplitter() {
		return this.make("splitter", {});
	}
	createChannelMerger() {
		return this.make("merger", {});
	}
	createBuffer(channels: number, length: number) {
		const data = Array.from(
			{ length: channels },
			() => new Float32Array(length)
		);
		return { getChannelData: (channel: number) => data[channel] };
	}
}

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-0000000000b1",
	kind: "audio",
	name: "Voice",
	width: 0,
};
const clip = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(asset),
	...patch,
});
const effect = (type: AudioEffect["type"]): AudioEffect => newAudioEffect(type);

describe("preview effect stages", () => {
	test("render-only and disabled effects are skipped", () => {
		expect(
			previewEffectStages([
				effect("pitch"),
				effect("robot"),
				{ ...effect("echo"), enabled: false },
			])
		).toEqual([]);
	});

	test("telephone shares the render band", () => {
		expect(previewEffectStages([effect("telephone")])).toEqual([
			{
				frequency: 325,
				gain: 0,
				kind: "filter",
				q: BUTTERWORTH_Q_DB,
				type: "highpass",
			},
			{
				frequency: 325,
				gain: 0,
				kind: "filter",
				q: BUTTERWORTH_Q_DB,
				type: "highpass",
			},
			{
				frequency: 3400,
				gain: 0,
				kind: "filter",
				q: BUTTERWORTH_Q_DB,
				type: "lowpass",
			},
			{
				frequency: 3400,
				gain: 0,
				kind: "filter",
				q: BUTTERWORTH_Q_DB,
				type: "lowpass",
			},
		]);
	});

	test("echo, EQ, and tremolo map to their WebAudio stages", () => {
		expect(
			previewEffectStages([effect("echo"), effect("eq"), effect("tremolo")])
		).toEqual([
			{ delay: 0.26, dry: 0.8 * 0.8, kind: "echo", wet: 0.5 * 0.8 },
			{ frequency: 1000, gain: 3, kind: "filter", q: 1, type: "peaking" },
			{ depth: 0.6, kind: "tremolo", rate: 6.5 },
		]);
	});

	test("echo stage gains mirror the rendered aecho tap", () => {
		for (const amount of [0, 0.3, 1]) {
			const echo = { ...effect("echo"), amount };
			const [filter] = audioEffectFilterList(echo, { rubberband: false });
			const [, inGain, outGain, delayMs, decay] = (filter ?? "")
				.replace("aecho=", "aecho:")
				.split(":")
				.map(Number);
			const [stage] = previewEffectStages([echo]);
			expect(stage).toEqual({
				delay: (delayMs ?? 0) / 1000,
				dry: (inGain ?? 0) * (outGain ?? 0),
				kind: "echo",
				wet: (decay ?? 0) * (outGain ?? 0),
			});
		}
	});

	test("every non-render-only effect yields at least one stage", () => {
		for (const type of [
			"echo",
			"reverb",
			"eq",
			"bass-boost",
			"treble-boost",
			"telephone",
			"radio",
			"chorus",
			"flanger",
			"megaphone",
			"vibrato",
			"tremolo",
		] as const) {
			expect(previewEffectStages([effect(type)]).length).toBeGreaterThan(0);
		}
	});

	test("the reverb impulse is deterministic and decays", () => {
		const context = new Context() as unknown as BaseAudioContext;
		const first = reverbImpulse(context, 0.5).getChannelData(0);
		const second = reverbImpulse(context, 0.5).getChannelData(0);
		expect([...first]).toEqual([...second]);
		expect(Math.abs(first.at(-1) ?? 1)).toBeLessThan(0.001);
	});
});

describe("effects insert", () => {
	test("rebuilds only when the stack changes and stops its oscillators", () => {
		const context = new Context();
		const insert = createPreviewEffectsInsert(
			context as unknown as BaseAudioContext
		);
		const input = new Node("input");
		const output = insert.connect(
			input as unknown as AudioNode
		) as unknown as Node;
		expect(input.edges).toEqual([output]);

		const vibrato = clip({ audioEffects: [effect("vibrato")] });
		insert.update(vibrato);
		expect(context.started).toBe(1);
		expect(input.edges).toHaveLength(1);
		expect(input.edges[0]).not.toBe(output);
		const created = context.created.length;
		insert.update(vibrato);
		expect(context.created).toHaveLength(created);

		insert.update(clip());
		expect(context.stopped).toBe(1);
		expect(input.edges).toEqual([output]);
		insert.dispose();
		expect(output.edges).toEqual([]);
	});

	test("disposes cleanly after the upstream node was disconnected", () => {
		for (const audioEffects of [[], [effect("telephone"), effect("vibrato")]]) {
			const context = new Context();
			const insert = createPreviewEffectsInsert(
				context as unknown as BaseAudioContext
			);
			const input = new Node("input");
			const downstream = new Node("pan");
			const output = insert.connect(
				input as unknown as AudioNode
			) as unknown as Node;
			output.connect(downstream);
			insert.update(clip({ audioEffects }));
			// graph.ts disconnects the source chain before disposing inserts.
			input.disconnect();
			expect(() => insert.dispose()).not.toThrow();
			expect(context.created.every((node) => node.edges.length === 0)).toBe(
				true
			);
			expect(context.stopped).toBe(context.started);
		}
	});

	test("reverb and echo wire dry and wet paths into the output", () => {
		const context = new Context();
		const insert = createPreviewEffectsInsert(
			context as unknown as BaseAudioContext
		);
		const input = new Node("input");
		const output = insert.connect(input as unknown as AudioNode);
		insert.update(clip({ audioEffects: [effect("reverb"), effect("echo")] }));
		expect(context.created.some((node) => node.name === "convolver")).toBe(
			true
		);
		const reachable = new Set<Node>();
		const visit = (node: Node) => {
			if (!reachable.has(node)) {
				reachable.add(node);
				for (const next of node.edges) {
					visit(next);
				}
			}
		};
		visit(input);
		expect(reachable.has(output as unknown as Node)).toBe(true);
	});
});

describe("band filter Q", () => {
	test("highpass/lowpass Q is Butterworth in WebAudio's dB units", () => {
		expect(BUTTERWORTH_Q_DB).toBeCloseTo(-3.0103, 4);
		// Linear Q 10^(dB/20) must be √½: a maximally flat, peak-free response.
		expect(10 ** (BUTTERWORTH_Q_DB / 20)).toBeCloseTo(Math.SQRT1_2, 10);
		for (const type of ["telephone", "radio", "megaphone"] as const) {
			for (const stage of previewEffectStages([effect(type)])) {
				if (stage.kind === "filter") {
					expect(stage.q).toBe(BUTTERWORTH_Q_DB);
				}
			}
		}
	});
});

describe("echo insert", () => {
	test("has a single repeat and no feedback loop", () => {
		const context = new Context();
		const insert = createPreviewEffectsInsert(
			context as unknown as BaseAudioContext
		);
		insert.connect(new Node("input") as unknown as AudioNode);
		insert.update(clip({ audioEffects: [effect("echo")] }));
		const delays = context.created.filter((node) => node.name === "delay");
		expect(delays).toHaveLength(1);
		const [delay] = delays;
		const reachable = new Set<Node>();
		const visit = (node: Node) => {
			for (const next of node.edges) {
				if (!reachable.has(next)) {
					reachable.add(next);
					visit(next);
				}
			}
		};
		if (delay) {
			visit(delay);
		}
		expect(delay && reachable.has(delay)).toBe(false);
	});
});

describe("pan insert", () => {
	test("routes the render's pan matrix through four gains", () => {
		const context = new Context();
		const insert = createPreviewPanInsert(
			context as unknown as BaseAudioContext
		);
		const input = new Node("input");
		expect(
			(insert.connect(input as unknown as AudioNode) as unknown as Node).name
		).toBe("merger");
		const gains = context.created
			.filter((node) => node.name === "gain")
			.slice(1) as unknown as GainNode[];
		const values = () => gains.map((gain) => gain.gain.value);
		expect(values()).toEqual([1, 0, 0, 1]);
		insert.update(clip({ pan: -1 }));
		expect(values()).toEqual([Math.SQRT2, 0, 0, 0]);
		insert.update(clip({ channelMode: "swap" }));
		expect(values()).toEqual([0, 1, 1, 0]);
		insert.update(clip({ channelMode: "mono" }));
		expect(values()).toEqual([0.5, 0.5, 0.5, 0.5]);
		// The effects insert disconnects its output (this insert's input) first.
		input.disconnect();
		expect(() => insert.dispose()).not.toThrow();
		expect(context.created.every((node) => node.edges.length === 0)).toBe(true);
	});
});
