import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Asset, Project, Segment } from "../../shared/project.ts";
import { segmentDuration } from "../../shared/project.ts";
import * as transitions from "./render-stages/transitions.ts";

/**
 * Regression: the reveal stage must receive the same `previous` clip in a frame
 * preview as in the export. `revealFilters` is wrapped with a recorder that
 * delegates to the real stage, so output is unchanged for other suites.
 */
const realRevealFilters = transitions.revealFilters;
const calls: [string, string | undefined][] = [];
mock.module("./render-stages/transitions.ts", () => ({
	...transitions,
	revealFilters: (
		segment: Segment,
		previous: Segment | undefined,
		length: number
	) => {
		calls.push([segment.id, previous?.id]);
		return realRevealFilters(segment, previous, length);
	},
}));
const { buildRender } = await import("./render.ts");

interface Fixture {
	assets: Asset[];
	project: Project;
}

const fixture: Fixture = JSON.parse(
	readFileSync(
		join(import.meta.dir, "__fixtures__", "render", "multi-track.json"),
		"utf8"
	)
);
const mediaPath = (id: string) => `/media/${id}`;

function recordedPrevious(project: Project, frameTime?: number) {
	calls.length = 0;
	buildRender(project, fixture.assets, mediaPath, undefined, [], frameTime);
	return new Map(calls);
}

function shiftedProject(): Project {
	const project: Project = structuredClone(fixture.project);
	const first = project.segments.find((s) => s.id.endsWith("007"));
	const moved = project.segments.find((s) => s.id.endsWith("010"));
	if (!(first && moved)) {
		throw new Error("The multi-track fixture changed.");
	}
	moved.track = first.track;
	moved.start = first.start + segmentDuration(first);
	moved.entryTransition = "crossfade";
	return project;
}

test("a frame preview and an export hand the reveal stage the same previous clip", () => {
	const project = shiftedProject();
	const exported = recordedPrevious(project);
	const moved = project.segments.find((s) => s.id.endsWith("010"));
	const first = project.segments.find((s) => s.id.endsWith("007"));
	expect(exported.get(moved?.id ?? "")).toBe(first?.id);
	for (const segment of project.segments) {
		if (!exported.has(segment.id)) {
			continue;
		}
		const frame = recordedPrevious(
			project,
			segment.start + segmentDuration(segment) / 2
		);
		expect(frame.get(segment.id)).toBe(exported.get(segment.id));
	}
});

test("an audio-only clip is never the previous clip of a reveal", () => {
	const project = shiftedProject();
	const audioClip = project.segments.find((s) => {
		const asset = fixture.assets.find((a) => a.id === s.assetId);
		return asset?.kind === "audio" && s.visualization !== "waveform";
	});
	const moved = project.segments.find((s) => s.id.endsWith("010"));
	if (!(audioClip && moved)) {
		throw new Error("The multi-track fixture changed.");
	}
	audioClip.track = moved.track;
	audioClip.start = Math.max(0, moved.start - 0.5);
	const exported = recordedPrevious(project);
	expect([...exported.values()]).not.toContain(audioClip.id);
	expect(exported.get(moved.id)).toBe(
		project.segments.find((s) => s.id.endsWith("007"))?.id
	);
});
