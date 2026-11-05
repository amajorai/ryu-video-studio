import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { animatedValue, keyframeGroups, retimeKeyframes } from "./animation.ts";
import {
	audioTempoFilters,
	MAX_PREVIEW_PLAYBACK_RATE,
	MIN_PREVIEW_PLAYBACK_RATE,
	previewPlaybackRate,
} from "./audio.ts";
import {
	effectStackFilters,
	effectStackSchema,
	effectTypeSchema,
} from "./effects.ts";
import { setKeyframes } from "./keyframe-edits.ts";
import { applyLayout, layoutSupported } from "./layouts.ts";
import {
	MAX_CANVAS,
	MAX_OVERLAYS,
	MAX_SEGMENTS,
	MAX_TRACK_INDEX,
	MAX_TRACKS,
	trackIndexSchema,
} from "./limits.ts";
import {
	type Asset,
	animationExpression,
	assetSchema,
	fitEdgeTransitions,
	graphicSchema,
	isRenderableExportCodec,
	isWritableProjectFps,
	keyframeSchema,
	newProject,
	newSegment,
	type Project,
	parseSubtitles,
	projectSchema,
	rippleDeleteRange,
	type Segment,
	segmentSchema,
	snapTimelineTime,
	splitSegment,
	subtitleText,
	titleSchema,
	trackSettingSchema,
	trimSegment,
	validateProject,
} from "./project.ts";
import { adjustmentLayerSchema } from "./schema/adjustment.ts";
import { audioEffectSchema } from "./schema/audio-ext.ts";
import { canvasBackgroundSchema } from "./schema/background.ts";
import {
	captionChunkingSchema,
	captionStyleSchema,
} from "./schema/caption-style.ts";
import { colorGradeSchema, lutRecordSchema } from "./schema/color.ts";
import {
	audioCleanupOf,
	backgroundOf,
	blendModeOf,
	captionStyleOf,
	exportSettingsOf,
	interpolationOf,
	preservePitchOf,
	scaleXOf,
	scaleYOf,
	syncLockedOf,
	trackGainOf,
	trackHiddenOf,
	trackPanOf,
} from "./schema/defaults.ts";
import { exportSettingsSchema } from "./schema/export.ts";
import { keySchema } from "./schema/key.ts";
import { keyframeValueBounds } from "./schema/keyframe.ts";
import { defaultMask, maskSchema } from "./schema/mask.ts";
import { updateProjectSettings } from "./settings.ts";
import { setKeyframes as setKeyframesFromTimeline } from "./timeline-edits.ts";
import { upscaleDimensions } from "./upscale.ts";

const fixtureDir = join(import.meta.dir, "schema", "__fixtures__");
const legacy = JSON.parse(
	readFileSync(join(fixtureDir, "legacy-project.json"), "utf8")
) as { assets: Asset[]; project: Project };
/** Compact serialization of the stored fixture (independent of formatting). */
const legacyText = JSON.stringify(legacy);
const goldenOperations = JSON.parse(
	readFileSync(join(fixtureDir, "legacy-operations.json"), "utf8")
);

const originalRandomUUID = crypto.randomUUID.bind(crypto);
function deterministicIds() {
	let counter = 0;
	crypto.randomUUID = () =>
		`ffffffff-0000-4000-8000-${String(++counter).padStart(12, "0")}` as ReturnType<
			typeof crypto.randomUUID
		>;
}
afterEach(() => {
	crypto.randomUUID = originalRandomUUID;
});

const roundTrip = (value: unknown) =>
	JSON.stringify(projectSchema.parse(value), null, "\t");

function videoAsset(id: string = crypto.randomUUID()): Asset {
	return {
		createdAt: "2026-01-02T03:04:05.000Z",
		duration: 30,
		hasAudio: true,
		height: 1080,
		id,
		kind: "video",
		name: "Clip",
		width: 1920,
	};
}
function audioAsset(): Asset {
	return { ...videoAsset(), height: 0, kind: "audio", name: "Audio", width: 0 };
}

const baseSegment = (patch: Record<string, unknown> = {}) => ({
	...newSegment(videoAsset(), 0, 0),
	...patch,
});
const parses = (
	schema: { safeParse(value: unknown): { success: boolean } },
	value: unknown
) => schema.safeParse(value).success;

describe("legacy round-trip", () => {
	test("the dumped legacy project re-serializes byte-identically", () => {
		const reparsed = JSON.stringify({
			assets: legacy.assets.map((asset) => assetSchema.parse(asset)),
			project: projectSchema.parse(legacy.project),
		});
		expect(reparsed).toBe(legacyText);
		expect(JSON.stringify(validateProject(legacy.project, legacy.assets))).toBe(
			JSON.stringify(legacy.project)
		);
	});

	test("every project the sidecar tests save round-trips byte-identically", () => {
		// Captured from the committed (pre-W0) sidecar suite: every distinct
		// project shape `bun test src` writes to the store, serialized by the
		// committed `projectSchema`, so the widened schema must reproduce it.
		const path = join(fixtureDir, "sidecar-projects.json");
		expect(existsSync(path)).toBe(true);
		const projects = JSON.parse(readFileSync(path, "utf8")) as unknown[];
		expect(projects.length).toBeGreaterThanOrEqual(20);
		for (const project of projects) {
			expect(JSON.stringify(projectSchema.parse(project))).toBe(
				JSON.stringify(project)
			);
		}
	});

	test("render fixtures round-trip byte-identically when present", () => {
		// W0-B owns `sidecar/src/__fixtures__/render`; it joins this check
		// once it lands. The legacy dump is always checked.
		const glob = new Bun.Glob("**/*.json");
		const root = join(import.meta.dir, "..", "sidecar", "src", "__fixtures__");
		const paths = existsSync(root)
			? [...glob.scanSync({ cwd: root, onlyFiles: true })]
			: [];
		for (const path of paths) {
			const value = JSON.parse(readFileSync(join(root, path), "utf8"));
			const candidates = [value, value?.project].filter(
				(candidate) => candidate?.schemaVersion === 1
			);
			for (const candidate of candidates) {
				expect(JSON.stringify(projectSchema.parse(candidate))).toBe(
					JSON.stringify(candidate)
				);
			}
		}
		expect(roundTrip(legacy.project)).toBe(
			JSON.stringify(legacy.project, null, "\t")
		);
	});

	test("extracted helpers reproduce the pre-extraction outputs exactly", () => {
		deterministicIds();
		const project = projectSchema.parse(legacy.project);
		const [video, audio] = project.segments as [Segment, Segment];
		const properties = [
			"x",
			"y",
			"scale",
			"rotation",
			"opacity",
			"volume",
		] as const;
		const actual = {
			animatedValue: properties.map((property) =>
				[0, 0.5, 1.7, 3, 9].map((time) => animatedValue(video, property, time))
			),
			animationExpression: properties.map((property) =>
				animationExpression(video, property, "T")
			),
			audioTempoFilters: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(
				audioTempoFilters
			),
			parseSubtitles: parseSubtitles(
				"1\n00:00:01,000 --> 00:00:02,500\nHi\n\n2\n00:00:03.000 --> 00:00:04.000\nThere\n"
			),
			retime: [
				retimeKeyframes(video, 0.7, 6),
				retimeKeyframes(video, -0.5, 9),
				retimeKeyframes(audio, 1, 5),
			],
			ripple: rippleDeleteRange(project, legacy.assets, 1.5, 3.25),
			snap: [
				snapTimelineTime(0.49, 25, project.markers),
				snapTimelineTime(2.2, 30, project.markers),
				snapTimelineTime(9.99, 24, project.markers, 0.5),
			],
			split: splitSegment(video, 2.2),
			subtitles: [
				subtitleText(project.captions, "srt"),
				subtitleText(project.captions, "vtt"),
			],
			trim: [
				trimSegment(video, 12, "start", 1.3),
				trimSegment(video, 12, "end", -3),
				trimSegment(video, 12, "start", -0.4),
			],
		};
		expect(JSON.parse(JSON.stringify(actual))).toEqual(goldenOperations);
	});

	test("timeline-edits still re-exports setKeyframes", () => {
		expect(setKeyframesFromTimeline).toBe(setKeyframes);
	});
});

