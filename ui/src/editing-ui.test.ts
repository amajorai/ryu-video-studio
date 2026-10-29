import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../shared/project.ts";
import { trimEdit } from "../../shared/trim-modes.ts";
import { selectedFillerRanges } from "./CleanupPanel.tsx";
import {
	cutForClip,
	detachBatches,
	formatSplitOffset,
	nearestCut,
	planIsCurrent,
	planStamp,
	projectEditResponse,
	splitEditStatus,
	splitOffsetBadges,
	TRIM_TOOLS,
	toolDragEdit,
	toolHandlesDrag,
	trimToolForKey,
} from "./editing-ui.ts";
import { parseKeywords, withHighlightMarker } from "./HighlightsPanel.tsx";
import { speedCurvePath } from "./SpeedRampPanel.tsx";
import { acceptedSplitEdits, initialSplitRows } from "./SplitEditPanel.tsx";

function camera(name: string): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 20,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name,
		width: 640,
	};
}

function extracted(video: Asset): Asset {
	return {
		createdAt: new Date().toISOString(),
		derivation: "audio",
		derivedFromAssetId: video.id,
		duration: video.duration,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio",
		name: `${video.name} audio`,
		width: 0,
	};
}

function linkedTake(
	video: Asset,
	audio: Asset,
	start: number,
	sourceIn: number,
	sourceOut: number
): [Segment, Segment] {
	const linkGroupId = crypto.randomUUID();
	return [
		{
			...newSegment(video, start, 0),
			linkGroupId,
			sourceIn,
			sourceOut,
			volume: 0,
		},
		{
			...newSegment(audio, start, 1),
			linkGroupId,
			sourceIn,
			sourceOut,
		},
	];
}

function twoTakes() {
	const a = camera("A");
	const b = camera("B");
	const assets = [a, b, extracted(a), extracted(b)];
	const [aVideo, aAudio] = linkedTake(a, assets[2] as Asset, 0, 2, 6);
	const [bVideo, bAudio] = linkedTake(b, assets[3] as Asset, 4, 3, 8);
	const project: Project = {
		...newProject("Split edits"),
		segments: [aVideo, aAudio, bVideo, bAudio],
	};
	return { aAudio, aVideo, assets, bAudio, bVideo, project };
}

describe("trim tools", () => {
	test("tool shortcuts avoid the editor's existing keys", () => {
		expect(trimToolForKey("V")).toBe("pointer");
		expect(trimToolForKey("b")).toBe("ripple");
		expect(trimToolForKey("r")).toBe("roll");
		expect(trimToolForKey("y")).toBe("slip");
		expect(trimToolForKey("u")).toBe("slide");
		for (const taken of ["s", "d", "j", "k", "l", "i", "o"]) {
			expect(trimToolForKey(taken)).toBeUndefined();
		}
	});

	test("the razor is hidden and unbound until it can cut, and never edits", () => {
		expect(TRIM_TOOLS.some((entry) => entry.tool === "razor")).toBe(false);
		expect(trimToolForKey("c")).toBeUndefined();
		expect(toolHandlesDrag("razor", "move")).toBe(true);
		expect(toolHandlesDrag("razor", "start")).toBe(true);
		const { aVideo, project } = twoTakes();
		expect(toolDragEdit(project, "razor", aVideo, "move", 1)).toBeNull();
		expect(toolDragEdit(project, "razor", aVideo, "end", 1)).toBeNull();
	});

	test("edges belong to ripple and roll, bodies to slip and slide", () => {
		expect(toolHandlesDrag("pointer", "start")).toBe(false);
		expect(toolHandlesDrag("ripple", "end")).toBe(true);
		expect(toolHandlesDrag("ripple", "move")).toBe(false);
		expect(toolHandlesDrag("roll", "start")).toBe(true);
		expect(toolHandlesDrag("slip", "move")).toBe(true);
		expect(toolHandlesDrag("slide", "end")).toBe(false);
	});

	test("a roll drag on an end edge targets the touching next clip and applies", () => {
		const { aVideo, assets, bVideo, project } = twoTakes();
		const input = toolDragEdit(project, "roll", aVideo, "end", 0.5);
		expect(input).toMatchObject({
			delta: 0.5,
			inClipId: bVideo.id,
			mode: "roll",
			outClipId: aVideo.id,
		});
		if (!input) {
			throw new Error("Expected a roll request.");
		}
		const result = trimEdit(project, assets, input);
		expect(result.applied).toBeCloseTo(0.5, 6);
		const rolled = result.project.segments.find((s) => s.id === bVideo.id);
		expect(rolled?.start).toBeCloseTo(4.5, 6);
	});

	test("a roll without a touching neighbour explains itself", () => {
		const { aVideo, project } = twoTakes();
		expect(() => toolDragEdit(project, "roll", aVideo, "start", 0.2)).toThrow(
			"Roll needs another clip"
		);
	});

	test("slip converts the pointer delta to reversed source seconds", () => {
		const { aVideo, project } = twoTakes();
		expect(
			toolDragEdit(project, "slip", { ...aVideo, speed: 2 }, "move", 0.25)
		).toMatchObject({ delta: -0.5, mode: "slip" });
		expect(toolDragEdit(project, "pointer", aVideo, "move", 1)).toBeNull();
	});
});

