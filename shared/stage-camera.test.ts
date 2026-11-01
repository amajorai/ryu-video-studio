import { describe, expect, test } from "bun:test";
import {
	stageCameraAtTime,
	stageCameraExpression,
	stageCameraValueBounds,
} from "./stage-camera.ts";

const camera = {
	orbit: 0,
	tilt: 0,
	x: 0,
	y: 0,
	zoom: 1,
	keyframes: [
		{ id: crypto.randomUUID(), property: "x" as const, time: 0, value: -0.5 },
		{ id: crypto.randomUUID(), property: "x" as const, time: 4, value: 0.5 },
		{ id: crypto.randomUUID(), property: "zoom" as const, time: 0, value: 1 },
		{ id: crypto.randomUUID(), property: "zoom" as const, time: 4, value: 1.5 },
	],
};

describe("stage camera paths", () => {
	test("interpolates camera values at timeline time", () => {
		expect(stageCameraAtTime(camera, 2)).toMatchObject({ x: 0, zoom: 1.25 });
		expect(stageCameraAtTime(camera, 6)).toMatchObject({ x: 0.5, zoom: 1.5 });
	});

	test("builds a matching FFmpeg interpolation expression", () => {
		const expression = stageCameraExpression(camera, "x");
		expect(expression).toContain("if(lt(t,4)");
		expect(expression).toContain("-0.5+(0.5--0.5)*");
	});

	test("keeps zoom bounds separate from normalized camera coordinates", () => {
		expect(stageCameraValueBounds("zoom")).toEqual({ max: 2, min: 0.5 });
		expect(stageCameraValueBounds("orbit")).toEqual({ max: 1, min: -1 });
	});
});
