import { describe, expect, test } from "bun:test";
import { dbToGain } from "./decibels.ts";
import { applyNest, decomposeSequence, nestedTitle, planNest } from "./nest.ts";
import { trimOverlay } from "./overlay-edits.ts";
import {
	type Asset,
	type Avatar,
	newProject,
	newSegment,
	type Project,
	type Segment,
	type Title,
	trimSegment,
	updateTrackSetting,
	validateProject,
} from "./project.ts";
import { decomposeRequestSchema, nestRequestSchema } from "./sequences.ts";
import { clipAudible, clipHeard, clipVisible } from "./sync-lock.ts";

function media(kind: Asset["kind"], duration = 10): Asset {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: kind,
		width: kind === "audio" ? 0 : 640,
	};
}

function title(start: number, end: number, text: string): Title {
	return {
		animation: "fade",
		color: "#ffffff",
		end,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.06,
		id: crypto.randomUUID(),
		start,
		text,
		x: 0.5,
		y: 0.5,
	};
}

interface Fixture {
	assets: Asset[];
	audio: Segment;
	later: Segment;
	parent: Project;
	video: Segment;
	videoTwo: Segment;
}

function fixture(): Fixture {
	const camera = media("video");
	const voice = media("audio");
	const link = crypto.randomUUID();
	const video: Segment = {
		...newSegment(camera, 2, 1),
		keyframes: [
			{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 0 },
			{ id: crypto.randomUUID(), property: "opacity", time: 4, value: 1 },
		],
		linkGroupId: link,
		sourceIn: 1,
		sourceOut: 5,
	};
	const audio: Segment = {
		...newSegment(voice, 2.5, 0),
		linkGroupId: link,
		sourceOut: 3,
	};
	const videoTwo: Segment = {
		...newSegment(camera, 6, 1),
		sourceOut: 2,
	};
	const later: Segment = { ...newSegment(camera, 10, 1), sourceOut: 2 };
	const parent: Project = {
		...newProject("Parent cut"),
		fps: 25,
		height: 720,
		segments: [audio, video, videoTwo, later],
		titles: [
			title(0, 1, "Before"),
			title(2, 3.5, "Head"),
			title(3, 4, "Inside"),
			title(7.5, 8, "Late"),
		],
		width: 1280,
	};
	return { assets: [camera, voice], audio, later, parent, video, videoTwo };
}

function sequenceAsset(child: Project, duration: number): Asset {
	return { ...media("video", duration), sequenceProjectId: child.id };
}

/** Clips without ids, with link groups replaced by a stable marker. */
function shape(segments: readonly Segment[]) {
	const groups = new Map<string, number>();
	return [...segments]
		.sort((a, b) => a.track - b.track || a.start - b.start)
		.map(({ id: _id, keyframes, linkGroupId, ...rest }) => {
			if (linkGroupId && !groups.has(linkGroupId)) {
				groups.set(linkGroupId, groups.size);
			}
			return {
				...rest,
				keyframes: keyframes.map(({ id: _key, ...frame }) => frame),
				link: linkGroupId ? groups.get(linkGroupId) : undefined,
			};
		});
}

const titleShape = (titles: readonly Title[]) =>
	[...titles]
		.sort((a, b) => a.start - b.start)
		.map(({ id: _id, ...rest }) => rest);

function nestAll(f: Fixture) {
	const plan = planNest(f.parent, f.assets, {
		clipIds: [f.video.id, f.audio.id, f.videoTwo.id],
	});
	const asset = sequenceAsset(plan.child, plan.end - plan.start);
	const assets = [...f.assets, asset];
	const nested = applyNest(f.parent, assets, plan, asset);
	return { asset, assets, nested, plan };
}