describe("split-edit visuals", () => {
	test("badges show audio leading (J) and trailing (L) its picture", () => {
		const { aAudio, assets, bAudio, project } = twoTakes();
		const shifted: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === bAudio.id
					? { ...segment, sourceIn: 2.5, start: 3.5 }
					: segment.id === aAudio.id
						? { ...segment, sourceOut: 5.5 }
						: segment
			),
		};
		const incoming = shifted.segments.find((s) => s.id === bAudio.id);
		const outgoing = shifted.segments.find((s) => s.id === aAudio.id);
		if (!(incoming && outgoing)) {
			throw new Error("Missing audio fixtures.");
		}
		const inBadges = splitOffsetBadges(shifted, assets, incoming);
		expect(inBadges).toEqual([{ edge: "start", kind: "J", offset: -0.5 }]);
		expect(formatSplitOffset(inBadges[0] ?? { kind: "J", offset: 0 })).toBe(
			"J −0.50s"
		);
		expect(splitOffsetBadges(shifted, assets, outgoing)).toEqual([
			{ edge: "end", kind: "J", offset: -0.5 },
		]);
		expect(formatSplitOffset({ kind: "L", offset: 0.68 })).toBe("L +0.68s");
		expect(splitOffsetBadges(project, assets, aAudio)).toEqual([]);
	});

	test("a straight cut with an audio crossfade gets no J/L badge", () => {
		const { aAudio, assets, bAudio, project } = twoTakes();
		// Default 0.08 s crossfade around a straight cut at t = 4.
		const crossfaded: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === bAudio.id
					? { ...segment, sourceIn: 2.96, start: 3.96 }
					: segment.id === aAudio.id
						? { ...segment, sourceOut: 6.04 }
						: segment
			),
		};
		for (const id of [aAudio.id, bAudio.id]) {
			const clip = crossfaded.segments.find((segment) => segment.id === id);
			if (!clip) {
				throw new Error("Missing audio fixture.");
			}
			expect(splitOffsetBadges(crossfaded, assets, clip)).toEqual([]);
		}
	});

	test("finds the cut nearest the playhead and the cut at a linked clip", () => {
		const { aVideo, assets, project } = twoTakes();
		expect(nearestCut(project, assets, 9)?.time).toBeCloseTo(4, 6);
		expect(cutForClip(project, assets, aVideo.id, 0)?.time).toBeCloseTo(4, 6);
		const unlinked: Project = {
			...project,
			segments: project.segments.map(({ linkGroupId: _link, ...rest }) => rest),
		};
		expect(cutForClip(unlinked, assets, aVideo.id, 0)).toBeUndefined();
		expect(nearestCut(unlinked, assets, 4)).toBeUndefined();
	});
});

describe("plan panels", () => {
	const proposals = [
		{
			confidence: 0.9,
			cutTime: 4,
			key: "a>b",
			kind: "j" as const,
			offset: -0.5,
			reason: "clipped-incoming-speech",
		},
		{
			confidence: 0.4,
			cutTime: 8,
			key: "b>c",
			kind: "l" as const,
			offset: 0.68,
			reason: "energy-tail",
		},
		{
			confidence: 1,
			cutTime: 12,
			key: "c>d",
			kind: "none" as const,
			offset: 0,
			reason: "both-sides-speaking",
		},
	];

	test("rows preselect confident J/L proposals and sign the offsets", () => {
		const rows = initialSplitRows(proposals);
		expect(rows["a>b"]).toEqual({ checked: true, offset: 0.5 });
		expect(rows["b>c"]).toEqual({ checked: false, offset: 0.68 });
		expect(rows["c>d"]?.checked).toBe(false);
		expect(acceptedSplitEdits(proposals, rows)).toEqual([
			{ key: "a>b", offset: -0.5 },
		]);
		expect(
			acceptedSplitEdits(proposals, {
				...rows,
				"b>c": { checked: true, offset: 0.4 },
				"c>d": { checked: true, offset: 1 },
			})
		).toEqual([
			{ key: "a>b", offset: -0.5 },
			{ key: "b>c", offset: 0.4 },
		]);
	});

	test("selected filler hits merge into bounded removal ranges", () => {
		const hits = [
			{ clipId: "c", end: 1.2, kind: "filler" as const, start: 1, text: "um" },
			{
				clipId: "c",
				end: 1.4,
				kind: "filler" as const,
				start: 1.22,
				text: "uh",
			},
			{ clipId: "c", end: 3.5, kind: "repeat" as const, start: 3.2, text: "I" },
		];
		const ranges = selectedFillerRanges(hits, new Set(["c:1", "c:1.22"]), 10);
		expect(ranges).toEqual([{ end: 1.4, start: 1 }]);
		expect(selectedFillerRanges(hits, new Set(), 10)).toEqual([]);
	});

	test("keywords are trimmed, unique, and bounded", () => {
		expect(parseKeywords(" launch, demo ,launch,, ")).toEqual([
			"launch",
			"demo",
		]);
		expect(
			parseKeywords(Array.from({ length: 30 }, (_, i) => `k${i}`).join(","))
		).toHaveLength(20);
	});

	test("speed curves plot log speed inside the preview box", () => {
		const points = speedCurvePath("bullet")
			.split(" ")
			.map((pair) => pair.split(",").map(Number));
		for (const [x, y] of points) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(120);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(40);
		}
		expect(points[0]?.[1]).toBe(20);
	});
});