describe("limits", () => {
	test("track, segment, overlay and canvas bounds", () => {
		expect(MAX_TRACKS).toBe(32);
		expect(parses(trackIndexSchema, MAX_TRACK_INDEX)).toBe(true);
		expect(parses(trackIndexSchema, MAX_TRACKS)).toBe(false);
		const project = newProject();
		expect(
			parses(projectSchema, { ...project, width: MAX_CANVAS, height: 4320 })
		).toBe(true);
		expect(parses(projectSchema, { ...project, width: MAX_CANVAS + 2 })).toBe(
			false
		);
		expect(
			parses(projectSchema, {
				...project,
				trackSettings: Array.from({ length: MAX_TRACKS }, (_, track) => ({
					locked: false,
					muted: false,
					name: `T${track}`,
					solo: false,
					track,
				})),
			})
		).toBe(true);
		expect(parses(trackSettingSchema, { name: "T", track: 32 })).toBe(false);
		const title = {
			color: "#ffffff",
			end: 1,
			fadeIn: 0,
			fadeOut: 0,
			fontSize: 0.05,
			id: crypto.randomUUID(),
			start: 0,
			text: "T",
			x: 0.5,
			y: 0.5,
		};
		expect(
			parses(projectSchema, {
				...project,
				titles: Array.from({ length: MAX_OVERLAYS }, () => title),
			})
		).toBe(true);
		expect(
			parses(projectSchema, {
				...project,
				titles: Array.from({ length: MAX_OVERLAYS + 1 }, () => title),
			})
		).toBe(false);
		expect(
			parses(projectSchema, {
				...project,
				segments: Array.from({ length: MAX_SEGMENTS + 1 }, () => baseSegment()),
			})
		).toBe(false);
	});

	test("upscales keep their UHD edge and settings use the new canvas bound", () => {
		expect(upscaleDimensions(3000, 2000, 4)).toEqual({
			height: 2560,
			width: 3840,
		});
		const project = newProject();
		expect(
			updateProjectSettings(project, [], {
				height: 4320,
				revision: 0,
				width: 7680,
			})
		).toMatchObject({ height: 4320, width: 7680 });
		expect(
			updateProjectSettings(project, [], { exportCodec: "vp9", revision: 0 })
				.exportCodec
		).toBe("vp9");
		expect(() =>
			updateProjectSettings(project, [], {
				exportCodec: "av1" as "h264",
				revision: 0,
			})
		).toThrow();
	});

	test("5000 one-frame clips on 32 tracks validate in under two seconds", () => {
		const asset = videoAsset();
		const frame = 1 / 24;
		const segments = Array.from({ length: MAX_SEGMENTS }, (_, index) => ({
			...newSegment(
				asset,
				Math.floor(index / MAX_TRACKS) * frame,
				index % MAX_TRACKS
			),
			sourceOut: frame,
		}));
		const started = performance.now();
		const project = validateProject({ ...newProject(), fps: 24, segments }, [
			asset,
		]);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(project.segments).toHaveLength(MAX_SEGMENTS);
	});
});

