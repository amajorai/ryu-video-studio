import { expect, test } from "bun:test";
import {
	compileFfmpegExpression,
	evaluateFfmpegExpression,
} from "./ffmpeg-expression-eval.ts";

test("evaluates arithmetic with FFmpeg precedence", () => {
	expect(evaluateFfmpegExpression("1+2*3-4/2")).toBe(5);
	expect(evaluateFfmpegExpression("-(2)^2")).toBe(-4);
	expect(evaluateFfmpegExpression("0.5+(-0.25)*2")).toBe(0);
	expect(evaluateFfmpegExpression("2*PI")).toBeCloseTo(Math.PI * 2);
});

test("comparison and conditional functions return FFmpeg values", () => {
	const run = compileFfmpegExpression(
		"if(lt(T,1),0,if(between(T,1,2),max(0,(T-1))/1,1))"
	);
	expect(run({ T: 0.5 })).toBe(0);
	expect(run({ T: 1.5 })).toBe(0.5);
	expect(run({ T: 3 })).toBe(1);
	expect(
		evaluateFfmpegExpression("gte(X,W*0.5)*lt(Y,H)", {
			H: 4,
			W: 10,
			X: 5,
			Y: 3,
		})
	).toBe(1);
	expect(evaluateFfmpegExpression("ifnot(0,7,9)")).toBe(7);
});

test("rejects unknown names and malformed text", () => {
	expect(() => evaluateFfmpegExpression("foo(1)")).toThrow("Unsupported");
	expect(() => evaluateFfmpegExpression("t+1")).toThrow("Unknown variable");
	expect(() => evaluateFfmpegExpression("1+")).toThrow();
	expect(() => evaluateFfmpegExpression("(1")).toThrow();
});