describe("plan staleness and detach batches", () => {
	test("plans stay current across non-timing saves and go stale when clips move", () => {
		const { aVideo, project } = twoTakes();
		const saved = { ...project, revision: 3 };
		const stamp = planStamp(saved, 3);
		expect(planIsCurrent(stamp, saved)).toBe(true);
		const markedProject: Project = {
			...saved,
			markers: [
				{
					color: "#22c55e",
					comment: "",
					duration: 0,
					id: crypto.randomUUID(),
					label: "Note",
					time: 1,
				},
			],
			revision: 4,
		};
		expect(planIsCurrent(stamp, markedProject)).toBe(true);
		const moved = {
			...saved,
			segments: saved.segments.map((segment) =>
				segment.id === aVideo.id ? { ...segment, start: 0.5 } : segment
			),
		};
		expect(planIsCurrent(stamp, moved)).toBe(false);
		expect(planStamp(saved, 4)).toBeNull();
		expect(planIsCurrent(null, saved)).toBe(false);
	});

	test("detach batches cap distinct sources and clips per request", () => {
		const sources = Array.from({ length: 20 }, (_, index) =>
			camera(`Cam ${index}`)
		);
		const segments = sources.flatMap((source, index) => [
			newSegment(source, index * 10, 0),
			newSegment(source, index * 10 + 5, 0),
		]);
		const project = { ...newProject("Many"), segments };
		const batches = detachBatches(
			project,
			segments.map((segment) => segment.id)
		);
		expect(batches.map((batch) => batch.length)).toEqual([32, 8]);
		for (const batch of batches) {
			const assetIds = new Set(
				batch.map(
					(id) => segments.find((segment) => segment.id === id)?.assetId
				)
			);
			expect(assetIds.size).toBeLessThanOrEqual(16);
		}
		expect(
			detachBatches(
				project,
				segments.map((segment) => segment.id),
				16,
				10
			).map((batch) => batch.length)
		).toEqual([10, 10, 10, 10]);
	});
});

describe("edit responses", () => {
	test("accept a bare project with result fields or a wrapped project", () => {
		const { project } = twoTakes();
		const bare = projectEditResponse({ ...project, appliedOffset: -0.5 });
		expect(bare.project.id).toBe(project.id);
		expect(bare.extras).toEqual({ appliedOffset: -0.5 });
		const wrapped = projectEditResponse({ applied: [], project });
		expect(wrapped.project.segments).toHaveLength(4);
		expect(wrapped.extras).toEqual({ applied: [] });
		expect(() => projectEditResponse(null)).toThrow();
	});
});

describe("status and markers", () => {
	test("split-edit status names clamped offsets", () => {
		expect(splitEditStatus("none", 0, 0.5)).toBe("Straight cut restored.");
		expect(splitEditStatus("j", -0.5, 0.5)).toBe(
			"J-cut applied · J \u22120.50s."
		);
		expect(splitEditStatus("l", 0.2, 0.5)).toContain(
			"(limited by the source media)"
		);
		expect(splitEditStatus("l", 0, 0.5)).toContain("No source media");
	});

	test("highlight markers span the window and refuse duplicates", () => {
		const { project } = twoTakes();
		const marked = withHighlightMarker(
			project,
			{ end: 25.5, start: 10, title: "Why it matters" },
			1
		);
		expect(marked.markers).toEqual([
			expect.objectContaining({
				comment: "Why it matters",
				duration: 15.5,
				label: "Highlight 1",
				time: 10,
			}),
		]);
		expect(() =>
			withHighlightMarker(marked, { end: 12, start: 10, title: "Again" }, 2)
		).toThrow("already starts");
	});
});