describe("new field bounds", () => {
	test("asset fields", () => {
		const asset = videoAsset();
		expect(
			parses(assetSchema, { ...asset, frameRate: 1, colorTransfer: "pq" })
		).toBe(true);
		expect(
			parses(assetSchema, { ...asset, frameRate: 240, derivation: "gap-fill" })
		).toBe(true);
		expect(parses(assetSchema, { ...asset, frameRate: 241 })).toBe(false);
		expect(parses(assetSchema, { ...asset, colorTransfer: "srgb" })).toBe(
			false
		);
		expect(
			parses(assetSchema, {
				...asset,
				generation: {
					inputAssetIds: Array.from({ length: 8 }, () => crypto.randomUUID()),
					kind: "image",
					model: "m",
					prompt: "x".repeat(8000),
					provider: "p",
					requestId: "r",
				},
			})
		).toBe(true);
		expect(
			parses(assetSchema, {
				...asset,
				generation: { kind: "image", prompt: "x".repeat(8001) },
			})
		).toBe(false);
		expect(
			parses(assetSchema, {
				...asset,
				generation: {
					inputAssetIds: Array.from({ length: 9 }, () => crypto.randomUUID()),
					kind: "image",
					prompt: "p",
				},
			})
		).toBe(false);
		expect(
			parses(assetSchema, {
				...asset,
				origin: {
					attribution: "Ryu",
					identifier: "sfx-1",
					pageUrl: "https://example.com/sfx",
					provider: "bundled",
					rights: "OFL",
				},
			})
		).toBe(true);
	});

	test("keyframes", () => {
		const frame = {
			id: crypto.randomUUID(),
			property: "maskFeather",
			time: 0,
			value: 0.5,
		};
		expect(
			parses(keyframeSchema, {
				...frame,
				bezier: [0, -1, 1, 2],
				interpolation: "bezier",
				target: "x".repeat(64),
			})
		).toBe(true);
		expect(parses(keyframeSchema, { ...frame, bezier: [1.1, 0, 0, 0] })).toBe(
			false
		);
		expect(parses(keyframeSchema, { ...frame, bezier: [0, -1.1, 0, 0] })).toBe(
			false
		);
		expect(parses(keyframeSchema, { ...frame, target: "x".repeat(65) })).toBe(
			false
		);
		expect(parses(keyframeSchema, { ...frame, interpolation: "spring" })).toBe(
			false
		);
		expect(parses(keyframeSchema, { ...frame, value: 181 })).toBe(false);
		expect(keyframeValueBounds("cropLeft")).toEqual([0, 0.9]);
		expect(keyframeValueBounds("exposure")).toEqual([-3, 3]);
	});

	test("color grade", () => {
		const neutral = colorGradeSchema.parse({});
		expect(
			parses(colorGradeSchema, {
				...neutral,
				blacks: -1,
				curves: {
					master: [
						{ x: 0, y: 0 },
						{ x: 1, y: 1 },
					],
				},
				gain: { b: 1, g: -1, master: 0, r: 0 },
				highlights: 1,
				hsl: [{ band: "aqua", hue: -1, lightness: 1, saturation: 0 }],
				hueVsSat: [],
				look: "Warm film",
				lut: { intensity: 1, lutId: crypto.randomUUID() },
			})
		).toBe(true);
		expect(parses(colorGradeSchema, { highlights: 1.1 })).toBe(false);
		expect(
			parses(colorGradeSchema, {
				curves: {
					red: [
						{ x: 0.5, y: 0 },
						{ x: 0.5, y: 1 },
					],
				},
			})
		).toBe(false);
		expect(
			parses(colorGradeSchema, { curves: { master: [{ x: 0, y: 0 }] } })
		).toBe(false);
		expect(
			parses(colorGradeSchema, {
				hsl: [
					{ band: "red", hue: 0, lightness: 0, saturation: 0 },
					{ band: "red", hue: 0, lightness: 0, saturation: 0 },
				],
			})
		).toBe(false);
		expect(
			parses(colorGradeSchema, {
				lut: { intensity: 1.5, lutId: crypto.randomUUID() },
			})
		).toBe(false);
		expect(
			parses(lutRecordSchema, {
				createdAt: "2026-01-02T03:04:05.000Z",
				id: crypto.randomUUID(),
				name: "Identity",
				size: 65,
			})
		).toBe(true);
		expect(
			parses(lutRecordSchema, {
				createdAt: "2026-01-02T03:04:05.000Z",
				id: crypto.randomUUID(),
				name: "Too big",
				size: 66,
			})
		).toBe(false);
	});

	test("effects", () => {
		expect(effectTypeSchema.options).toHaveLength(24);
		const stack = Array.from({ length: 16 }, () => ({
			amount: 1,
			enabled: true,
			type: "glitch",
		}));
		expect(parses(segmentSchema, baseSegment({ effects: stack }))).toBe(true);
		expect(
			parses(segmentSchema, baseSegment({ effects: [...stack, stack[0]] }))
		).toBe(false);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					effects: [
						{
							amount: 1,
							enabled: true,
							id: crypto.randomUUID(),
							seed: 9999,
							type: "grain",
						},
					],
				})
			)
		).toBe(true);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					effects: [{ amount: 1, enabled: true, seed: 10_000, type: "grain" }],
				})
			)
		).toBe(false);
		for (const type of effectTypeSchema.options) {
			const effects = [{ amount: 1, enabled: true, type }];
			expect(parses(effectStackSchema, effects)).toBe(true);
			expect(effectStackFilters(effects).length).toBeGreaterThan(0);
		}
	});

	test("segment fields", () => {
		expect(parses(segmentSchema, baseSegment({ speed: 0.1 }))).toBe(true);
		expect(parses(segmentSchema, baseSegment({ speed: 100 }))).toBe(true);
		expect(parses(segmentSchema, baseSegment({ speed: 0.09 }))).toBe(false);
		expect(parses(segmentSchema, baseSegment({ speed: 100.1 }))).toBe(false);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					animation: {
						in: "pop",
						inDuration: 5,
						loop: "shake",
						loopPeriod: 0.2,
						out: "blur",
					},
					audioCleanup: {
						denoise: 1,
						enhance: 0,
						normalize: true,
						voiceIsolation: 1,
					},
					audioEffects: Array.from({ length: 8 }, () => ({
						amount: 1,
						enabled: true,
						type: "robot",
					})),
					background: { amount: 1, dim: 0, type: "blur" },
					blendMode: "pin-light",
					channelMode: "swap",
					color: "teal",
					exitDuration: 1,
					exitTransition: "zoom-out",
					fit: "stretch",
					flipH: true,
					flipV: false,
					frameInterpolation: "optical-flow",
					hidden: true,
					key: { color: "#00ff00", type: "chroma" },
					label: "x".repeat(80),
					masks: Array.from({ length: 4 }, () =>
						defaultMask("ellipse", crypto.randomUUID())
					),
					muted: true,
					pan: -1,
					preservePitch: false,
					scaleX: 0.1,
					scaleY: 4,
					speakerId: crypto.randomUUID(),
					transitionIn: { duration: 0.04, softness: 1, type: "barn-v" },
				})
			)
		).toBe(true);
		expect(parses(segmentSchema, baseSegment({ label: "x".repeat(81) }))).toBe(
			false
		);
		expect(parses(segmentSchema, baseSegment({ color: "black" }))).toBe(false);
		expect(parses(segmentSchema, baseSegment({ scaleX: 4.1 }))).toBe(false);
		expect(parses(segmentSchema, baseSegment({ pan: 1.1 }))).toBe(false);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					masks: Array.from({ length: 5 }, () =>
						defaultMask("rectangle", crypto.randomUUID())
					),
				})
			)
		).toBe(false);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					audioEffects: Array.from({ length: 9 }, () => ({
						amount: 1,
						enabled: true,
						type: "robot",
					})),
				})
			)
		).toBe(false);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					transitionIn: { duration: 0.03, softness: 0, type: "dissolve" },
				})
			)
		).toBe(false);
		expect(
			parses(
				segmentSchema,
				baseSegment({
					transitionIn: { duration: 5.1, softness: 0, type: "dissolve" },
				})
			)
		).toBe(false);
		expect(
			parses(segmentSchema, baseSegment({ animation: { loopPeriod: 0.1 } }))
		).toBe(false);
		expect(
			parses(segmentSchema, baseSegment({ audioCleanup: { denoise: 1.1 } }))
		).toBe(false);
		expect(parses(segmentSchema, baseSegment({ track: 32 }))).toBe(false);
		expect(parses(segmentSchema, baseSegment({ track: 31 }))).toBe(true);
	});

	test("masks, keys and audio effects", () => {
		const mask = defaultMask("star", crypto.randomUUID());
		expect(
			parses(maskSchema, {
				...mask,
				cornerRadius: 0.5,
				innerRadius: 0.95,
				points: 12,
			})
		).toBe(true);
		expect(parses(maskSchema, { ...mask, innerRadius: 0.05 })).toBe(false);
		expect(parses(maskSchema, { ...mask, x: 1.1 })).toBe(false);
		expect(parses(maskSchema, { ...mask, width: 2.1 })).toBe(false);
		expect(
			parses(maskSchema, { ...mask, shape: "text", text: undefined })
		).toBe(false);
		expect(parses(maskSchema, defaultMask("text", crypto.randomUUID()))).toBe(
			true
		);
		expect(
			parses(maskSchema, defaultMask("freeform", crypto.randomUUID()))
		).toBe(true);
		expect(
			parses(maskSchema, {
				...defaultMask("freeform", crypto.randomUUID()),
				path: [{ x: 0, y: 0 }],
			})
		).toBe(false);
		expect(parses(keySchema, { lumaHigh: 1, lumaLow: 0, type: "luma" })).toBe(
			true
		);
		expect(
			parses(keySchema, { lumaHigh: 0.2, lumaLow: 0.8, type: "luma" })
		).toBe(false);
		expect(parses(keySchema, { type: "chroma" })).toBe(false);
		expect(
			parses(keySchema, {
				blend: 1,
				color: "#00ff00",
				hueRange: 180,
				similarity: 0.01,
				spill: 1,
				type: "hsv",
			})
		).toBe(true);
		expect(
			parses(keySchema, { color: "#00ff00", similarity: 0, type: "color" })
		).toBe(false);
		expect(
			parses(audioEffectSchema, {
				amount: 0,
				enabled: true,
				frequency: 20_000,
				gainDb: -24,
				semitones: 12,
				type: "eq",
			})
		).toBe(true);
		expect(
			parses(audioEffectSchema, {
				amount: 0,
				enabled: true,
				semitones: 13,
				type: "pitch",
			})
		).toBe(false);
		expect(
			parses(audioEffectSchema, {
				amount: 0,
				enabled: true,
				frequency: 19,
				type: "eq",
			})
		).toBe(false);
	});

	test("titles, graphics and tracks", () => {
		const title = {
			color: "#ffffff",
			end: 2,
			fadeIn: 0,
			fadeOut: 0,
			fontSize: 0.05,
			id: crypto.randomUUID(),
			start: 0,
			text: "T",
			x: 0.5,
			y: 0.5,
		};
		expect(
			parses(titleSchema, {
				...title,
				align: "right",
				animationIn: "word-highlight",
				animationInDuration: 5,
				animationLoop: "wave",
				animationOut: "blur-out",
				backgroundOpacity: 1,
				backgroundPadding: 0.05,
				backgroundRadius: 0.5,
				blendMode: "screen",
				fontFamily: "bebas-neue",
				fontWeight: 900,
				italic: true,
				lane: 7,
				letterSpacing: -0.1,
				lineHeight: 3,
				outlineWidth: 0.02,
				rotation: -180,
				shadowBlur: 10,
				strike: true,
				templateId: "lower-third",
				underline: true,
			})
		).toBe(true);
		expect(parses(titleSchema, { ...title, fontWeight: 950 })).toBe(false);
		expect(parses(titleSchema, { ...title, fontWeight: 450 })).toBe(false);
		expect(parses(titleSchema, { ...title, lane: 8 })).toBe(false);
		expect(parses(titleSchema, { ...title, fontFamily: "comic-sans" })).toBe(
			false
		);
		expect(parses(titleSchema, { ...title, outlineWidth: 0.03 })).toBe(false);
		const graphic = graphicSchema.parse({
			end: 2,
			fill: "#ffffff",
			height: 0.2,
			id: crypto.randomUUID(),
			opacity: 1,
			start: 0,
			width: 0.2,
			x: 0.5,
			y: 0.5,
		});
		expect(
			parses(graphicSchema, {
				...graphic,
				innerRadius: 0.1,
				points: 3,
				shape: "star",
				sides: 12,
				strokeAlign: "inside",
			})
		).toBe(true);
		expect(parses(graphicSchema, { ...graphic, shape: "arrow" })).toBe(true);
		expect(parses(graphicSchema, { ...graphic, sides: 2 })).toBe(false);
		const setting = { name: "T", track: 0 };
		expect(
			parses(trackSettingSchema, {
				...setting,
				gainDb: -60,
				height: "large",
				hidden: true,
				pan: 1,
				syncLocked: false,
			})
		).toBe(true);
		expect(parses(trackSettingSchema, { ...setting, gainDb: 12.1 })).toBe(
			false
		);
		expect(parses(trackSettingSchema, { ...setting, height: "huge" })).toBe(
			false
		);
	});

	test("project fields", () => {
		const project = newProject();
		for (const fps of [23.976, 29.97, 48, 50, 59.94, 120]) {
			expect(parses(projectSchema, { ...project, fps })).toBe(true);
		}
		expect(parses(projectSchema, { ...project, fps: 15 })).toBe(false);
		expect(
			parses(canvasBackgroundSchema, {
				angle: 360,
				color: "#000000",
				color2: "#ffffff",
				type: "gradient",
			})
		).toBe(true);
		expect(
			parses(canvasBackgroundSchema, {
				angle: 361,
				color: "#000000",
				color2: "#ffffff",
				type: "gradient",
			})
		).toBe(false);
		expect(parses(canvasBackgroundSchema, { type: "video" })).toBe(false);
		expect(
			parses(captionStyleSchema, {
				fontSize: 0.12,
				maxLines: 3,
				positionY: 1,
				wordAnimation: "karaoke",
			})
		).toBe(true);
		expect(parses(captionStyleSchema, { fontSize: 0.13 })).toBe(false);
		expect(parses(captionStyleSchema, { maxLines: 4 })).toBe(false);
		expect(
			parses(captionChunkingSchema, {
				closeGaps: 2,
				emoji: true,
				maxChars: 8,
				maxWords: 20,
				minDuration: 0.1,
				mode: "single-word",
				profanity: "mask",
			})
		).toBe(true);
		expect(
			parses(captionChunkingSchema, { maxChars: 121, mode: "words" })
		).toBe(false);
		expect(
			parses(exportSettingsSchema, {
				bitrateKbps: 200_000,
				container: "png-sequence",
				outputHeight: 128,
				outputWidth: MAX_CANVAS,
			})
		).toBe(true);
		expect(
			parses(exportSettingsSchema, { container: "mp4", outputWidth: 1280 })
		).toBe(false);
		expect(
			parses(exportSettingsSchema, {
				container: "mp4",
				outputHeight: 129,
				outputWidth: 128,
			})
		).toBe(false);
		expect(parses(exportSettingsSchema, { container: "mkv" })).toBe(false);
		expect(
			parses(exportSettingsSchema, { container: "gif", gifWidth: 1921 })
		).toBe(false);
		expect(
			parses(adjustmentLayerSchema, {
				end: 2,
				id: crypto.randomUUID(),
				label: "Grade",
				opacity: 1,
				start: 0,
				track: 31,
			})
		).toBe(true);
		expect(
			parses(adjustmentLayerSchema, {
				end: 2,
				id: crypto.randomUUID(),
				label: "Grade",
				opacity: 1.1,
				start: 0,
				track: 0,
			})
		).toBe(false);
		expect(
			parses(projectSchema, {
				...project,
				rippleMarkers: true,
				speakers: Array.from({ length: 16 }, () => ({
					color: "#ffffff",
					id: crypto.randomUUID(),
					label: "S",
				})),
			})
		).toBe(true);
		expect(
			parses(projectSchema, {
				...project,
				speakers: Array.from({ length: 17 }, () => ({
					color: "#ffffff",
					id: crypto.randomUUID(),
					label: "S",
				})),
			})
		).toBe(false);
		expect(
			parses(projectSchema, { ...project, exportCodec: "prores-4444" })
		).toBe(true);
	});
});

