import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	assetSchema,
	type Project,
	projectSchema,
	updateTrackSetting,
} from "../../../shared/project.ts";
import { buildRender } from "../render.ts";
import {
	segmentAudible,
	segmentDrawsVideo,
	segmentVisible,
} from "./visibility.ts";

/** The golden multi-track fixture: video on 0, two stills on 1, audio on 2-4 (4 muted). */
const fixture = z
	.object({
		assets: z.array(assetSchema),
		frameTimes: z.array(z.number()),
		project: projectSchema,
	})
	.passthrough()
	.parse(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dir,
					"..",
					"__fixtures__",
					"render",
					"multi-track.json"
				),
				"utf8"
			)
		)
	);

const mediaPath = (id: string, clipId?: string) =>
	`/media/${id}${clipId ? `#${clipId}` : ""}`;

function filterGraph(project: Project): string {
	const args = buildRender(project, fixture.assets, mediaPath);
	const index = args.indexOf("-filter_complex");
	return args[index + 1] ?? "";
}

const count = (graph: string, pattern: RegExp) =>
	graph.match(pattern)?.length ?? 0;
const overlays = (graph: string) => count(graph, /overlay=/g);
const mixInputs = (graph: string) =>
	Number(/amix=inputs=(\d+)/.exec(graph)?.[1] ?? 0);

describe("render visibility", () => {
	const legacy = filterGraph(fixture.project);

	test("hiding a track that holds only stills drops their overlays and leaves the mix alone", () => {
		const hidden = updateTrackSetting(fixture.project, 1, { hidden: true });
		const graph = filterGraph(hidden);
		expect(overlays(legacy)).toBeGreaterThan(0);
		expect(mixInputs(legacy)).toBeGreaterThan(1);
		expect(overlays(graph)).toBe(overlays(legacy) - 2);
		expect(mixInputs(graph)).toBe(mixInputs(legacy));
	});

	test("a hidden clip drops only that clip's overlay", () => {
		const [base, still] = fixture.project.segments;
		if (!(base && still)) {
			throw new Error("fixture changed");
		}
		const graph = filterGraph({
			...fixture.project,
			segments: fixture.project.segments.map((segment) =>
				segment.id === still.id ? { ...segment, hidden: true } : segment
			),
		});
		expect(overlays(graph)).toBe(overlays(legacy) - 1);
	});

	test("a hidden audio track leaves the audio mix", () => {
		const hidden = updateTrackSetting(fixture.project, 3, { hidden: true });
		const graph = filterGraph(hidden);
		expect(mixInputs(graph)).toBe(mixInputs(legacy) - 1);
		expect(overlays(graph)).toBe(overlays(legacy));
	});

	test("a hidden audio clip leaves the audio mix", () => {
		const music = fixture.project.segments.find(
			(segment) => segment.track === 3
		);
		if (!music) {
			throw new Error("fixture changed");
		}
		const graph = filterGraph({
			...fixture.project,
			segments: fixture.project.segments.map((segment) =>
				segment.id === music.id ? { ...segment, hidden: true } : segment
			),
		});
		expect(mixInputs(graph)).toBe(mixInputs(legacy) - 1);
		expect(overlays(graph)).toBe(overlays(legacy));
	});

	test("a muted clip leaves the audio mix", () => {
		const music = fixture.project.segments.find(
			(segment) => segment.track === 3
		);
		if (!music) {
			throw new Error("fixture changed");
		}
		const graph = filterGraph({
			...fixture.project,
			segments: fixture.project.segments.map((segment) =>
				segment.id === music.id ? { ...segment, muted: true } : segment
			),
		});
		expect(mixInputs(graph)).toBe(mixInputs(legacy) - 1);
		expect(overlays(graph)).toBe(overlays(legacy));
	});

	test("explicit visible defaults, sync lock, and height leave the argv unchanged", () => {
		let explicit = updateTrackSetting(fixture.project, 0, {
			height: "large",
			hidden: false,
			syncLocked: false,
		});
		explicit = {
			...explicit,
			segments: explicit.segments.map((segment) => ({
				...segment,
				hidden: false,
				muted: false,
			})),
		};
		expect(filterGraph(explicit)).toBe(legacy);
	});
});

describe("visibility stage", () => {
	const project = fixture.project;
	const [video] = fixture.assets;
	const [base] = project.segments;
	if (!(video && base)) {
		throw new Error("fixture changed");
	}

	test("segmentVisible follows clip and track hiding", () => {
		expect(segmentVisible(project, base)).toBe(true);
		expect(segmentVisible(project, { ...base, hidden: true })).toBe(false);
		expect(
			segmentVisible(updateTrackSetting(project, 0, { hidden: true }), base)
		).toBe(false);
		expect(segmentDrawsVideo(project, { ...base, hidden: true }, video)).toBe(
			false
		);
	});

	test("segmentAudible requires an unmuted, visible clip", () => {
		expect(segmentAudible(project, base, video)).toBe(true);
		expect(segmentAudible(project, { ...base, muted: true }, video)).toBe(
			false
		);
		// Hiding a clip or its track silences it in the export, as in the
		// preview (which does not mount hidden clips).
		expect(segmentAudible(project, { ...base, hidden: true }, video)).toBe(
			false
		);
		expect(
			segmentAudible(
				updateTrackSetting(project, 0, { hidden: true }),
				base,
				video
			)
		).toBe(false);
		// High-speed clips are muted unless explicitly kept (`muted: false`).
		expect(segmentAudible(project, { ...base, speed: 20 }, video)).toBe(false);
		expect(
			segmentAudible(project, { ...base, muted: false, speed: 20 }, video)
		).toBe(true);
	});
});
