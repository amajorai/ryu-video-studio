import { describe, expect, test } from "bun:test";
import { newProject, newSegment } from "../../../../shared/project.ts";
import { createTestRuntime, testVideo } from "../../editor/test-runtime.ts";
import { changeClipSpeed } from "./SpeedSection.tsx";

function setup(locked = false) {
	const asset = testVideo("clip.mp4", 10);
	const group = crypto.randomUUID();
	const picture = { ...newSegment(asset), linkGroupId: group, sourceOut: 2 };
	const sound = {
		...newSegment(asset, 0, 1),
		linkGroupId: group,
		sourceOut: 2,
	};
	const project = {
		...newProject("Speed"),
		segments: [picture, sound],
		trackSettings: locked
			? [
					{
						locked: true,
						muted: false,
						name: "Audio",
						solo: false,
						track: 1,
					},
				]
			: [],
	};
	return { picture, runtime: createTestRuntime(project, [asset]) };
}

describe("changeClipSpeed", () => {
	test("a 100x preset on a 2 s clip is limited and partners follow", () => {
		const { picture, runtime } = setup();
		changeClipSpeed(runtime, picture, 100);
		expect(runtime.project?.segments.map((segment) => segment.speed)).toEqual([
			50, 50,
		]);
		expect(runtime.calls).toContainEqual(["edit", "Change clip speed"]);
		const status = runtime.calls.find(([name]) => name === "setStatus");
		expect(String(status?.[1])).toContain("limited to 50x");
		expect(String(status?.[1])).toContain("linked clip followed");
	});

	test("a locked partner track refuses the change", () => {
		const { picture, runtime } = setup(true);
		changeClipSpeed(runtime, picture, 2);
		expect(runtime.project?.segments.map((segment) => segment.speed)).toEqual([
			1, 1,
		]);
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(false);
	});
});