describe("request schemas", () => {
	test("are strict and require a revision", () => {
		const id = crypto.randomUUID();
		expect(nestRequestSchema.parse({ clipIds: [id], revision: 2 })).toEqual({
			clipIds: [id],
			revision: 2,
		});
		expect(() => nestRequestSchema.parse({ clipIds: [id] })).toThrow();
		expect(() =>
			nestRequestSchema.parse({ clipIds: [], revision: 0 })
		).toThrow();
		expect(() =>
			decomposeRequestSchema.parse({ clipId: id, extra: 1, revision: 0 })
		).toThrow();
	});
});

describe("planNest", () => {
	test("re-bases the selection and the overlays inside its span", () => {
		const f = fixture();
		const plan = planNest(f.parent, f.assets, {
			clipIds: [f.video.id, f.audio.id, f.videoTwo.id],
		});
		expect(plan.start).toBe(2);
		expect(plan.end).toBe(8);
		// Lowest selected video track; the audio track is skipped.
		expect(plan.track).toBe(1);
		expect(plan.child.width).toBe(1280);
		expect(plan.child.height).toBe(720);
		expect(plan.child.fps).toBe(25);
		expect(plan.child.title).toBe(nestedTitle(f.parent));
		expect(
			plan.child.segments.map((segment) => [segment.track, segment.start])
		).toEqual([
			[0, 0.5],
			[1, 0],
			[1, 4],
		]);
		expect(plan.child.titles.map((item) => [item.text, item.start])).toEqual([
			["Head", 0],
			["Inside", 1],
			["Late", 5.5],
		]);
		expect(plan.titleIds).toHaveLength(3);
	});

	test("uses an injected id and title deterministically", () => {
		const f = fixture();
		const id = crypto.randomUUID();
		const plan = planNest(
			f.parent,
			f.assets,
			{ clipIds: [f.video.id], title: "Intro" },
			{ mintId: () => id, now: "2026-02-02T00:00:00.000Z" }
		);
		expect(plan.child.id).toBe(id);
		expect(plan.child.title).toBe("Intro");
		expect(plan.child.updatedAt).toBe("2026-02-02T00:00:00.000Z");
		// A partial link group is dissolved inside the child.
		expect(plan.child.segments[0]?.linkGroupId).toBeUndefined();
	});

	test("refuses when an unselected picture sits below or between the selection", () => {
		const f = fixture();
		const camera = f.assets[0]!;
		// Same track inside the span.
		const sameTrack = { ...newSegment(camera, 5, 1), sourceOut: 1 };
		// A full-frame background under a picture-in-picture.
		const below = { ...newSegment(camera, 2, 0), sourceOut: 4 };
		for (const blocker of [sameTrack, below]) {
			const parent = {
				...f.parent,
				segments: [
					...f.parent.segments.filter((segment) => segment.id !== f.audio.id),
					blocker,
				],
			};
			expect(() =>
				planNest(parent, f.assets, { clipIds: [f.video.id] })
			).toThrow("would cover them");
		}
		// A clip on a track between two selected tracks.
		const top = { ...newSegment(camera, 3, 3), sourceOut: 1 };
		const middle = { ...newSegment(camera, 3, 2), sourceOut: 1 };
		const parent = {
			...f.parent,
			segments: [...f.parent.segments, top, middle],
		};
		expect(() =>
			planNest(parent, f.assets, { clipIds: [f.video.id, top.id] })
		).toThrow("would cover them");
		// An unselected clip above the selection stays above the sequence clip.
		const above = planNest(parent, f.assets, {
			clipIds: [f.video.id, middle.id],
		});
		expect(above.track).toBe(1);
	});

	test("refuses an adjustment layer between the selected tracks", () => {
		const f = fixture();
		const camera = f.assets[0]!;
		const top = { ...newSegment(camera, 3, 3), sourceOut: 1 };
		const layer = {
			end: 4,
			id: crypto.randomUUID(),
			label: "Grade",
			opacity: 1,
			start: 3,
			track: 2,
		};
		const parent: Project = {
			...f.parent,
			adjustmentLayers: [layer],
			segments: [...f.parent.segments, top],
		};
		expect(() =>
			planNest(parent, f.assets, { clipIds: [f.video.id, top.id] })
		).toThrow("adjustment layer");
		// Above the whole selection it grades the sequence clip as before.
		const plan = planNest(
			{ ...parent, adjustmentLayers: [{ ...layer, track: 3 }] },
			f.assets,
			{ clipIds: [f.video.id, top.id] }
		);
		expect(plan.track).toBe(1);
	});

	test("moves up past a hidden lowest track and keeps it hidden in the child", () => {
		const f = fixture();
		const hidden = updateTrackSetting(f.parent, 1, { hidden: true });
		const plan = planNest(hidden, f.assets, {
			clipIds: [f.video.id, f.audio.id],
		});
		expect(plan.track).toBe(2);
		expect(
			plan.child.trackSettings.find((item) => item.track === 1)
		).toMatchObject({ hidden: true });
	});

	test("keeps overlays in the parent when a move would restack them", () => {
		const f = fixture();
		const camera = f.assets[0]!;
		// An unselected clip above the selection overlaps "Inside" (3-4).
		const above = { ...newSegment(camera, 3.5, 2), sourceOut: 1 };
		// A graphic that stays (it pokes out of the span) overlaps "Late".
		const late = f.parent.titles.find((item) => item.text === "Late")!;
		const parent: Project = {
			...f.parent,
			graphics: [
				{
					end: 9,
					fill: "#ffffff",
					height: 0.2,
					id: crypto.randomUUID(),
					opacity: 1,
					shape: "rectangle",
					start: 7.8,
					width: 0.2,
					x: 0.5,
					y: 0.5,
				} as Project["graphics"][number],
			],
			segments: [...f.parent.segments, above],
		};
		const plan = planNest(parent, f.assets, {
			clipIds: [f.video.id, f.audio.id, f.videoTwo.id],
		});
		// "Inside" stays under the clip above it; "Head" overlaps "Inside", so
		// it stays too; "Late" overlaps the graphic that stays.
		expect(plan.child.titles).toEqual([]);
		expect(plan.titleIds).not.toContain(late.id);
		expect(plan.graphicIds).toEqual([]);
	});

	test("keeps fades and end keyframes valid when overlays move", () => {
		const camera = media("video", 7200);
		const failures: string[] = [];
		for (let index = 0; index < 400; index++) {
			const clipStart =
				Math.round(index * 1.37 * 100) / 100 + 0.01 * (index % 7);
			const titleStart = clipStart + 1.58 + (index % 11) * 0.01;
			const titleEnd = titleStart + 1.18 + (index % 13) * 0.070_000_000_1;
			const duration = titleEnd - titleStart;
			const clip = { ...newSegment(camera, clipStart, 0), sourceOut: 6 };
			const item: Title = {
				...title(titleStart, titleEnd, "Edge"),
				fadeIn: duration / 2,
				fadeOut: duration - duration / 2,
				keyframes: [
					{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 0 },
					{
						id: crypto.randomUUID(),
						property: "opacity",
						time: duration,
						value: 1,
					},
				],
			};
			const parent: Project = {
				...newProject("Float"),
				segments: [clip],
				titles: [item],
			};
			try {
				const plan = planNest(parent, [camera], { clipIds: [clip.id] });
				const moved = plan.child.titles[0]!;
				expect(moved.end - moved.start).toBeGreaterThanOrEqual(duration);
			} catch (error) {
				failures.push(`${clipStart}/${titleStart}: ${String(error)}`);
			}
		}
		// The reviewer's reported cases.
		for (const [clipStart, titleStart, titleEnd] of [
			[1.74, 3.320_000_000_000_000_3, 4.5],
			[0.87, 1.72, 3.769_999_999_999_999_6],
		] as const) {
			const clip = { ...newSegment(camera, clipStart, 0), sourceOut: 6 };
			const duration = titleEnd - titleStart;
			const item: Title = {
				...title(titleStart, titleEnd, "Edge"),
				fadeIn: duration / 2,
				fadeOut: duration - duration / 2,
				keyframes: [
					{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 0 },
					{
						id: crypto.randomUUID(),
						property: "opacity",
						time: duration,
						value: 1,
					},
				],
			};
			const parent: Project = {
				...newProject("Float"),
				segments: [clip],
				titles: [item],
			};
			const plan = planNest(parent, [camera], { clipIds: [clip.id] });
			const asset = sequenceAsset(plan.child, plan.end - plan.start);
			const nested = applyNest(parent, [camera, asset], plan, asset);
			const back = decomposeSequence(
				nested.project,
				[camera, asset],
				plan.child,
				nested.clipId
			);
			const restored = back.project.titles[0]!;
			expect(restored.end - restored.start).toBeGreaterThanOrEqual(duration);
		}
		expect(failures).toEqual([]);
	});

	test("carries track visibility, mute, solo, gain and pan into the child", () => {
		const f = fixture();
		const camera = f.assets[0]!;
		const top = { ...newSegment(camera, 3, 2), sourceOut: 1 };
		let parent: Project = {
			...f.parent,
			segments: [...f.parent.segments, top],
		};
		parent = updateTrackSetting(parent, 0, { gainDb: -6, muted: true });
		parent = updateTrackSetting(parent, 1, { gainDb: -2, name: "A cam" });
		parent = updateTrackSetting(parent, 2, { hidden: true, pan: 0.5 });
		const plan = planNest(parent, f.assets, {
			clipIds: [f.video.id, f.audio.id, top.id],
		});
		expect(plan.track).toBe(1);
		const byTrack = (track: number) =>
			plan.child.trackSettings.find((item) => item.track === track);
		expect(byTrack(0)).toMatchObject({ gainDb: -4, muted: true });
		expect(byTrack(1)).toMatchObject({ muted: false, name: "A cam" });
		expect(byTrack(1)?.gainDb).toBeUndefined();
		expect(byTrack(2)).toMatchObject({ hidden: true, pan: 0.5 });
		expect(plan.child.trackSettings.every((item) => !item.locked)).toBe(true);
		// Solo elsewhere silences the selected tracks inside the child too.
		const solo = updateTrackSetting(
			updateTrackSetting(f.parent, 1, { solo: true }),
			0,
			{}
		);
		const soloPlan = planNest(solo, f.assets, {
			clipIds: [f.video.id, f.audio.id],
		});
		expect(
			soloPlan.child.trackSettings.find((item) => item.track === 0)
		).toMatchObject({ muted: true, solo: false });
	});

	test("refuses a muted target track while selected audio is audible", () => {
		const f = fixture();
		const muted = updateTrackSetting(f.parent, 1, { muted: true });
		expect(() =>
			planNest(muted, f.assets, { clipIds: [f.video.id, f.audio.id] })
		).toThrow("muted");
		const panned = updateTrackSetting(
			updateTrackSetting(f.parent, 1, { pan: -0.5 }),
			0,
			{ pan: 0.5 }
		);
		expect(() =>
			planNest(panned, f.assets, { clipIds: [f.video.id, f.audio.id] })
		).toThrow("panned");
	});

	test("refuses selections it cannot nest", () => {
		const f = fixture();
		expect(() => planNest(f.parent, f.assets, { clipIds: [] })).toThrow(
			"Select clips"
		);
		expect(() =>
			planNest(f.parent, f.assets, { clipIds: [crypto.randomUUID()] })
		).toThrow("not on the timeline");
		expect(() =>
			planNest(f.parent, f.assets, { clipIds: [f.video.id, f.video.id] })
		).toThrow("only once");
		expect(() =>
			planNest(f.parent, f.assets, { clipIds: [f.audio.id] })
		).toThrow("video or image");
		const locked = updateTrackSetting(f.parent, 1, { locked: true });
		expect(() => planNest(locked, f.assets, { clipIds: [f.video.id] })).toThrow(
			"Unlock"
		);
		const multicam = {
			...f.parent,
			segments: f.parent.segments.map((segment) =>
				segment.id === f.video.id
					? { ...segment, multicamGroupId: crypto.randomUUID() }
					: segment
			),
		};
		expect(() =>
			planNest(multicam, f.assets, { clipIds: [f.video.id] })
		).toThrow("Multicam");
	});
});

