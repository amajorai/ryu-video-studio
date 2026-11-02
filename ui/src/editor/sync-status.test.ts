import { afterEach, expect, test } from "bun:test";
import { syncProject } from "./project-actions.ts";
import { createTestRuntime, lastStatus, testProject } from "./test-runtime.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function serveSync(response: unknown) {
	const received: unknown[] = [];
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			ryu: {
				app: {
					request: (input: unknown) => {
						received.push(input);
						return Promise.resolve(response);
					},
				},
			},
		},
	});
	return received;
}

afterEach(() => {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

test("a real sync reports drift corrections and warnings in the status", async () => {
	const { asset, first, project, second } = testProject();
	const runtime = createTestRuntime(project, [asset]);
	const warning =
		"Measured clock drift of 0.80% exceeds the ±0.5% correction limit.";
	const received = serveSync({
		matches: [
			{
				alignmentOffsetSeconds: 0.2,
				clipId: second.id,
				confidence: 0.91,
				drift: { driftPercent: 0.8, status: "too-large" },
				method: "audio",
				offsetSeconds: 0.2,
			},
		],
		project: { ...project, revision: project.revision + 1 },
		shiftedFrames: 6,
		warnings: [warning],
	});
	await syncProject(runtime, {
		driftCorrection: true,
		mode: "auto",
		referenceClipId: first.id,
		targetClipIds: [second.id],
	});
	expect(received).toHaveLength(1);
	expect(
		(received[0] as { body: { driftCorrection: boolean } }).body.driftCorrection
	).toBe(true);
	expect(lastStatus(runtime)).toBe(
		`Aligned 1 clip · confidence 91%. ${warning}`
	);
});

test("a corrected drift is named and a response without drift details still parses", async () => {
	const { asset, first, project, second } = testProject();
	const runtime = createTestRuntime(project, [asset]);
	serveSync({
		matches: [
			{
				alignmentOffsetSeconds: 0,
				confidence: 0.8,
				drift: { speed: 1.002, status: "corrected" },
				method: "audio",
				offsetSeconds: 0,
			},
		],
		project: { ...project, revision: project.revision + 1 },
		shiftedFrames: 0,
	});
	await syncProject(runtime, {
		mode: "auto",
		referenceClipId: first.id,
		targetClipIds: [second.id],
	});
	expect(lastStatus(runtime)).toBe(
		"Aligned 1 clip · confidence 80%. Clock drift corrected on 1 clip."
	);

	serveSync({
		matches: [
			{
				alignmentOffsetSeconds: 1,
				confidence: 1,
				method: "manual",
				offsetSeconds: 1,
			},
		],
		project: { ...project, revision: project.revision + 2 },
		shiftedFrames: 30,
	});
	await syncProject(runtime, {
		mode: "manual",
		offsetSeconds: 1,
		referenceClipId: first.id,
		targetClipIds: [second.id],
	});
	expect(lastStatus(runtime)).toBe("Shifted 1 clip · confidence 100%.");
});
