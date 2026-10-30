import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	type Project,
} from "../../../shared/project.ts";
import { createTestRuntime } from "../editor/test-runtime.ts";
import { addLibraryAsset, libraryTrackFor } from "./add-to-timeline.ts";

function media(name: string, kind: Asset["kind"]): Asset {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 12,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

function added(project: Project | null | undefined, asset: Asset) {
	return project?.segments.find((segment) => segment.assetId === asset.id);
}

describe("addLibraryAsset", () => {
	test("audio lands on track 1 with or without a marked range", () => {
		const anthem = media("Anthem", "audio");
		const whole = createTestRuntime(newProject("A"), [anthem]);
		addLibraryAsset(whole, anthem);
		expect(added(whole.project, anthem)?.track).toBe(1);

		const marked = createTestRuntime(newProject("B"), [anthem]);
		addLibraryAsset(marked, anthem, { end: 3, start: 1 });
		const segment = added(marked.project, anthem);
		expect(segment?.track).toBe(1);
		expect(segment?.sourceIn).toBe(1);
		expect(segment?.sourceOut).toBe(3);
	});

	test("video with a marked range lands on track 0 at the end", () => {
		const beach = media("Beach", "video");
		const runtime = createTestRuntime(newProject("C"), [beach]);
		addLibraryAsset(runtime, beach, { end: 9, start: 3 });
		const segment = added(runtime.project, beach);
		expect(segment?.track).toBe(0);
		expect(segment?.sourceIn).toBe(3);
		expect(segment?.sourceOut).toBe(9);
		expect(runtime.calls).toContainEqual(["edit", "Add Beach"]);
	});

	test("tracks match Insert at playhead", () => {
		expect(libraryTrackFor({ kind: "audio" })).toBe(1);
		expect(libraryTrackFor({ kind: "video" })).toBe(0);
		expect(libraryTrackFor({ kind: "image" })).toBe(0);
	});

	test("without a project nothing is added", () => {
		const beach = media("Beach", "video");
		const runtime = createTestRuntime(null, [beach]);
		addLibraryAsset(runtime, beach, { end: 2, start: 1 });
		expect(runtime.project).toBeNull();
	});
});
