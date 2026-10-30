import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import { audioCleanupOf } from "../../../shared/schema/defaults.ts";
import { segmentAudioFilters } from "../render-segment-audio.ts";
import { cleanupFilters } from "./audio-cleanup.ts";
import { audioEffectFilters } from "./audio-effects.ts";
import {
	type AudioRenderEnvironment,
	materializeModel,
	staticAudioEnvironment,
} from "./audio-environment.ts";
import { clipPanFilters } from "./audio-pan.ts";

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: true,
	height: 0,
	id: "00000000-0000-4000-8000-000000000002",
	kind: "audio",
	name: "Voice",
	width: 0,
};
const clip = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(asset),
	...patch,
});

/** Fails the test if a stage probes the machine when it should not. */
const untouched: AudioRenderEnvironment = {
	hasFilter() {
		throw new Error("probed filters");
	},
	rnnoiseModel() {
		throw new Error("resolved model");
	},
};
const full = staticAudioEnvironment({ arnndn: true, rubberband: true });
const bare = staticAudioEnvironment({});

describe("cleanup stage", () => {
	test("legacy presets keep their exact chains without probing", () => {
		expect(cleanupFilters(clip(), untouched)).toEqual(["anull"]);
		expect(
			cleanupFilters(clip({ audioProcessing: "normalize" }), untouched)
		).toEqual(["loudnorm=I=-16:TP=-1.5:LRA=11"]);
	});

	test("graded cleanup renders isolation with the bundled model", () => {
		const segment = clip({
			audioCleanup: { denoise: 0.5, voiceIsolation: 0.8 },
			audioProcessing: "normalize",
		});
		expect(audioCleanupOf(segment).normalize).toBe(false);
		expect(cleanupFilters(segment, full)).toEqual([
			"afftdn=nr=18:nf=-40",
			"arnndn=m=/models/rnnoise.rnnn:mix=0.8",
		]);
		expect(cleanupFilters(segment, bare)).toEqual(["afftdn=nr=18:nf=-40"]);
	});

	test("graded cleanup without isolation never probes", () => {
		expect(
			cleanupFilters(clip({ audioCleanup: { normalize: true } }), untouched)
		).toEqual(["loudnorm=I=-16:TP=-1.5:LRA=11"]);
	});
});

describe("effects stage", () => {
	test("no effects and non-pitch stacks never probe", () => {
		expect(audioEffectFilters(clip(), untouched)).toEqual([]);
		expect(
			audioEffectFilters(
				clip({
					audioEffects: [{ amount: 0.5, enabled: true, type: "tremolo" }],
				}),
				untouched
			)
		).toEqual(["tremolo=f=6.5:d=0.6"]);
	});

	test("pitch falls back when rubberband is missing", () => {
		const segment = clip({
			audioEffects: [
				{ amount: 0.5, enabled: true, semitones: 12, type: "pitch" },
			],
		});
		expect(audioEffectFilters(segment, full)).toEqual(["rubberband=pitch=2"]);
		expect(audioEffectFilters(segment, bare)).toEqual([
			"aresample=48000",
			"asetrate=96000",
			"aresample=48000",
			"atempo=0.5",
		]);
	});
});

describe("pan stage", () => {
	test("static pan and channel mode", () => {
		expect(clipPanFilters(clip())).toEqual([]);
		expect(clipPanFilters(clip({ channelMode: "right", pan: 0 }))).toEqual([
			"aformat=channel_layouts=stereo",
			"pan=stereo|c0=1*c1|c1=1*c1",
		]);
	});

	test("keyframed pan becomes an aeval expression", () => {
		const segment = clip({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000010",
					property: "pan",
					time: 0,
					value: -1,
				},
				{
					id: "00000000-0000-4000-8000-000000000011",
					property: "pan",
					time: 2,
					value: 1,
				},
			],
		});
		const filters = clipPanFilters(segment);
		expect(filters[0]).toBe("aformat=channel_layouts=stereo");
		expect(filters[1]).toStartWith("aeval=exprs='sqrt(2)*cos(");
		expect(filters[1]).toContain("if(lt(t,2),-1+(2)*max(0,(t-0))/2,1)");
	});
});

test("the clip chain places effects before volume and pan after it", () => {
	const segment = clip({
		audioEffects: [{ amount: 0.5, enabled: true, type: "vibrato" }],
		pan: 1,
	});
	const project = newProject("Audio chain");
	project.segments = [segment];
	const [chain] = segmentAudioFilters({
		length: 4,
		n: 0,
		p: project,
		s: segment,
		visualize: false,
	});
	expect(chain).toContain("anull,vibrato=f=6:d=0.5,volume=");
	expect(chain).toContain(
		":eval=frame,aformat=channel_layouts=stereo,pan=stereo|c0=0*c0|c1=1.4142*c1"
	);
});

test("materialized models are verified, replaced atomically, and kept private", () => {
	// POSIX permission bits only: Windows reports no group/other bits, and
	// `assertPrivateDirectory` checks them only off Windows.
	const posixModes = process.platform !== "win32";
	const root = mkdtempSync(join(tmpdir(), "ryu-rnnoise-cache-test-"));
	try {
		const virtualDir = join(root, "~BUN");
		mkdirSync(virtualDir);
		const embedded = join(virtualDir, "model.rnnn");
		writeFileSync(embedded, "rnnoise-nu model file version 1\nweights\n");
		const cache = join(root, "cache");

		const first = materializeModel(embedded, cache);
		expect(first).not.toBe(embedded);
		if (posixModes) {
			expect(statSync(cache).mode & 0o777).toBe(0o700);
		}
		expect(readFileSync(first, "utf8")).toContain("weights");

		// A truncated or planted file is replaced, never trusted.
		writeFileSync(first, "garbage");
		expect(materializeModel(embedded, cache)).toBe(first);
		expect(readFileSync(first, "utf8")).toContain("weights");

		// A planted symlink is replaced by the rename, not written through.
		const victim = join(root, "victim.txt");
		writeFileSync(victim, "untouched");
		rmSync(first);
		symlinkSync(victim, first);
		expect(materializeModel(embedded, cache)).toBe(first);
		expect(lstatSync(first).isSymbolicLink()).toBe(false);
		expect(readFileSync(victim, "utf8")).toBe("untouched");
		expect(readdirSync(cache).filter((name) => name.endsWith(".tmp"))).toEqual(
			[]
		);

		// A directory other users can write into is refused.
		if (posixModes) {
			const shared = join(root, "shared");
			mkdirSync(shared);
			chmodSync(shared, 0o777);
			expect(() => materializeModel(embedded, shared)).toThrow(
				"accessible to other users"
			);
		}

		// Without a directory, each process gets its own private one.
		const own = materializeModel(embedded);
		if (posixModes) {
			expect(statSync(dirname(own)).mode & 0o777).toBe(0o700);
		}
		expect(materializeModel(embedded)).toBe(own);
		rmSync(dirname(own), {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	} finally {
		rmSync(root, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("materializing copies only virtual model paths", () => {
	const directory = mkdtempSync(join(tmpdir(), "ryu-rnnoise-test-"));
	try {
		const source = join(directory, "model.rnnn");
		writeFileSync(source, "rnnoise-nu model file version 1\n");
		expect(materializeModel(source, join(directory, "cache"))).toBe(source);
		const bundled = fileURLToPath(
			new URL("../../assets/rnnoise/somnolent-hogwash.rnnn", import.meta.url)
		);
		expect(readFileSync(bundled, "utf8")).toStartWith(
			"rnnoise-nu model file version 1"
		);
	} finally {
		rmSync(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