describe("validateProject additions", () => {
	const asset = videoAsset();
	const clip = (patch: Partial<Segment> = {}): Segment => ({
		...newSegment(asset, 0, 0),
		sourceOut: 4,
		...patch,
	});
	const check = (patch: Partial<Project>, assets: Asset[] = [asset]) =>
		validateProject({ ...newProject(), ...patch }, assets);

	test("mask IDs are unique per clip", () => {
		const id = crypto.randomUUID();
		expect(() =>
			check({
				segments: [
					clip({
						masks: [defaultMask("rectangle", id), defaultMask("ellipse", id)],
					}),
				],
			})
		).toThrow("Mask IDs must be unique");
		const other = clip({ masks: [defaultMask("rectangle", id)] });
		expect(() =>
			check({
				segments: [
					clip({ masks: [defaultMask("rectangle", id)] }),
					{ ...other, start: 5 },
				],
			})
		).not.toThrow();
	});

	test("speaker references must exist", () => {
		const speakerId = crypto.randomUUID();
		expect(() => check({ segments: [clip({ speakerId })] })).toThrow("speaker");
		expect(() =>
			check({
				captions: [
					{ end: 1, id: crypto.randomUUID(), speakerId, start: 0, text: "Hi" },
				],
			})
		).toThrow("speaker");
		expect(
			check({
				segments: [clip({ speakerId })],
				speakers: [{ color: "#ff0000", id: speakerId, label: "Ana" }],
			}).segments[0]?.speakerId
		).toBe(speakerId);
	});

	test("adjustment layers need increasing time", () => {
		const layer = {
			end: 1,
			id: crypto.randomUUID(),
			label: "Grade",
			opacity: 1,
			start: 1,
			track: 0,
		};
		expect(() => check({ adjustmentLayers: [layer] })).toThrow(
			"adjustment layer"
		);
		expect(
			check({ adjustmentLayers: [{ ...layer, end: 2 }] }).adjustmentLayers
		).toHaveLength(1);
	});

	test("template slots reference existing clips", () => {
		const segment = clip();
		const slot = {
			fixedDuration: false,
			id: crypto.randomUUID(),
			kind: "video" as const,
			label: "Hero",
			segmentId: crypto.randomUUID(),
		};
		expect(() =>
			check({ segments: [segment], template: { slots: [slot] } })
		).toThrow("template slot");
		expect(
			check({
				segments: [segment],
				template: { slots: [{ ...slot, segmentId: segment.id }] },
			}).template?.slots
		).toHaveLength(1);
	});

	test("keys apply only to visual clips", () => {
		const sound = audioAsset();
		expect(() =>
			check(
				{
					segments: [
						{
							...newSegment(sound, 0, 0),
							key: { color: "#00ff00", type: "chroma" },
							sourceOut: 4,
						},
					],
				},
				[sound]
			)
		).toThrow("Keying");
		expect(() =>
			check({ segments: [clip({ key: { color: "#00ff00", type: "chroma" } })] })
		).not.toThrow();
	});

	test("reveal transitions need an overlapping same-track predecessor", () => {
		const transitionIn = {
			duration: 1,
			softness: 0,
			type: "dissolve" as const,
		};
		const first = clip();
		expect(() =>
			check({ segments: [first, clip({ start: 4, transitionIn })] })
		).toThrow("reveal transition");
		expect(() =>
			check({ segments: [first, clip({ start: 3.5, transitionIn })] })
		).toThrow("reveal transition");
		expect(() =>
			check({ segments: [first, clip({ start: 3, track: 1, transitionIn })] })
		).toThrow("reveal transition");
		expect(
			check({ segments: [first, clip({ start: 3, transitionIn })] }).segments
		).toHaveLength(2);
	});

	test("keyframes check targets, interpolation pairs and extended bounds", () => {
		const maskId = crypto.randomUUID();
		const frame = (patch: Partial<Segment["keyframes"][number]>) => ({
			id: crypto.randomUUID(),
			property: "maskX" as const,
			time: 1,
			value: 0.5,
			...patch,
		});
		const masked = (keyframes: Segment["keyframes"]) =>
			check({
				segments: [
					clip({ keyframes, masks: [defaultMask("ellipse", maskId)] }),
				],
			});
		expect(() => masked([frame({ target: maskId })])).not.toThrow();
		expect(() => masked([frame({})])).toThrow("keyframe");
		expect(() => masked([frame({ target: crypto.randomUUID() })])).toThrow(
			"keyframe"
		);
		expect(() =>
			masked([frame({ property: "brightness", target: maskId })])
		).toThrow("keyframe");
		expect(() =>
			masked([frame({ property: "cropLeft", value: 0.95 })])
		).toThrow("keyframe");
		expect(() =>
			masked([frame({ property: "cropLeft", value: 0.5 })])
		).not.toThrow();
		expect(() =>
			masked([frame({ interpolation: "bezier", target: maskId })])
		).toThrow("keyframe");
		expect(() =>
			masked([
				frame({
					bezier: [0.4, 0, 0.2, 1],
					interpolation: "bezier",
					target: maskId,
				}),
			])
		).not.toThrow();
		expect(() =>
			masked([frame({ target: maskId }), frame({ target: maskId })])
		).toThrow("keyframe");
		const effectId = crypto.randomUUID();
		expect(() =>
			check({
				segments: [
					clip({
						effects: [{ amount: 1, enabled: true, id: effectId, type: "blur" }],
						keyframes: [frame({ property: "effectAmount", target: effectId })],
					}),
				],
			})
		).not.toThrow();
	});

	test("multicam audio and layout labels reference members", () => {
		const legacyProject = projectSchema.parse(legacy.project);
		const group = legacyProject.multicamGroups[0]!;
		const withSwitch = (switchPatch: object) => ({
			...legacyProject,
			multicamGroups: [
				{
					...group,
					switches: [
						{ ...group.switches[0]!, ...switchPatch },
						group.switches[1]!,
					],
				},
			],
		});
		expect(() =>
			validateProject(withSwitch({ audio: "A" }), legacy.assets)
		).not.toThrow();
		expect(() =>
			validateProject(withSwitch({ audio: "B" }), legacy.assets)
		).toThrow("microphone");
		expect(() =>
			validateProject(
				withSwitch({
					layout: { angles: ["A", "B"], fit: "fill", layout: "side-by-side" },
				}),
				legacy.assets
			)
		).not.toThrow();
		expect(() =>
			validateProject(
				withSwitch({
					layout: { angles: ["A", "Z"], fit: "fit", layout: "three-up" },
				}),
				legacy.assets
			)
		).toThrow("angle");
	});

	test("background images and avatar lip-sync reference media", () => {
		expect(() =>
			check({ background: { assetId: crypto.randomUUID(), type: "image" } })
		).toThrow("background");
		expect(
			check({ background: { assetId: asset.id, type: "image" } }).background
		).toEqual({ assetId: asset.id, type: "image" });
		const avatar = {
			accent: "#ffffff",
			end: 2,
			height: 0.5,
			id: crypto.randomUUID(),
			outfit: "#000000",
			skin: "#cccccc",
			start: 0,
			width: 0.3,
			x: 0.5,
			y: 0.5,
		};
		expect(() =>
			check({
				avatars: [
					{
						...avatar,
						lipSync: {
							assetId: crypto.randomUUID(),
							sensitivity: 0.5,
							smoothing: 0.5,
						},
					},
				],
			} as Partial<Project>)
		).toThrow("lip-sync");
		expect(() =>
			check({
				avatars: [
					{
						...avatar,
						lipSync: { assetId: asset.id, sensitivity: 0.5, smoothing: 0.5 },
					},
				],
			} as Partial<Project>)
		).not.toThrow();
	});
});

