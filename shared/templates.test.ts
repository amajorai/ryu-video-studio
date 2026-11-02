import { describe, expect, test } from "bun:test";
import { detachClipAudio } from "./detach-audio.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	segmentDuration,
	trimSegment,
	validateProject,
} from "./project.ts";
import { clipHeard } from "./sync-lock.ts";
import {
	buildTemplateProject,
	fillTemplate,
	instantiateTemplateRequestSchema,
	saveTemplateRequestSchema,
	slotAccepts,
	summarizeTemplate,
} from "./templates.ts";

const createdAt = new Date(0).toISOString();

function asset(
	kind: Asset["kind"],
	duration: number,
	name: string = kind
): Asset {
	return {
		createdAt,
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 1280,
	};
}

/** A project with three 2 s video clips at 0, 2 and 4 plus a fixed title. */
function source() {
	const footage = asset("video", 30, "footage");
	const song = asset("audio", 60, "song");
	const clips = [0, 2, 4].map((start) => ({
		...newSegment(footage, start),
		sourceIn: 5,
		sourceOut: 7,
		fadeIn: 0.25,
		effects: [],
	}));
	const music = { ...newSegment(song, 0, 2), sourceOut: 6, volume: 0.4 };
	const project: Project = {
		...newProject("Promo"),
		segments: [...clips, music],
		titles: [
			{
				animation: "fade",
				color: "#ffffff",
				end: 2,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.08,
				id: crypto.randomUUID(),
				start: 0,
				text: "Fixed title",
				x: 0.5,
				y: 0.5,
			},
		],
	};
	return { assets: [footage, song], clips, music, project };
}

function template() {
	const fixture = source();
	const built = buildTemplateProject(fixture.project, fixture.assets, {
		slots: [
			{ segmentId: fixture.clips[2]?.id ?? "" },
			{ segmentId: fixture.clips[0]?.id ?? "", label: "Hook" },
			{ segmentId: fixture.clips[1]?.id ?? "" },
		],
	});
	return { ...fixture, built };
}

describe("request schemas", () => {
	test("save-template needs a revision and at least one slot", () => {
		expect(
			saveTemplateRequestSchema.safeParse({ slots: [], revision: 0 }).success
		).toBe(false);
		expect(
			saveTemplateRequestSchema.safeParse({
				slots: [{ segmentId: crypto.randomUUID() }],
			}).success
		).toBe(false);
		expect(
			saveTemplateRequestSchema.safeParse({
				slots: [{ segmentId: crypto.randomUUID() }],
				revision: 3,
				extra: true,
			}).success
		).toBe(false);
	});

	test("instantiate is strict and bounds the media list", () => {
		expect(
			instantiateTemplateRequestSchema.safeParse({
				templateId: crypto.randomUUID(),
				assetIds: Array.from({ length: 101 }, () => crypto.randomUUID()),
			}).success
		).toBe(false);
		expect(
			instantiateTemplateRequestSchema.safeParse({
				templateId: crypto.randomUUID(),
				assetIds: [],
			}).success
		).toBe(true);
	});
});

describe("slotAccepts", () => {
	test("visual slots take stills or video, audio slots only audio", () => {
		expect(slotAccepts("video", "image")).toBe(true);
		expect(slotAccepts("image", "video")).toBe(true);
		expect(slotAccepts("video", "audio")).toBe(false);
		expect(slotAccepts("audio", "video")).toBe(false);
		expect(slotAccepts("audio", "audio")).toBe(true);
		expect(slotAccepts("any", "audio")).toBe(true);
	});
});

