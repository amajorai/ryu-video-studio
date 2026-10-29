import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../../shared/project.ts";
import { createTestRuntime, testVideo } from "../test-runtime.ts";
import {
	decomposeSelection,
	nestActions,
	nestedProjectOf,
	nestSelection,
	selectedClipIds,
} from "./nest.ts";

function setup() {
	const camera = testVideo("camera.mp4", 10);
	const child = newProject("Nested intro");
	const sequence: Asset = {
		...testVideo("Sequence · Nested intro", 4),
		sequenceProjectId: child.id,
	};
	const plain = newSegment(camera, 0, 0);
	const nestedClip = newSegment(sequence, 12, 0);
	const project: Project = {
		...newProject("Parent"),
		segments: [plain, nestedClip],
	};
	const runtime = createTestRuntime(project, [camera, sequence]);
	runtime.projects = [project, child];
	const routed: [string, Record<string, unknown>][] = [];
	const extras: Record<string, unknown> = {};
	runtime.routeEdit = (action, body, describe) => {
		routed.push([action, body]);
		runtime.setStatus(describe(extras));
		return Promise.resolve({ extras, status: "ok" });
	};
	const select = (ids: string[]) => {
		runtime.selectedIds = ids;
		runtime.selectedId = ids[0] ?? null;
	};
	return { child, extras, nestedClip, plain, routed, runtime, select };
}

describe("nest actions", () => {
	test("register both planned shortcuts", () => {
		expect(Object.keys(nestActions).sort()).toEqual([
			"nest.decompose",
			"nest.nest",
		]);
	});

	test("selectedClipIds keeps timeline clips only, once each", () => {
		const { plain, runtime, select } = setup();
		select([plain.id, crypto.randomUUID(), plain.id]);
		expect(selectedClipIds(runtime)).toEqual([plain.id]);
	});

	test("nest declines without a selection and routes the clip ids", async () => {
		const { child, extras, nestedClip, plain, routed, runtime, select } =
			setup();
		select([]);
		expect(nestSelection(runtime)).toBe(false);
		expect(routed).toEqual([]);
		extras.clipId = nestedClip.id;
		extras.sequenceProject = { ...child, title: "Fresh nest" };
		select([plain.id]);
		expect(nestSelection(runtime)).toBeUndefined();
		await Bun.sleep(0);
		expect(routed).toEqual([["nest", { clipIds: [plain.id] }]]);
		expect(runtime.selectedId).toBe(nestedClip.id);
		expect(runtime.calls.map(([name]) => name)).toContain("setProjects");
	});

	test("decompose handles sequence clips only", async () => {
		const { extras, nestedClip, plain, routed, runtime, select } = setup();
		select([plain.id]);
		expect(decomposeSelection(runtime)).toBe(false);
		extras.clipIds = [plain.id];
		select([nestedClip.id]);
		expect(decomposeSelection(runtime)).toBeUndefined();
		await Bun.sleep(0);
		expect(routed).toEqual([["decompose", { clipId: nestedClip.id }]]);
	});

	test("nestedProjectOf finds the child of a selected sequence clip", () => {
		const { child, nestedClip, plain, runtime, select } = setup();
		select([plain.id]);
		expect(nestedProjectOf(runtime)).toBeUndefined();
		select([nestedClip.id]);
		expect(nestedProjectOf(runtime)?.id).toBe(child.id);
	});
});