describe("accessors", () => {
	const segment = newSegment(videoAsset());
	const setting = trackSettingSchema.parse({ name: "T", track: 0 });

	test("defaults equal current behaviour", () => {
		expect(blendModeOf(segment)).toBe("normal");
		expect(scaleXOf(segment)).toBe(1);
		expect(scaleYOf({ scaleY: 2 })).toBe(2);
		expect(syncLockedOf(setting)).toBe(true);
		expect(syncLockedOf({ syncLocked: false })).toBe(false);
		expect(trackHiddenOf(setting)).toBe(false);
		expect(trackGainOf(setting)).toBe(0);
		expect(trackPanOf(setting)).toBe(0);
		expect(preservePitchOf(segment)).toBe(true);
		expect(interpolationOf({})).toBe("linear");
	});

	test("audio cleanup maps the legacy processing presets", () => {
		const off = { denoise: 0, enhance: 0, normalize: false, voiceIsolation: 0 };
		expect(audioCleanupOf({ audioProcessing: "none" })).toEqual(off);
		expect(audioCleanupOf({})).toEqual(off);
		expect(audioCleanupOf({ audioProcessing: "denoise" })).toEqual({
			...off,
			denoise: 0.6,
		});
		expect(audioCleanupOf({ audioProcessing: "voice-enhance" })).toEqual({
			...off,
			denoise: 0.4,
			enhance: 0.6,
		});
		expect(audioCleanupOf({ audioProcessing: "normalize" })).toEqual({
			...off,
			normalize: true,
		});
		expect(
			audioCleanupOf({
				audioCleanup: { voiceIsolation: 0.7 },
				audioProcessing: "denoise",
			})
		).toEqual({ ...off, voiceIsolation: 0.7 });
	});

	test("export settings derive from the legacy preset and codec", () => {
		const project = newProject();
		expect(exportSettingsOf(project)).toEqual({
			alpha: false,
			audioBitrateKbps: 192,
			container: "mp4",
			crf: 20,
			encoderPreset: "fast",
			hdr: "off",
			includeAudio: true,
			rateControl: "crf",
		});
		expect(
			exportSettingsOf({
				...project,
				exportCodec: "h265",
				exportPreset: "review",
			})
		).toMatchObject({ crf: 30, encoderPreset: "veryfast" });
		expect(
			exportSettingsOf({ ...project, exportPreset: "social" })
		).toMatchObject({ crf: 21, encoderPreset: "medium" });
		const prores = exportSettingsOf({ ...project, exportCodec: "prores" });
		expect(prores.container).toBe("mov");
		expect(prores.crf).toBeUndefined();
		expect(
			exportSettingsOf({
				...project,
				exportSettings: { container: "webm", crf: 33 },
			})
		).toMatchObject({ container: "webm", crf: 33, encoderPreset: "fast" });
	});

	test("caption style equals the built-in ASS style", () => {
		const style = captionStyleOf({ height: 1080 });
		expect(style).toMatchObject({
			color: "#ffffff",
			fontFamily: "system-sans",
			fontWeight: 700,
			outlineColor: "#000000",
			positionX: 0.5,
			positionY: 0.92,
			shadowDepth: 0,
			wordAnimation: "highlight",
			highlightColor: "#ffd43b",
		});
		// Style: Default,Arial,round(h*0.045),...,Outline 2,...,MarginV round(h*0.08)
		expect(Math.round(1080 * style.fontSize)).toBe(Math.round(1080 * 0.045));
		expect(style.outlineWidth * 1080).toBeCloseTo(2);
		expect(
			captionStyleOf({ captionStyle: { fontSize: 0.06 }, height: 720 }).fontSize
		).toBe(0.06);
	});

	test("background follows the style profile", () => {
		expect(backgroundOf(newProject())).toEqual({
			color: "#000000",
			type: "color",
		});
		expect(backgroundOf({ styleProfile: "flat-motion" })).toEqual({
			color: "#17132b",
			type: "color",
		});
		expect(
			backgroundOf({
				background: { amount: 0.5, dim: 0.2, type: "blur" },
				styleProfile: "cinematic",
			})
		).toEqual({ amount: 0.5, dim: 0.2, type: "blur" });
	});
});