describe("applyNest", () => {
	test("replaces the selection with one sequence clip", () => {
		const f = fixture();
		const { asset, nested } = nestAll(f);
		const clip = nested.project.segments.find(
			(segment) => segment.id === nested.clipId
		);
		expect(clip).toMatchObject({
			assetId: asset.id,
			sourceIn: 0,
			sourceOut: 6,
			start: 2,
			track: 1,
		});
		expect(nested.project.segments.map((segment) => segment.id)).toEqual([
			nested.clipId,
			f.later.id,
		]);
		expect(nested.project.titles.map((item) => item.text)).toEqual(["Before"]);
	});

	test("refuses media that is not a sequence", () => {
		const f = fixture();
		const plan = planNest(f.parent, f.assets, { clipIds: [f.video.id] });
		expect(() => applyNest(f.parent, f.assets, plan, f.assets[0]!)).toThrow(
			"not a sequence"
		);
	});
});

describe("nest then decompose", () => {
	test("round trip restores the original timeline", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		const result = decomposeSequence(
			nested.project,
			assets,
			plan.child,
			nested.clipId
		);
		expect(result.trackDelta).toBe(0);
		expect(shape(result.project.segments)).toEqual(shape(f.parent.segments));
		expect(titleShape(result.project.titles)).toEqual(
			titleShape(f.parent.titles)
		);
		const original = new Set(f.parent.segments.map((segment) => segment.id));
		expect(result.clipIds.some((id) => original.has(id))).toBe(false);
		const links = result.project.segments
			.map((segment) => segment.linkGroupId)
			.filter(Boolean);
		expect(links).toHaveLength(2);
		expect(links[0]).not.toBe(f.video.linkGroupId);
	});

	test("trimmed round trip restores the clips trimmed to the kept range", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		const sequence = nested.project.segments.find(
			(segment) => segment.id === nested.clipId
		)!;
		const trimmed = trimSegment(
			trimSegment(sequence, 6, "start", 1),
			6,
			"end",
			-1.5
		);
		expect([trimmed.start, trimmed.sourceIn, trimmed.sourceOut]).toEqual([
			3, 1, 4.5,
		]);
		const parent = {
			...nested.project,
			segments: nested.project.segments.map((segment) =>
				segment.id === trimmed.id ? trimmed : segment
			),
		};
		const result = decomposeSequence(parent, assets, plan.child, trimmed.id);
		// Expected: the original clips trimmed to the timeline range [3, 6.5).
		const camera = f.assets[0]!;
		const voice = f.assets[1]!;
		// Pieces that lost their head advance the entry animation like split
		// right halves do.
		const expected = [
			f.later,
			{ ...trimSegment(f.video, camera.duration, "start", 1), entryOffset: 1 },
			{
				...trimSegment(f.audio, voice.duration, "start", 0.5),
				entryOffset: 0.5,
			},
			trimSegment(f.videoTwo, camera.duration, "end", -1.5),
		];
		expect(shape(result.project.segments)).toEqual(shape(expected));
		let titles: Project = f.parent;
		const head = f.parent.titles.find((item) => item.text === "Head")!;
		titles = trimOverlay(titles, {
			edge: "start",
			id: head.id,
			kind: "titles",
			time: 3,
		});
		expect(titleShape(result.project.titles)).toEqual(
			titleShape(
				titles.titles.filter((item) =>
					["Before", "Head", "Inside"].includes(item.text)
				)
			)
		);
	});

	test("moves the expanded clips up as a block when tracks are taken", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		// An unrelated audio clip now sits on track 0 over the span.
		const blocker = { ...newSegment(f.assets[1]!, 2, 0), sourceOut: 4 };
		const parent = {
			...nested.project,
			segments: [...nested.project.segments, blocker],
		};
		const result = decomposeSequence(parent, assets, plan.child, nested.clipId);
		// Track 1 holds video, so the audio copy cannot land there: the block
		// moves up two tracks to keep audio and video lanes apart.
		expect(result.trackDelta).toBe(2);
		const tracks = result.clipIds.map(
			(id) =>
				result.project.segments.find((segment) => segment.id === id)!.track
		);
		expect(tracks.sort()).toEqual([2, 3, 3]);
	});

	test("drops a sliver the sequence clip trimmed away", () => {
		const camera = media("video");
		const first = { ...newSegment(camera, 0, 0), sourceOut: 2 };
		const second = { ...newSegment(camera, 2, 0), sourceOut: 2 };
		const parent: Project = {
			...newProject("Back to back"),
			segments: [first, second],
		};
		const plan = planNest(parent, [camera], {
			clipIds: [first.id, second.id],
		});
		const asset = sequenceAsset(plan.child, 4);
		const assets = [camera, asset];
		const nested = applyNest(parent, assets, plan, asset);
		const sequence = nested.project.segments[0]!;
		const trimmed = trimSegment(sequence, 4, "start", 1.99);
		const edited = { ...nested.project, segments: [trimmed] };
		const result = decomposeSequence(edited, assets, plan.child, trimmed.id);
		expect(result.clipIds).toHaveLength(1);
		const restored = result.project.segments[0]!;
		expect(restored.start).toBeGreaterThanOrEqual(trimmed.start - 1e-9);
		expect(restored.track).toBe(0);
		expect(result.trackDelta).toBe(0);
	});

	test("drops edge transitions the sequence clip trimmed away", () => {
		const camera = media("video");
		const first: Segment = {
			...newSegment(camera, 0, 0),
			exitDuration: 0.5,
			exitTransition: "zoom-out",
			sourceOut: 4,
		};
		const second: Segment = {
			...newSegment(camera, 3, 0),
			exitDuration: 0.5,
			exitTransition: "zoom-out",
			sourceOut: 4,
			transitionIn: { duration: 1, softness: 0, type: "dissolve" },
		};
		const parent: Project = {
			...newProject("Edges"),
			segments: [first, second],
		};
		const plan = planNest(parent, [camera], {
			clipIds: [first.id, second.id],
		});
		const asset = sequenceAsset(plan.child, 7);
		const assets = [camera, asset];
		const nested = applyNest(parent, assets, plan, asset);
		const sequence = nested.project.segments[0]!;
		// Keep [1, 5): the first clip loses its head, the second its tail.
		const trimmed = trimSegment(
			trimSegment(sequence, 7, "start", 1),
			7,
			"end",
			-2
		);
		const edited = { ...nested.project, segments: [trimmed] };
		const result = decomposeSequence(edited, assets, plan.child, trimmed.id);
		const [head, tail] = [...result.project.segments].sort(
			(a, b) => a.start - b.start
		);
		// The first clip's tail and the second clip's head stay in the window.
		expect(head?.exitTransition).toBe("zoom-out");
		expect(head?.exitDuration).toBe(0.5);
		expect(tail?.transitionIn?.duration).toBe(1);
		// The second clip's exit played after the kept range, so it is gone.
		expect(tail?.exitTransition).toBeUndefined();
		expect(tail?.exitDuration).toBeUndefined();
	});

	test("refuses clips it cannot decompose", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		expect(() =>
			decomposeSequence(nested.project, assets, plan.child, f.later.id)
		).toThrow("not a nested sequence");
		expect(() =>
			decomposeSequence(
				nested.project,
				assets,
				{ ...plan.child, id: crypto.randomUUID() },
				nested.clipId
			)
		).toThrow("does not match");
		const fast = {
			...nested.project,
			segments: nested.project.segments.map((segment) =>
				segment.id === nested.clipId ? { ...segment, speed: 2 } : segment
			),
		};
		expect(() =>
			decomposeSequence(fast, assets, plan.child, nested.clipId)
		).toThrow("speed");
		const locked = updateTrackSetting(nested.project, 1, { locked: true });
		expect(() =>
			decomposeSequence(locked, assets, plan.child, nested.clipId)
		).toThrow("Unlock");
	});
});

