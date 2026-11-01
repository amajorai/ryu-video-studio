/**
 * A tiny expression tree shared by the render and the preview (W2-V10).
 *
 * Transition and clip-animation curves are written once as `Expr` values and
 * then either printed as FFmpeg expressions (`geq`, `scale`, `rotate`,
 * `overlay`) or evaluated in JavaScript for the CSS preview and for tests, so
 * both sides compute the same numbers from the same definition.
 */

/** Free variables: clip-local seconds, and the pixel position and frame size. */
export type ExprVar = "t" | "x" | "y" | "w" | "h";

type Op =
	| "abs"
	| "add"
	| "atan2"
	| "clip"
	| "cos"
	| "div"
	| "hypot"
	| "if"
	| "lt"
	| "max"
	| "min"
	| "mul"
	| "sin"
	| "sub";

export type Expr = number | ExprVar | { args: Expr[]; op: Op };

/** Build a node, folding it to a number when every argument is constant. */
function node(op: Op, args: Expr[]): Expr {
	if (args.every((arg) => typeof arg === "number")) {
		return evaluateOp(op, args as number[]);
	}
	return { args, op };
}

/** Sum, dropping zero terms. */
export function add(...args: Expr[]): Expr {
	const terms = args.filter((arg) => arg !== 0);
	if (terms.length <= 1) {
		return terms[0] ?? 0;
	}
	return node("add", terms);
}
export const sub = (a: Expr, b: Expr): Expr =>
	b === 0 ? a : node("sub", [a, b]);
/** Product, dropping unit factors; any zero factor makes it 0. */
export function mul(...args: Expr[]): Expr {
	if (args.includes(0)) {
		return 0;
	}
	const factors = args.filter((arg) => arg !== 1);
	if (factors.length <= 1) {
		return factors[0] ?? 1;
	}
	return node("mul", factors);
}
export const div = (a: Expr, b: Expr): Expr =>
	b === 1 ? a : node("div", [a, b]);
export const min = (a: Expr, b: Expr): Expr => node("min", [a, b]);
export const max = (a: Expr, b: Expr): Expr => node("max", [a, b]);
export const abs = (a: Expr): Expr => node("abs", [a]);
export const sin = (a: Expr): Expr => node("sin", [a]);
export const cos = (a: Expr): Expr => node("cos", [a]);
export const hypot = (a: Expr, b: Expr): Expr => node("hypot", [a, b]);
/** Angle of the vector (x, y) — argument order matches `Math.atan2(y, x)`. */
export const atan2 = (y: Expr, x: Expr): Expr => node("atan2", [y, x]);
export const clip = (value: Expr, low: Expr, high: Expr): Expr =>
	node("clip", [value, low, high]);
/** 1 when `a < b`, else 0. */
export const lt = (a: Expr, b: Expr): Expr => node("lt", [a, b]);
/** `then` when `condition` is non-zero, else `otherwise`. */
export const ifElse = (condition: Expr, then: Expr, otherwise: Expr): Expr =>
	node("if", [condition, then, otherwise]);

/** Clamp to 0..1. */
export const unit = (value: Expr): Expr => clip(value, 0, 1);

/** Smoothstep easing `p²(3−2p)` of a 0..1 progress. */
export const smooth = (progress: Expr): Expr =>
	mul(progress, progress, sub(3, mul(2, progress)));

/** Ease-out cubic `1−(1−p)³` of a 0..1 progress. */
export const easeOut = (progress: Expr): Expr => {
	const rest = sub(1, progress);
	return sub(1, mul(rest, rest, rest));
};

function evaluateOp(op: Op, values: number[]): number {
	const [a = 0, b = 0, c = 0] = values;
	switch (op) {
		case "abs":
			return Math.abs(a);
		case "add":
			return values.reduce((sum, value) => sum + value, 0);
		case "atan2":
			return Math.atan2(a, b);
		case "clip":
			return Math.min(c, Math.max(b, a));
		case "cos":
			return Math.cos(a);
		case "div":
			return b === 0 ? Number.NaN : a / b;
		case "hypot":
			return Math.hypot(a, b);
		case "if":
			return a === 0 ? c : b;
		case "lt":
			return a < b ? 1 : 0;
		case "max":
			return Math.max(a, b);
		case "min":
			return Math.min(a, b);
		case "mul":
			return values.reduce((product, value) => product * value, 1);
		case "sin":
			return Math.sin(a);
		case "sub":
			return a - b;
		default:
			throw new Error(`Unknown expression operator ${op satisfies never}.`);
	}
}

export type ExprEnv = Partial<Record<ExprVar, number>>;

/** Evaluate in JavaScript; unset variables read as 0. */
export function evaluate(expr: Expr, env: ExprEnv): number {
	if (typeof expr === "number") {
		return expr;
	}
	if (typeof expr === "string") {
		return env[expr] ?? 0;
	}
	return evaluateOp(
		expr.op,
		expr.args.map((arg) => evaluate(arg, env))
	);
}

/** Shortest round-trippable decimal, at most 6 places, negatives parenthesized. */
export function formatNumber(value: number): string {
	const rounded = Number(value.toFixed(6));
	const text = Object.is(rounded, -0) ? "0" : `${rounded}`;
	return rounded < 0 ? `(${text})` : text;
}

/** FFmpeg spelling of each variable in one filter's expression context. */
export type ExprNames = Partial<Record<ExprVar, string>>;

const functionOps: Partial<Record<Op, string>> = {
	abs: "abs",
	atan2: "atan2",
	clip: "clip",
	cos: "cos",
	hypot: "hypot",
	if: "if",
	lt: "lt",
	max: "max",
	min: "min",
	sin: "sin",
};
const infixOps: Partial<Record<Op, string>> = {
	add: "+",
	div: "/",
	mul: "*",
	sub: "-",
};

/** Print as an FFmpeg (libavutil `eval`) expression. */
export function toFfmpeg(expr: Expr, names: ExprNames): string {
	if (typeof expr === "number") {
		return formatNumber(expr);
	}
	if (typeof expr === "string") {
		const name = names[expr];
		if (name === undefined) {
			throw new Error(`No FFmpeg name for the expression variable ${expr}.`);
		}
		return name;
	}
	const args = expr.args.map((arg) => toFfmpeg(arg, names));
	const infix = infixOps[expr.op];
	if (infix) {
		return `(${args.join(infix)})`;
	}
	return `${functionOps[expr.op]}(${args.join(",")})`;
}

/** Whether the expression is a constant equal to `value`. */
export const isConstant = (expr: Expr, value: number): boolean =>
	typeof expr === "number" && expr === value;
