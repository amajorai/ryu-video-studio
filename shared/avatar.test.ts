import { describe, expect, test } from "bun:test";
import {
	type AvatarRigKeyframe,
	avatarPoseAtTime,
	avatarRigExpression,
	LINEAR_RIG_EXPRESSION_MAX,
} from "./avatar.ts";

/**
 * Evaluates the FFmpeg expression subset the rig emits (numbers, `t`,
 * `+ - * /`, parentheses, `if`, `lt`) so tests can compare it with the
 * preview's `avatarPoseAtTime` without spawning FFmpeg.
 */
function evaluate(expression: string, t: number): number {
	let position = 0;
	const peek = () => expression[position] ?? "";
	const expect = (token: string) => {
		if (!expression.startsWith(token, position)) {
			throw new Error(`Expected ${token} at ${position}`);
		}
		position += token.length;
	};
	const primary = (): number => {
		if (peek() === "(") {
			expect("(");
			const value = sum();
			expect(")");
			return value;
		}
		if (peek() === "-") {
			expect("-");
			return -primary();
		}
		if (expression.startsWith("if(", position)) {
			expect("if(");
			const condition = sum();
			expect(",");
			const yes = sum();
			expect(",");
			const no = sum();
			expect(")");
			return condition === 0 ? no : yes;
		}
		if (expression.startsWith("lt(", position)) {
			expect("lt(");
			const left = sum();
			expect(",");
			const right = sum();
			expect(")");
			return left < right ? 1 : 0;
		}
		if (peek() === "t") {
			expect("t");
			return t;
		}
		const match = /^\d+(\.\d+)?(e-?\d+)?/.exec(expression.slice(position));
		if (!match) {
			throw new Error(`Unexpected ${peek()} at ${position}`);
		}
		position += match[0].length;
		return Number(match[0]);
	};
	const product = (): number => {
		let value = primary();
		while (peek() === "*" || peek() === "/") {
			const operator = peek();
			position += 1;
			const right = primary();
			value = operator === "*" ? value * right : value / right;
		}
		return value;
	};
	const sum = (): number => {
		let value = product();
		while (peek() === "+" || peek() === "-") {
			const operator = peek();
			position += 1;
			const right = product();
			value = operator === "+" ? value + right : value - right;
		}
		return value;
	};
	const result = sum();
	if (position !== expression.length) {
		throw new Error(`Trailing input at ${position}`);
	}
	return result;
}

function maxDepth(expression: string): number {
	let depth = 0;
	let max = 0;
	for (const character of expression) {
		if (character === "(") {
			depth += 1;
			max = Math.max(max, depth);
		} else if (character === ")") {
			depth -= 1;
		}
	}
	return max;
}

const id = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function mouthKeyframes(count: number): AvatarRigKeyframe[] {
	return Array.from({ length: count }, (_, index) => ({
		id: id(index + 1),
		property: "mouth",
		time: 0.25 + index * 0.05,
		value: Math.round(((Math.sin(index * 1.7) + 1) / 2) * 1000) / 1000,
	}));
}

const rig = (keyframes: AvatarRigKeyframe[], start = 2) => ({
	animation: "none" as const,
	pose: "neutral" as const,
	rigKeyframes: keyframes,
	start,
});

describe("avatarRigExpression", () => {
	test("short keyframe lists keep the linear chain", () => {
		const keyframes = mouthKeyframes(3);
		expect(avatarRigExpression(rig(keyframes), "mouth")).toBe(
			"if(lt((t-2),0.25),0.5,if(lt((t-2),0.3),0.5+(0.996-(0.5))*((t-2)-0.25)/0.04999999999999999,if(lt((t-2),0.35),0.996+(0.372-(0.996))*((t-2)-0.3)/0.04999999999999999,0.372)))"
		);
	});

	test("properties without keyframes use the pose default", () => {
		expect(avatarRigExpression(rig([]), "mouth")).toBe("(0.12+0)");
	});

	for (const count of [
		1,
		2,
		LINEAR_RIG_EXPRESSION_MAX,
		LINEAR_RIG_EXPRESSION_MAX + 1,
		57,
		100,
	]) {
		test(`${count} keyframes evaluate like the preview`, () => {
			const avatar = rig(mouthKeyframes(count));
			const expression = avatarRigExpression(avatar, "mouth");
			for (
				let time = 1.9;
				time < 2 + 0.25 + count * 0.05 + 0.3;
				time += 0.013
			) {
				expect(evaluate(expression, time)).toBeCloseTo(
					avatarPoseAtTime(avatar, time).mouth,
					9
				);
			}
		});
	}

	test("100 keyframes stay far below FFmpeg's nesting limit", () => {
		const expression = avatarRigExpression(rig(mouthKeyframes(100)), "mouth");
		expect(maxDepth(expression)).toBeLessThan(40);
	});
});