describe("buildTemplateProject", () => {
	test("orders slots by timeline position and labels them per kind", () => {
		const { assets, built, clips } = template();
		expect(built.title).toBe("Promo template");
		expect(built.template?.slots.map((slot) => slot.segmentId)).toEqual(
			clips.map((clip) => clip.id)
		);
		expect(built.template?.slots.map((slot) => slot.label)).toEqual([
			"Hook",
			"Video 2",
			"Video 3",
		]);
		expect(built.template?.slots.every((slot) => slot.fixedDuration)).toBe(
			true
		);
		expect(() => validateProject(built, assets)).not.toThrow();
	});

	test("keeps placeholders and fixed content unchanged", () => {
		const { built, project } = template();
		expect(built.segments).toEqual(project.segments);
		expect(built.titles).toEqual(project.titles);
	});

	test("rejects duplicate, missing and multicam clips", () => {
		const { assets, clips, project } = source();
		const id = clips[0]?.id ?? "";
		expect(() =>
			buildTemplateProject(project, assets, {
				slots: [{ segmentId: id }, { segmentId: id }],
			})
		).toThrow("only once");
		expect(() =>
			buildTemplateProject(project, assets, {
				slots: [{ segmentId: crypto.randomUUID() }],
			})
		).toThrow("missing clip");
		const grouped: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === id
					? { ...segment, multicamGroupId: crypto.randomUUID() }
					: segment
			),
		};
		expect(() =>
			buildTemplateProject(grouped, assets, { slots: [{ segmentId: id }] })
		).toThrow("multicam");
	});

	test("records description and category", () => {
		const { assets, clips, project } = source();
		const built = buildTemplateProject(project, assets, {
			slots: [{ segmentId: clips[0]?.id ?? "", fixedDuration: false }],
			title: "Mine",
			description: " Three cuts ",
			category: "Promo",
		});
		expect(built.title).toBe("Mine");
		expect(built.template?.description).toBe("Three cuts");
		expect(built.template?.category).toBe("Promo");
		expect(built.template?.slots[0]?.fixedDuration).toBe(false);
	});
});

describe("summarizeTemplate", () => {
	test("lists slot timing and the content length", () => {
		const { built } = template();
		const summary = summarizeTemplate(built, false);
		expect(summary.duration).toBe(6);
		expect(summary.slots.map((slot) => [slot.start, slot.duration])).toEqual([
			[0, 2],
			[2, 2],
			[4, 2],
		]);
		expect(() => summarizeTemplate(source().project, false)).toThrow(
			"not a template"
		);
	});
});

