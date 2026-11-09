import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AudioProcessing } from "../../../shared/audio.ts";
import { segmentSchema } from "../../../shared/project.ts";
import * as entry from "../audio-preview.ts";
import { mediaLayerFixtures } from "../preview/__fixtures__/media-layer-segments.ts";
import { createPreviewEffectsInsert } from "./effects.ts";
import { createPreviewMeter } from "./meter.ts";
import { createPreviewPanInsert } from "./pan.ts";
import { scrubPreviewAudio } from "./scrub.ts";
import { previewTempo } from "./tempo.ts";

/** Records the node graph built by `connectPreviewAudio`. */
class FakeNode {
	readonly edges: FakeNode[] = [];
	disconnected = false;
	constructor(readonly name: string) {}
	connect(target: FakeNode) {
		this.edges.push(target);
		return target;
	}
	/** Spec behaviour: a targeted disconnect of a missing edge throws. */
	disconnect(target?: FakeNode) {
		if (target) {
			const index = this.edges.indexOf(target);
			if (index === -1) {
				throw new DOMException("not connected", "InvalidAccessError");
			}
			this.edges.splice(index, 1);
		} else {
			this.edges.length = 0;
		}
		this.disconnected = true;
	}
}
const param = () => ({ value: 0 });
const createdSources: FakeNode[] = [];
class FakeAudioContext {
	readonly destination = new FakeNode("destination");
	state = "running";
	createDynamicsCompressor() {
		return Object.assign(new FakeNode("compressor"), {
			attack: param(),
			knee: param(),
			ratio: param(),
			release: param(),
			threshold: param(),
		});
	}
	createBiquadFilter() {
		return Object.assign(new FakeNode("biquad"), {
			frequency: param(),
			type: "",
		});
	}
	createGain() {
		return Object.assign(new FakeNode("gain"), { gain: param() });
	}
	createChannelSplitter() {
		return new FakeNode("splitter");
	}
	createChannelMerger() {
		return new FakeNode("merger");
	}
	createMediaElementSource() {
		const node = new FakeNode("source");
		createdSources.push(node);
		return node;
	}
}

const previous = Reflect.get(globalThis, "AudioContext");
beforeAll(() => {
	Reflect.set(globalThis, "AudioContext", FakeAudioContext);
});
afterAll(() => {
	Reflect.set(globalThis, "AudioContext", previous);
});

function chainFrom(node: FakeNode): string[] {
	const names = [node.name];
	let current = node.edges[0];
	while (current) {
		names.push(current.name);
		current = current.edges[0];
	}
	return names;
}

const segment = segmentSchema.parse(mediaLayerFixtures[0]?.segment);
const element = (): HTMLMediaElement => ({}) as HTMLMediaElement;

describe("preview audio graph", () => {
	test("keeps the pre-split node chain for every cleanup preset", () => {
		const expected: Record<AudioProcessing, string[]> = {
			denoise: ["source", "biquad", "biquad", "compressor", "gain"],
			none: ["source", "gain"],
			normalize: ["source", "compressor", "gain"],
			"voice-enhance": ["source", "biquad", "biquad", "compressor", "gain"],
		};
		for (const [processing, chain] of Object.entries(expected)) {
			const graph = entry.connectPreviewAudio(
				element(),
				processing as AudioProcessing
			);
			const source = createdSources.at(-1);
			if (!source) {
				throw new Error("no media source was created");
			}
			// Then the effects insert output, the pan matrix (shaper, splitter,
			// L←L gain, merger), the clip gain, the duck gain, and the shared
			// master limiter.
			expect(chainFrom(source)).toEqual([
				...chain.slice(0, -1),
				"gain",
				"gain",
				"splitter",
				"gain",
				"merger",
				"gain",
				"gain",
				"compressor",
				"destination",
			]);
			graph.update(segment);
			expect(() => graph.dispose()).not.toThrow();
			expect(source.disconnected).toBe(true);
			expect((graph.gain as unknown as FakeNode).disconnected).toBe(true);
		}
	});

	test("reuses one context and has no master meter yet", () => {
		expect(entry.previewAudioContext()).toBe(entry.previewAudioContext());
		expect(entry.previewMasterMeter()).toBeNull();
	});
});

describe("stage stubs", () => {
	test("effects and pan inserts route straight through for a plain clip", () => {
		const context = new FakeAudioContext() as unknown as BaseAudioContext;
		for (const insert of [
			createPreviewEffectsInsert(context),
			createPreviewPanInsert(context),
		]) {
			const input = new FakeNode("input");
			const output = insert.connect(input as unknown as AudioNode);
			insert.update(segment);
			expect(chainFrom(input).at(-1)).toBe(
				(output as unknown as FakeNode).name
			);
			insert.dispose();
		}
	});

	test("meter is off and scrubbing is silent", () => {
		const context = new FakeAudioContext();
		expect(
			createPreviewMeter(
				context as unknown as AudioContext,
				context.destination as unknown as AudioNode
			)
		).toBeNull();
		const media = { currentTime: 3 } as HTMLMediaElement;
		scrubPreviewAudio(media, 1, { active: true, audible: true, volume: 1 });
		expect(media.currentTime).toBe(3);
	});

	test("tempo follows the clip speed within browser limits", () => {
		expect(previewTempo(segment)).toEqual({
			muted: false,
			playbackRate: 1,
			preservesPitch: true,
		});
		expect(previewTempo({ ...segment, speed: 2 }).playbackRate).toBe(2);
		expect(previewTempo({ ...segment, speed: 100 }).playbackRate).toBe(16);
	});

	test("the original module path re-exports the split", () => {
		expect(entry.decodePreviewAudio).toBeFunction();
		expect(entry.resumePreviewAudio).toBeFunction();
		expect(entry.previewTempo).toBe(previewTempo);
		expect(entry.scrubPreviewAudio).toBe(scrubPreviewAudio);
	});
});