describe("decompose keeps what the sequence clip played", () => {
	function avatarFor(assetId: string, segmentId: string): Avatar {
		return {
			accent: "#f97316",
			animation: "none",
			depth: 0.45,
			end: 6,
			entryDuration: 0,
			height: 0.6,
			id: crypto.randomUUID(),
			lipSync: { assetId, segmentId, sensitivity: 0.5, smoothing: 0.5 },
			outfit: "#4f46e5",
			pose: "neutral",
			skin: "#f4c7a1",
			start: 0,
			width: 0.3,
			x: 0.5,
			y: 0.2,
		};
	}

	const copyOf = (
		result: { project: Project; clipIds: string[] },
		assetId: string
	) =>
		result.project.segments.find(
			(segment) =>
				result.clipIds.includes(segment.id) && segment.assetId === assetId
		)!;

	test("unpins an avatar lip-synced to the sequence clip", () => {
		const f = fixture();
		const { asset, assets, nested, plan } = nestAll(f);
		const linked = {
			...nested.project,
			avatars: [avatarFor(asset.id, nested.clipId)],
		};
		expect(() => validateProject(linked, assets)).not.toThrow();
		const result = decomposeSequence(linked, assets, plan.child, nested.clipId);
		const lipSync = result.project.avatars[0]?.lipSync;
		expect(lipSync?.assetId).toBe(asset.id);
		expect(lipSync?.segmentId).toBeUndefined();
	});

	test("carries the child's muted, hidden, gain and pan track state", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		const voice = f.assets[1]!;
		const camera = f.assets[0]!;
		const muted = updateTrackSetting(plan.child, 0, { muted: true });
		const silent = decomposeSequence(
			nested.project,
			assets,
			muted,
			nested.clipId
		);
		expect(clipAudible(silent.project, copyOf(silent, voice.id))).toBe(false);
		const hidden = updateTrackSetting(plan.child, 1, { hidden: true });
		const unseen = decomposeSequence(
			nested.project,
			assets,
			hidden,
			nested.clipId
		);
		for (const id of unseen.clipIds) {
			const copy = unseen.project.segments.find((item) => item.id === id)!;
			if (copy.assetId === camera.id) {
				expect(clipVisible(unseen.project, copy)).toBe(false);
			}
		}
		const soloed = updateTrackSetting(plan.child, 1, { solo: true });
		const excluded = decomposeSequence(
			nested.project,
			assets,
			soloed,
			nested.clipId
		);
		expect(clipAudible(excluded.project, copyOf(excluded, voice.id))).toBe(
			false
		);
		const mixed = updateTrackSetting(plan.child, 0, { gainDb: -6, pan: 0.5 });
		const result = decomposeSequence(
			nested.project,
			assets,
			mixed,
			nested.clipId
		);
		const audio = copyOf(result, voice.id);
		expect(audio.volume).toBeCloseTo(dbToGain(-6), 9);
		expect(audio.pan).toBe(0.5);
		expect(clipHeard(result.project, audio)).toBe(true);
	});

	test("refuses a child track pan it cannot fold into a panned clip", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		const child = updateTrackSetting(
			{
				...plan.child,
				segments: plan.child.segments.map((segment) => ({
					...segment,
					pan: -0.25,
				})),
			},
			0,
			{ pan: 0.5 }
		);
		expect(() =>
			decomposeSequence(nested.project, assets, child, nested.clipId)
		).toThrow("Center the nested track pan");
	});

	test("lands audible copies only on audible tracks", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		const moved = updateTrackSetting(
			{
				...nested.project,
				segments: nested.project.segments.map((segment) =>
					segment.id === nested.clipId ? { ...segment, track: 3 } : segment
				),
			},
			2,
			{ muted: true }
		);
		const result = decomposeSequence(moved, assets, plan.child, nested.clipId);
		expect(result.trackDelta).toBe(1);
		const audio = copyOf(result, f.assets[1]!.id);
		expect(audio.track).toBe(3);
		expect(clipAudible(result.project, audio)).toBe(true);
	});

	test("a muted or hidden sequence clip mutes or hides every copy", () => {
		const f = fixture();
		const { assets, nested, plan } = nestAll(f);
		const withClip = (patch: Partial<Segment>) => ({
			...nested.project,
			segments: nested.project.segments.map((segment) =>
				segment.id === nested.clipId ? { ...segment, ...patch } : segment
			),
		});
		const muted = decomposeSequence(
			withClip({ muted: true }),
			assets,
			plan.child,
			nested.clipId
		);
		expect(clipAudible(muted.project, copyOf(muted, f.assets[1]!.id))).toBe(
			false
		);
		const hidden = decomposeSequence(
			withClip({ hidden: true }),
			assets,
			plan.child,
			nested.clipId
		);
		for (const id of hidden.clipIds) {
			const copy = hidden.project.segments.find((item) => item.id === id)!;
			expect(clipVisible(hidden.project, copy)).toBe(false);
			expect(clipAudible(hidden.project, copy)).toBe(false);
		}
	});

	test("drops the fade and entry animation of a trimmed-away edge", () => {
		const camera = media("video");
		const clip: Segment = {
			...newSegment(camera, 0, 0),
			entryDuration: 1,
			entryTransition: "slide-left",
			fadeIn: 1,
			fadeOut: 1,
			sourceOut: 6,
		};
		const parent: Project = { ...newProject("Fades"), segments: [clip] };
		const plan = planNest(parent, [camera], { clipIds: [clip.id] });
		const asset = sequenceAsset(plan.child, 6);
		const assets = [camera, asset];
		const nested = applyNest(parent, assets, plan, asset);
		const sequence = nested.project.segments[0]!;
		const trimmed = trimSegment(
			trimSegment(sequence, 6, "start", 2),
			6,
			"end",
			-2
		);
		const edited = { ...nested.project, segments: [trimmed] };
		const result = decomposeSequence(edited, assets, plan.child, trimmed.id);
		const restored = result.project.segments[0]!;
		expect([restored.start, restored.sourceIn, restored.sourceOut]).toEqual([
			2, 2, 4,
		]);
		expect(restored.fadeIn).toBe(0);
		expect(restored.fadeOut).toBe(0);
		expect(restored.entryOffset).toBe(2);
		expect(restored.entryTransition).toBe("slide-left");
	});
});

describe("planNest audibility", () => {
	test("silent clips do not hold a nest off a muted target track", () => {
		const camera = media("video");
		const voice = media("audio");
		const audio: Segment = {
			...newSegment(voice, 0, 0),
			sourceOut: 2,
			volume: 0,
		};
		const video: Segment = { ...newSegment(camera, 0, 1), sourceOut: 2 };
		const parent = updateTrackSetting(
			{ ...newProject("Silent"), segments: [audio, video] },
			1,
			{ muted: true }
		);
		const assets = [camera, voice];
		const plan = planNest(parent, assets, { clipIds: [audio.id, video.id] });
		expect(plan.track).toBe(1);
		const heard = updateTrackSetting(
			{
				...parent,
				segments: [{ ...audio, volume: 1 }, video],
			},
			1,
			{ muted: true }
		);
		expect(() =>
			planNest(heard, assets, { clipIds: [audio.id, video.id] })
		).toThrow("muted or excluded by solo");
	});
});
