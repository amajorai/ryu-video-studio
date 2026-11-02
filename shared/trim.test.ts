import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	trimSegment,
	validateProject,
} from "./project.ts";

const asset: Asset = {
	createdAt: new Date().toISOString(),
	duration: 10,
	hasAudio: true,
	height: 180,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Footage",
	width: 320,
};

describe("timeline edge trimming", () => {
	test("trims the start in source time while preserving the moved timeline edge", () => {
		const segment = newSegment(asset, 2);
		const trimmed = trimSegment(segment, asset.duration, "start", 0.5);

		expect(trimmed.start).toBe(2.5);
		expect(trimmed.sourceIn).toBe(0.5);
		expect(trimmed.sourceOut).toBe(10);
	});

	test("clamps the end and replaces keyframes beyond it with a boundary keyframe", () => {
		const segment = {
			...newSegment(asset),
			sourceOut: 3,
			keyframes: [
				{
					id: crypto.randomUUID(),
					time: 1,
					property: "scale" as const,
					value: 1,
				},
				{
					id: crypto.randomUUID(),
					time: 3,
					property: "scale" as const,
					value: 1,
				},
			],
		};
		const trimmed = trimSegment(segment, asset.duration, "end", -1.5);

		expect(trimmed.sourceOut).toBe(1.5);
		expect(trimmed.keyframes.map((frame) => [frame.time, frame.value])).toEqual(
			[
				[1, 1],
				[1.5, 1],
			]
		);
	});

	test("re-bases keyframes onto the same source moment after a start-edge trim", () => {
		const volume = (time: number, value: number) => ({
			id: crypto.randomUUID(),
			property: "volume" as const,
			time,
			value,
		});
		const segment = {
			...newSegment(asset, 2),
			sourceIn: 2,
			sourceOut: 8,
			keyframes: [volume(0, 1), volume(1, 0), volume(3, 1)],
		};
		const trimmed = trimSegment(segment, asset.duration, "start", 0.5);
		expect(trimmed.keyframes.map((frame) => [frame.time, frame.value])).toEqual(
			[
				[0, 0.5],
				[0.5, 0],
				[2.5, 1],
			]
		);

		const extended = trimSegment(segment, asset.duration, "start", -1);
		expect(
			extended.keyframes.map((frame) => [frame.time, frame.value])
		).toEqual([
			[0, 1],
			[1, 1],
			[2, 0],
			[4, 1],
		]);
	});

	test("keeps head-trimmed keyframes inside the rounded clip duration", () => {
		const volume = (time: number, value: number) => ({
			id: crypto.randomUUID(),
			property: "volume" as const,
			time,
			value,
		});
		const long: Asset = { ...asset, duration: 100 };
		const segment = {
			...newSegment(long, 5),
			sourceIn: 11.01,
			sourceOut: 39.87,
			keyframes: [volume(0, 1), volume(39.87 - 11.01, 0)],
		};
		const trimmed = trimSegment(segment, long.duration, "start", 0.91);
		expect(() =>
			validateProject({ ...newProject("Trim"), segments: [trimmed] }, [long])
		).not.toThrow();
		expect(trimmed.keyframes.at(-1)?.value).toBeCloseTo(0, 5);

		for (let step = 1; step < 200; step += 1) {
			const sourceIn = 0.01 * step + 0.003;
			const sourceOut = sourceIn + 3.37 + 0.007 * step;
			const keyed = {
				...newSegment(long, 1),
				sourceIn,
				sourceOut,
				keyframes: [volume(0, 1), volume(sourceOut - sourceIn, 0.2)],
			};
			const next = trimSegment(keyed, long.duration, "start", 0.013 * step);
			expect(() =>
				validateProject({ ...newProject("Trim"), segments: [next] }, [long])
			).not.toThrow();
		}
	});
});
