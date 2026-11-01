import { describe, expect, test } from "bun:test";
import {
	assetUsage,
	deleteManyAssetsRequestSchema,
	describeAssetDeletion,
	MAX_BULK_ASSET_IDS,
	planAssetDeletion,
} from "./asset-usage.ts";
import { type Asset, newProject, newSegment, type Project } from "./project.ts";

function asset(name: string, kind: Asset["kind"] = "video"): Asset {
	return {
		id: crypto.randomUUID(),
		name,
		kind,
		duration: 8,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: kind !== "image",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function projectWith(title: string, edit: (project: Project) => Project) {
	return edit(newProject(title));
}

describe("asset usage", () => {
	test("finds clip references and nested references alike", () => {
		const clip = asset("Clip");
		const scene = asset("Scene");
		const unused = asset("Unused");
		const edit = projectWith("Edit", (project) => ({
			...project,
			segments: [newSegment(clip)],
		}));
		const board = projectWith("Board", (project) => ({
			...project,
			scenes: [
				{
					id: crypto.randomUUID(),
					title: "Opening",
					assetIds: [scene.id],
				} as unknown as Project["scenes"][number],
			],
		}));
		const usage = assetUsage([edit, board], [clip.id, scene.id, unused.id]);
		expect(usage.get(clip.id)).toEqual([{ id: edit.id, title: "Edit" }]);
		expect(usage.get(scene.id)).toEqual([{ id: board.id, title: "Board" }]);
		expect(usage.get(unused.id)).toEqual([]);
	});

	test("a project's own id is not a reference", () => {
		const project = newProject("Self");
		expect(assetUsage([project], [project.id]).get(project.id)).toEqual([]);
	});

	test("lists every project that uses an asset once", () => {
		const clip = asset("Shared");
		const first = projectWith("First", (project) => ({
			...project,
			segments: [newSegment(clip), newSegment(clip, 8)],
		}));
		const second = projectWith("Second", (project) => ({
			...project,
			segments: [newSegment(clip)],
		}));
		expect(assetUsage([first, second], [clip.id]).get(clip.id)).toEqual([
			{ id: first.id, title: "First" },
			{ id: second.id, title: "Second" },
		]);
	});
});

describe("bulk deletion plan", () => {
	test("refuses in-use and unknown assets, keeps request order, drops duplicates", () => {
		const used = asset("Interview");
		const free = asset("Outtake");
		const music = asset("Music", "audio");
		const missing = crypto.randomUUID();
		const project = projectWith("Cut", (current) => ({
			...current,
			segments: [newSegment(used)],
		}));
		const plan = planAssetDeletion(
			[used, free, music],
			[project],
			[music.id, used.id, missing, free.id, music.id]
		);
		expect(plan.deletable).toEqual([music.id, free.id]);
		expect(plan.refused).toEqual([
			{
				id: used.id,
				name: "Interview",
				projects: [{ id: project.id, title: "Cut" }],
				reason: "in-use",
			},
			{ id: missing, projects: [], reason: "not-found" },
		]);
	});

	test("requests are strict and bounded", () => {
		const id = crypto.randomUUID();
		expect(deleteManyAssetsRequestSchema.safeParse({ ids: [id] }).success).toBe(
			true
		);
		for (const body of [
			{ ids: [] },
			{ ids: ["not-a-uuid"] },
			{ ids: [id], force: true },
			{
				ids: Array.from({ length: MAX_BULK_ASSET_IDS + 1 }, () =>
					crypto.randomUUID()
				),
			},
		]) {
			expect(deleteManyAssetsRequestSchema.safeParse(body).success).toBe(false);
		}
	});

	test("summaries name the kept media and their projects", () => {
		const id = crypto.randomUUID();
		expect(describeAssetDeletion({ deleted: [id], refused: [] })).toBe(
			"Deleted 1 media item."
		);
		expect(
			describeAssetDeletion({
				deleted: [],
				refused: [
					{
						id,
						name: "Interview",
						projects: [{ id: crypto.randomUUID(), title: "Cut" }],
						reason: "in-use",
					},
					{ id: crypto.randomUUID(), projects: [], reason: "not-found" },
				],
			})
		).toBe(
			"Deleted 0 media items. Kept 1 in use: Interview (used in Cut). Remove their clips first. 1 item was not found."
		);
	});
});