describe("fillTemplate", () => {
	test("fills every slot in order and trims long media to the slot", () => {
		const { assets, built } = template();
		const media = [asset("video", 20), asset("image", 5), asset("video", 10)];
		const library = [...assets, ...media];
		const result = fillTemplate(
			built,
			library,
			media.map((item) => item.id)
		);
		expect(result.unfilledSlotIds).toEqual([]);
		expect(result.unusedAssetIds).toEqual([]);
		expect(result.adjustments).toEqual([]);
		expect(result.project.template).toBeUndefined();
		const filled = built.template?.slots.map((slot) =>
			result.project.segments.find((segment) => segment.id === slot.segmentId)
		);
		expect(filled?.map((segment) => segment?.assetId)).toEqual(
			media.map((item) => item.id)
		);
		for (const segment of filled ?? []) {
			expect(segment?.sourceIn).toBe(0);
			expect(segmentDuration(segment ?? built.segments[0]!)).toBeCloseTo(2);
			expect(segment?.fadeIn).toBe(0.25);
		}
		expect(result.project.titles).toEqual(built.titles);
		expect(() => validateProject(result.project, library)).not.toThrow();
	});

	test("fewer assets leave the later slots on their placeholders", () => {
		const { assets, built } = template();
		const only = asset("video", 10);
		const result = fillTemplate(built, [...assets, only], [only.id]);
		const [first, ...rest] = built.template?.slots ?? [];
		expect(result.assignments).toEqual([
			{ slotId: first?.id ?? "", assetId: only.id },
		]);
		expect(result.unfilledSlotIds).toEqual(rest.map((slot) => slot.id));
		for (const slot of rest) {
			expect(
				result.project.segments.find((segment) => segment.id === slot.segmentId)
			).toEqual(
				built.segments.find((segment) => segment.id === slot.segmentId)
			);
		}
	});

	test("more assets than slots report the extras unused", () => {
		const { assets, built } = template();
		const media = Array.from({ length: 5 }, () => asset("image", 5));
		const result = fillTemplate(
			built,
			[...assets, ...media],
			media.map((item) => item.id)
		);
		expect(result.assignments).toHaveLength(3);
		expect(result.unusedAssetIds).toEqual(
			media.slice(3).map((item) => item.id)
		);
	});

	test("media of the wrong kind skips to the next slot that accepts it", () => {
		const fixture = source();
		const built = buildTemplateProject(fixture.project, fixture.assets, {
			slots: [
				{ segmentId: fixture.clips[0]?.id ?? "" },
				{ segmentId: fixture.music.id },
			],
		});
		const voice = asset("audio", 3);
		const photo = asset("image", 5);
		const result = fillTemplate(
			built,
			[...fixture.assets, voice, photo],
			[voice.id, photo.id]
		);
		const music = result.project.segments.find(
			(segment) => segment.id === fixture.music.id
		);
		expect(music?.assetId).toBe(voice.id);
		// Audio is never retimed: the 3 s voice is shorter than the 6 s slot.
		expect(music?.sourceOut).toBe(3);
		expect(music?.volume).toBe(0.4);
		expect(result.adjustments).toEqual([
			{ segmentId: fixture.music.id, change: "short" },
		]);
		expect(
			result.project.segments.find(
				(segment) => segment.id === fixture.clips[0]?.id
			)?.assetId
		).toBe(photo.id);
	});

	test("short video is slowed to keep a fixed slot length", () => {
		const { assets, built, clips } = template();
		const short = asset("video", 1);
		const result = fillTemplate(built, [...assets, short], [short.id]);
		const segment = result.project.segments.find(
			(item) => item.id === clips[0]?.id
		);
		expect(segment?.speed).toBeCloseTo(0.5);
		expect(segmentDuration(segment ?? clips[0]!)).toBeCloseTo(2);
		expect(result.adjustments).toEqual([
			{ segmentId: clips[0]?.id ?? "", change: "retimed" },
		]);
	});

	test("retiming stops at the minimum speed and reports a short clip", () => {
		const { assets, built, clips } = template();
		const tiny = asset("video", 0.1);
		const result = fillTemplate(built, [...assets, tiny], [tiny.id]);
		const segment = result.project.segments.find(
			(item) => item.id === clips[0]?.id
		);
		expect(segment?.speed).toBe(0.1);
		expect(segmentDuration(segment ?? clips[0]!)).toBeCloseTo(1);
		expect(result.adjustments[0]?.change).toBe("short");
		expect(() =>
			validateProject(result.project, [...assets, tiny])
		).not.toThrow();
	});

	test("a flexible slot ends early and clamps its fades and keyframes", () => {
		const fixture = source();
		const clip = fixture.clips[0];
		if (!clip) {
			throw new Error("Missing clip.");
		}
		const project: Project = {
			...fixture.project,
			segments: fixture.project.segments.map((segment) =>
				segment.id === clip.id
					? {
							...segment,
							fadeIn: 0.8,
							fadeOut: 0.8,
							keyframes: [
								{
									id: crypto.randomUUID(),
									property: "opacity",
									time: 1.5,
									value: 0.5,
								},
							],
						}
					: segment
			),
		};
		const built = buildTemplateProject(project, fixture.assets, {
			slots: [{ segmentId: clip.id, fixedDuration: false }],
		});
		const short = asset("video", 1);
		const result = fillTemplate(built, [...fixture.assets, short], [short.id]);
		const segment = result.project.segments.find((item) => item.id === clip.id);
		expect(segment?.speed).toBe(1);
		expect(segment?.sourceOut).toBe(1);
		expect((segment?.fadeIn ?? 0) + (segment?.fadeOut ?? 0)).toBeCloseTo(1);
		// The curve is kept up to the new end, as an end trim keeps it.
		expect(segment?.keyframes.map(({ time, value }) => [time, value])).toEqual([
			[1, expect.closeTo(2 / 3, 6)],
		]);
		expect(() =>
			validateProject(result.project, [...fixture.assets, short])
		).not.toThrow();
	});

	test("filling a linked placeholder removes its detached audio", () => {
		const fixture = source();
		const clip = fixture.clips[0];
		if (!clip) {
			throw new Error("Missing clip.");
		}
		const linkGroupId = crypto.randomUUID();
		const voice = asset("audio", 30, "detached");
		const detached = {
			...newSegment(voice, 0, 1),
			sourceIn: 5,
			sourceOut: 7,
			linkGroupId,
		};
		const project: Project = {
			...fixture.project,
			segments: [
				...fixture.project.segments.map((segment) =>
					segment.id === clip.id ? { ...segment, linkGroupId } : segment
				),
				detached,
			],
		};
		const library = [...fixture.assets, voice];
		expect(() => validateProject(project, library)).not.toThrow();
		const built = buildTemplateProject(project, library, {
			slots: [{ segmentId: clip.id }],
		});
		const replacement = asset("video", 8);
		const result = fillTemplate(
			built,
			[...library, replacement],
			[replacement.id]
		);
		expect(
			result.project.segments.some((segment) => segment.id === detached.id)
		).toBe(false);
		expect(
			result.project.segments.find((segment) => segment.id === clip.id)
				?.linkGroupId
		).toBeUndefined();
		expect(() =>
			validateProject(result.project, [...library, replacement])
		).not.toThrow();
	});

	test("filling a linked placeholder prunes lip-sync links to its removed audio", () => {
		const fixture = source();
		const clip = fixture.clips[0];
		if (!clip) {
			throw new Error("Missing clip.");
		}
		const linkGroupId = crypto.randomUUID();
		const voice = asset("audio", 30, "detached");
		const detached = {
			...newSegment(voice, 0, 1),
			sourceIn: 5,
			sourceOut: 7,
			linkGroupId,
		};
		const project: Project = {
			...fixture.project,
			segments: [
				...fixture.project.segments.map((segment) =>
					segment.id === clip.id ? { ...segment, linkGroupId } : segment
				),
				detached,
			],
			avatars: [
				{
					accent: "#336699",
					animation: "idle",
					depth: 0.45,
					end: 4,
					entryDuration: 0.35,
					height: 0.4,
					id: crypto.randomUUID(),
					lipSync: {
						assetId: voice.id,
						segmentId: detached.id,
						sensitivity: 0.5,
						smoothing: 0.5,
					},
					outfit: "#224466",
					pose: "neutral",
					skin: "#c08060",
					start: 0,
					width: 0.3,
					x: 0.5,
					y: 0.6,
				},
			],
		};
		const library = [...fixture.assets, voice];
		expect(() => validateProject(project, library)).not.toThrow();
		const built = buildTemplateProject(project, library, {
			slots: [{ segmentId: clip.id }],
		});
		const replacement = asset("video", 10);
		const filledLibrary = [...library, replacement];
		const result = fillTemplate(built, filledLibrary, [replacement.id]);
		const lipSync = result.project.avatars[0]?.lipSync;
		expect(lipSync?.assetId).toBe(voice.id);
		expect(lipSync?.segmentId).toBeUndefined();
		expect(() => validateProject(result.project, filledLibrary)).not.toThrow();
	});

	test("clamps a filled clip's reveal transition to its shorter length", () => {
		const fixture = source();
		const [first, second] = fixture.clips;
		if (!(first && second)) {
			throw new Error("Missing clips.");
		}
		const project: Project = {
			...fixture.project,
			segments: fixture.project.segments.map((segment) => {
				if (segment.id === first.id) {
					return { ...segment, sourceOut: 8 };
				}
				if (segment.id === second.id) {
					return {
						...segment,
						transitionIn: { type: "wipe-left", duration: 1, softness: 0 },
					};
				}
				return segment;
			}),
		};
		expect(() => validateProject(project, fixture.assets)).not.toThrow();
		const built = buildTemplateProject(project, fixture.assets, {
			slots: [{ segmentId: second.id, fixedDuration: false }],
		});
		const short = asset("video", 0.5);
		const result = fillTemplate(built, [...fixture.assets, short], [short.id]);
		const filled = result.project.segments.find(
			(segment) => segment.id === second.id
		);
		expect(filled?.transitionIn).toEqual({
			type: "wipe-left",
			duration: 0.5,
			softness: 0,
		});
		expect(result.adjustments).toEqual([
			{ segmentId: second.id, change: "short" },
		]);
		expect(() =>
			validateProject(result.project, [...fixture.assets, short])
		).not.toThrow();
	});

	test("drops a reveal transition whose predecessor ended early", () => {
		const fixture = source();
		const [first, second] = fixture.clips;
		if (!(first && second)) {
			throw new Error("Missing clips.");
		}
		const project: Project = {
			...fixture.project,
			segments: fixture.project.segments.map((segment) => {
				if (segment.id === first.id) {
					return { ...segment, sourceOut: 7.5 };
				}
				if (segment.id === second.id) {
					return {
						...segment,
						transitionIn: { type: "wipe-left", duration: 0.5, softness: 0 },
					};
				}
				return segment;
			}),
		};
		expect(() => validateProject(project, fixture.assets)).not.toThrow();
		const built = buildTemplateProject(project, fixture.assets, {
			slots: [{ segmentId: first.id, fixedDuration: false }],
		});
		const short = asset("video", 1);
		const result = fillTemplate(built, [...fixture.assets, short], [short.id]);
		expect(
			result.project.segments.find((segment) => segment.id === second.id)
				?.transitionIn
		).toBeUndefined();
		expect(result.adjustments).toContainEqual({
			segmentId: second.id,
			change: "reveal-dropped",
		});
		expect(() =>
			validateProject(result.project, [...fixture.assets, short])
		).not.toThrow();
	});

	test("rejects unknown media, proxies and non-templates", () => {
		const { assets, built, project } = template();
		expect(() => fillTemplate(built, assets, [crypto.randomUUID()])).toThrow(
			"not found"
		);
		const proxy = { ...asset("video", 5), derivation: "proxy" as const };
		expect(() => fillTemplate(built, [...assets, proxy], [proxy.id])).toThrow(
			"proxy"
		);
		expect(() => fillTemplate(project, assets, [])).toThrow("not a template");
	});

	test("is deterministic for the same input", () => {
		const { assets, built } = template();
		const media = asset("video", 9);
		expect(fillTemplate(built, [...assets, media], [media.id])).toEqual(
			fillTemplate(built, [...assets, media], [media.id])
		);
	});

	test("a shortened fill keeps the keyframe curve up to its new end", () => {
		const footage = asset("video", 30, "footage");
		const clip = {
			...newSegment(footage, 0),
			sourceOut: 4,
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "opacity" as const,
					time: 0,
					value: 0,
				},
				{
					id: crypto.randomUUID(),
					property: "opacity" as const,
					time: 4,
					value: 1,
				},
			],
		};
		const project: Project = { ...newProject("Fade"), segments: [clip] };
		const built = buildTemplateProject(project, [footage], {
			slots: [{ segmentId: clip.id, fixedDuration: false }],
		});
		const short = asset("video", 2);
		const result = fillTemplate(built, [footage, short], [short.id]);
		const filled = result.project.segments[0]!;
		const frames = filled.keyframes.map(({ time, value }) => [time, value]);
		const trimmed = trimSegment(clip, 30, "end", -2).keyframes.map(
			({ time, value }) => [time, value]
		);
		expect(frames).toEqual(trimmed);
		expect(frames).toEqual([
			[0, 0],
			[2, 0.5],
		]);
		expect(() =>
			validateProject(result.project, [footage, short])
		).not.toThrow();
	});

	test("filling a placeholder with detached audio keeps the new media heard", () => {
		const camera = asset("video", 30, "camera");
		const extracted: Asset = {
			...asset("audio", 30, "camera audio"),
			derivation: "audio",
			derivedFromAssetId: camera.id,
		};
		const clip = {
			...newSegment(camera, 0),
			sourceOut: 4,
			volume: 0.7,
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "volume" as const,
					time: 1,
					value: 0.7,
				},
				{
					id: crypto.randomUUID(),
					property: "volume" as const,
					time: 3,
					value: 0.2,
				},
			],
		};
		const detached = detachClipAudio(
			{ ...newProject("Detached"), segments: [clip] },
			[camera, extracted],
			{ clipIds: [clip.id], revision: 0 },
			() => extracted
		);
		const placeholder = detached.segments.find((item) => item.id === clip.id)!;
		expect(placeholder.volume).toBe(0);
		const built = buildTemplateProject(detached, [camera, extracted], {
			slots: [{ segmentId: clip.id }],
		});
		const fresh = asset("video", 10);
		const library = [camera, extracted, fresh];
		const result = fillTemplate(built, library, [fresh.id]);
		expect(result.project.segments).toHaveLength(1);
		const filled = result.project.segments[0]!;
		expect(filled.assetId).toBe(fresh.id);
		expect(filled.volume).toBe(0.7);
		expect(
			filled.keyframes
				.filter((frame) => frame.property === "volume")
				.map(({ time, value }) => [time, value])
		).toEqual([
			[1, 0.7],
			[3, 0.2],
		]);
		expect(clipHeard(result.project, filled)).toBe(true);
		expect(() => validateProject(result.project, library)).not.toThrow();
	});
});