describe("audio tempo", () => {
	const product = (filters: string[]) =>
		filters.reduce((total, filter) => total * Number(filter.split("=")[1]), 1);
	test.each([0.1, 0.13, 0.25, 4, 7.5, 100])("chains atempo for %p", (speed) => {
		const filters = audioTempoFilters(speed);
		expect(filters.every((filter) => /^atempo=[\d.]+$/.test(filter))).toBe(
			true
		);
		for (const filter of filters) {
			const factor = Number(filter.split("=")[1]);
			expect(factor).toBeGreaterThanOrEqual(0.5);
			expect(factor).toBeLessThanOrEqual(2);
		}
		expect(product(filters)).toBeCloseTo(speed, 9);
	});
	test("1x bypasses atempo and out-of-range speeds throw", () => {
		expect(audioTempoFilters(1)).toEqual(["anull"]);
		expect(() => audioTempoFilters(0.09)).toThrow("Invalid audio speed.");
		expect(() => audioTempoFilters(101)).toThrow("Invalid audio speed.");
	});
});

describe("extended keyframes", () => {
	const maskId = crypto.randomUUID();
	const otherMask = crypto.randomUUID();
	const segment = (): Segment => ({
		...newSegment(videoAsset(), 0, 0),
		brightness: 0.2,
		keyframes: [
			{ id: crypto.randomUUID(), property: "opacity", time: 2, value: 0.5 },
			{
				id: crypto.randomUUID(),
				property: "maskX",
				target: maskId,
				time: 0,
				value: -1,
			},
			{
				id: crypto.randomUUID(),
				property: "maskX",
				target: maskId,
				time: 4,
				value: 1,
			},
			{
				id: crypto.randomUUID(),
				property: "maskX",
				target: otherMask,
				time: 4,
				value: 0.5,
			},
			{
				id: crypto.randomUUID(),
				interpolation: "hold",
				property: "brightness",
				time: 4,
				value: 1,
			},
		],
		masks: [
			defaultMask("ellipse", maskId),
			{ ...defaultMask("rectangle", otherMask), x: -0.5 },
		],
		sourceOut: 8,
	});

	test("channels group by property and target in enum order", () => {
		expect(keyframeGroups(segment().keyframes)).toEqual([
			{ property: "opacity" },
			{ property: "brightness" },
			{ property: "maskX", target: maskId },
			{ property: "maskX", target: otherMask },
		]);
	});

	test("base values come from the clip, its masks and effects", () => {
		const value = segment();
		expect(animatedValue(value, "brightness", 2)).toBeCloseTo(0.6);
		expect(animatedValue(value, "maskX", 2, otherMask)).toBeCloseTo(0);
		expect(animatedValue(value, "maskX", 2, maskId)).toBeCloseTo(0);
		expect(animatedValue(value, "scaleX", 1)).toBe(1);
		expect(
			animatedValue(
				{ ...value, crop: { bottom: 0, left: 0.3, right: 0, top: 0 } },
				"cropLeft",
				1
			)
		).toBe(0.3);
	});

	test("retiming re-bases every targeted channel", () => {
		const frames = retimeKeyframes(segment(), 2, 6);
		const otherAtZero = frames.find(
			(frame) => frame.target === otherMask && frame.time === 0
		);
		expect(otherAtZero?.value).toBeCloseTo(0);
		const brightness = frames.filter(
			(frame) => frame.property === "brightness"
		);
		expect(brightness.map((frame) => frame.time)).toEqual([0, 2]);
		expect(brightness[0]?.value).toBeCloseTo(0.6);
		const maskFrames = frames.filter((frame) => frame.target === maskId);
		expect(maskFrames.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0],
			[2, 1],
		]);
	});

	test("splitting keeps non-legacy channels continuous in the tail", () => {
		const [head, tail] = splitSegment(segment(), 2);
		const tailMask = tail.keyframes.find(
			(frame) => frame.target === maskId && frame.time === 0
		);
		expect(tailMask?.value).toBeCloseTo(0);
		expect(animatedValue(tail, "brightness", 0)).toBeCloseTo(0.6);
		expect(tail.opacity).toBeCloseTo(0.5);
		expect(head.keyframes.filter((frame) => frame.time === 2)).toHaveLength(4);
		const asset = videoAsset(tail.assetId);
		expect(() =>
			validateProject({ ...newProject(), segments: [head, tail] }, [asset])
		).not.toThrow();
	});

	test("ripple delete keeps targeted keyframes and overlay keyframes valid", () => {
		const asset = videoAsset();
		const clip = { ...segment(), assetId: asset.id };
		const titleId = crypto.randomUUID();
		const project = validateProject(
			{
				...newProject(),
				adjustmentLayers: [
					{
						end: 6,
						id: crypto.randomUUID(),
						keyframes: [
							{
								id: crypto.randomUUID(),
								property: "opacity",
								time: 5,
								value: 0,
							},
						],
						label: "Grade",
						opacity: 1,
						start: 0,
						track: 0,
					},
				],
				segments: [clip],
				template: {
					slots: [
						{
							fixedDuration: true,
							id: crypto.randomUUID(),
							kind: "video",
							label: "Hero",
							segmentId: clip.id,
						},
					],
				},
				titles: [
					{
						animation: "fade",
						color: "#ffffff",
						end: 6,
						fadeIn: 0,
						fadeOut: 0,
						fontSize: 0.05,
						id: titleId,
						keyframes: [
							{ id: crypto.randomUUID(), property: "x", time: 5.5, value: 0.2 },
						],
						start: 0,
						text: "T",
						x: 0.5,
						y: 0.5,
					},
				],
			},
			[asset]
		);
		const rippled = rippleDeleteRange(project, [asset], 1, 3);
		expect(rippled.titles[0]?.keyframes?.[0]?.time).toBeCloseTo(3.5);
		expect(rippled.adjustmentLayers?.[0]).toMatchObject({ end: 4, start: 0 });
		expect(rippled.template?.slots).toHaveLength(1);
		const removed = rippleDeleteRange(project, [asset], 0, 8);
		expect(removed.template?.slots).toEqual([]);
	});
});

