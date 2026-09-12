import { expect, test } from "bun:test";
import { generateStageWorld } from "./stage-world.ts";

test("stage world generation creates an editable world and camera path", () => {
	const world = generateStageWorld(
		"A coastal mountain village with a river and a beacon",
		4
	);

	expect(world.prompt).toContain("coastal");
	expect(world.objects).toHaveLength(8);
	expect(world.objects.every((object) => object.start === 4)).toBe(true);
	expect(world.objects.every((object) => object.end === 16)).toBe(true);
	expect(world.camera.keyframes).toHaveLength(15);
	expect(world.camera.keyframes?.some((keyframe) => keyframe.time === 10)).toBe(
		true
	);
});

test("stage world generation is deterministic for the same direction", () => {
	const first = generateStageWorld("A moonlit forest with a river");
	const second = generateStageWorld("A moonlit forest with a river");

	expect(first.objects.map((object) => object.fill)).toEqual(
		second.objects.map((object) => object.fill)
	);
	expect(first.camera.keyframes?.map((keyframe) => keyframe.value)).toEqual(
		second.camera.keyframes?.map((keyframe) => keyframe.value)
	);
});

test("stage world generation rejects empty and oversized directions", () => {
	expect(() => generateStageWorld(" ")).toThrow();
	expect(() => generateStageWorld("x".repeat(401))).toThrow();
});