describe("layouts", () => {
	test("new layout names parse and apply with their slot tables", () => {
		const asset = videoAsset();
		const clips = [0, 1, 2].map((track) => newSegment(asset, 0, track));
		const project = { ...newProject(), segments: clips };
		expect(layoutSupported("three-up")).toBe(true);
		expect(layoutSupported("grid-2x2")).toBe(true);
		const applied = applyLayout(
			project,
			clips.map((clip) => clip.id),
			"three-up"
		);
		expect(applied.segments).toHaveLength(3);
	});
});

describe("edge transitions survive cuts", () => {
	const asset = videoAsset();
	const clipAt = (start: number, patch: Partial<Segment> = {}): Segment => ({
		...newSegment(asset, start, 0),
		sourceOut: 10,
		...patch,
	});
	const reveal = { duration: 1, softness: 0, type: "dissolve" } as const;
	const withReveal = () => {
		const a = clipAt(0);
		const b = clipAt(9, { transitionIn: reveal });
		return validateProject({ ...newProject(), segments: [a, b] }, [asset]);
	};
	const withExit = () =>
		validateProject(
			{
				...newProject(),
				segments: [clipAt(0, { exitDuration: 3, exitTransition: "crossfade" })],
			},
			[asset]
		);

	test("split keeps the reveal only on the head piece", () => {
		const project = withReveal();
		const b = project.segments[1] as Segment;
		const [left, right] = splitSegment(b, 14);
		expect(left.transitionIn).toEqual(reveal);
		expect("transitionIn" in right).toBe(false);
		expect(() =>
			validateProject(
				{ ...project, segments: [project.segments[0] as Segment, left, right] },
				[asset]
			)
		).not.toThrow();
	});

	test("split keeps the exit only on the tail piece, clamped", () => {
		const project = withExit();
		const [left, right] = splitSegment(project.segments[0] as Segment, 1);
		expect("exitTransition" in left).toBe(false);
		expect("exitDuration" in left).toBe(false);
		expect(right).toMatchObject({
			exitDuration: 3,
			exitTransition: "crossfade",
		});
		const [short, tail] = splitSegment(project.segments[0] as Segment, 8);
		expect(tail.exitDuration).toBeCloseTo(2);
		expect(() =>
			validateProject({ ...project, segments: [short, tail] }, [asset])
		).not.toThrow();
	});

	test("ripple delete through a reveal or exit clip stays valid", () => {
		const reveals = rippleDeleteRange(withReveal(), [asset], 12, 13);
		const tails = reveals.segments.filter((s) => s.start > 9);
		expect(tails.every((s) => s.transitionIn === undefined)).toBe(true);
		expect(reveals.segments.some((s) => s.transitionIn)).toBe(true);
		const exits = rippleDeleteRange(withExit(), [asset], 2, 9);
		expect(exits.segments).toHaveLength(2);
		const [head, tail] = exits.segments as [Segment, Segment];
		expect(head.exitTransition).toBeUndefined();
		expect(tail).toMatchObject({ exitTransition: "crossfade" });
		expect(tail.exitDuration).toBeCloseTo(1);
	});

	test("a cut that removes the head clamps the reveal to the piece", () => {
		const piece = { ...clipAt(9, { transitionIn: reveal }), sourceOut: 0.5 };
		expect(fitEdgeTransitions(piece, true, true).transitionIn?.duration).toBe(
			0.5
		);
	});

	test("legacy clips pass through untouched", () => {
		const clip = clipAt(0);
		expect(fitEdgeTransitions(clip, false, false)).toBe(clip);
	});
});

describe("preview playback rate", () => {
	test.each([
		[0.1, 0.1],
		[1, 1],
		[16, 16],
		[20, MAX_PREVIEW_PLAYBACK_RATE],
		[100, MAX_PREVIEW_PLAYBACK_RATE],
		[0.01, MIN_PREVIEW_PLAYBACK_RATE],
		[Number.NaN, 1],
	])("clamps %p to %p", (speed, rate) => {
		expect(previewPlaybackRate(speed)).toBe(rate);
	});
});

describe("formerly gated schema values", () => {
	const base = () => ({ ...newProject(), segments: [] });
	test.each([
		"h264",
		"h265",
		"prores",
		"h265-10bit",
		"prores-4444",
		"vp9",
	] as const)("export codec %p is renderable and writable", (codec) => {
		expect(isRenderableExportCodec(codec)).toBe(true);
		expect(
			validateProject({ ...base(), exportCodec: codec }, []).exportCodec
		).toBe(codec);
	});
	test.each([
		23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120,
	] as const)("frame rate %p is writable", (fps) => {
		expect(isWritableProjectFps(fps)).toBe(true);
		expect(validateProject({ ...base(), fps }, []).fps).toBe(fps);
	});
});

describe("settings presets", () => {
	test("quality presets still fit inside 3840 while explicit sizes reach MAX_CANVAS", () => {
		const project = validateProject({ ...newProject(), segments: [] }, []);
		const wide = updateProjectSettings(project, [], {
			aspectRatio: "2.4:1",
			quality: "4K",
			revision: project.revision,
		});
		expect({ height: wide.height, width: wide.width }).toEqual({
			height: 1600,
			width: 3840,
		});
		const explicit = updateProjectSettings(project, [], {
			height: 4320,
			revision: project.revision,
			width: MAX_CANVAS,
		});
		expect(explicit.width).toBe(MAX_CANVAS);
	});
});
