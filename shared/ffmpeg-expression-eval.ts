/**
 * Test helper: parse and evaluate the subset of FFmpeg's expression language
 * (`libavutil/eval.c`) that the render stages emit, so tests can compare a
 * generated filter expression with the JS value it must equal without
 * spawning FFmpeg. Supports numbers, `+ - * / ^`, unary signs, parentheses,
 * named variables, constants `PI`/`E`, and the functions listed in
 * `functions`. FFmpeg's comparison functions return 1 or 0, as here.
 */

type Node =
	| { kind: "number"; value: number }
	| { kind: "variable"; name: string }
	| { kind: "unary"; operand: Node; operator: "-" | "+" }
	| { kind: "binary"; left: Node; operator: string; right: Node }
	| { args: Node[]; kind: "call"; name: string };

const flag = (condition: boolean) => (condition ? 1 : 0);

const functions: Record<string, (...args: number[]) => number> = {
	abs: Math.abs,
	between: (x = 0, min = 0, max = 0) => flag(x >= min && x <= max),
	ceil: Math.ceil,
	clip: (x = 0, min = 0, max = 0) => Math.min(max, Math.max(min, x)),
	cos: Math.cos,
	eq: (a = 0, b = 0) => flag(a === b),
	floor: Math.floor,
	gt: (a = 0, b = 0) => flag(a > b),
	gte: (a = 0, b = 0) => flag(a >= b),
	isnan: (x = 0) => flag(Number.isNaN(x)),
	lt: (a = 0, b = 0) => flag(a < b),
	lte: (a = 0, b = 0) => flag(a <= b),
	max: (a = 0, b = 0) => Math.max(a, b),
	min: (a = 0, b = 0) => Math.min(a, b),
	not: (x = 0) => flag(x === 0),
	round: Math.round,
	sin: Math.sin,
	sqrt: Math.sqrt,
	trunc: Math.trunc,
};

const constants: Record<string, number> = { E: Math.E, PI: Math.PI };

class Parser {
	private index = 0;
	private readonly text: string;

	constructor(text: string) {
		this.text = text.replace(/\s+/g, "");
	}

	parse(): Node {
		const node = this.expression();
		if (this.index !== this.text.length) {
			throw new Error(
				`Unexpected "${this.text.slice(this.index, this.index + 12)}" at ${this.index}.`
			);
		}
		return node;
	}

	private peek(): string {
		return this.text[this.index] ?? "";
	}

	private expect(character: string) {
		if (this.peek() !== character) {
			throw new Error(`Expected "${character}" at ${this.index}.`);
		}
		this.index++;
	}

	private expression(): Node {
		let left = this.term();
		while (this.peek() === "+" || this.peek() === "-") {
			const operator = this.peek();
			this.index++;
			left = { kind: "binary", left, operator, right: this.term() };
		}
		return left;
	}

	private term(): Node {
		let left = this.unary();
		while (this.peek() === "*" || this.peek() === "/") {
			const operator = this.peek();
			this.index++;
			left = { kind: "binary", left, operator, right: this.unary() };
		}
		return left;
	}

	private unary(): Node {
		const sign = this.peek();
		if (sign === "-" || sign === "+") {
			this.index++;
			return { kind: "unary", operand: this.unary(), operator: sign };
		}
		return this.power();
	}

	private power(): Node {
		const base = this.primary();
		if (this.peek() === "^") {
			this.index++;
			return { kind: "binary", left: base, operator: "^", right: this.unary() };
		}
		return base;
	}

	private primary(): Node {
		if (this.peek() === "(") {
			this.index++;
			const inner = this.expression();
			this.expect(")");
			return inner;
		}
		const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(
			this.text.slice(this.index)
		);
		if (number) {
			this.index += number[0].length;
			return { kind: "number", value: Number(number[0]) };
		}
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.index));
		if (!name) {
			throw new Error(`Unexpected "${this.peek()}" at ${this.index}.`);
		}
		this.index += name[0].length;
		if (this.peek() !== "(") {
			return { kind: "variable", name: name[0] };
		}
		this.index++;
		const args: Node[] = [];
		if (this.peek() !== ")") {
			args.push(this.expression());
			while (this.peek() === ",") {
				this.index++;
				args.push(this.expression());
			}
		}
		this.expect(")");
		return { args, kind: "call", name: name[0] };
	}
}

function evaluate(node: Node, variables: Record<string, number>): number {
	switch (node.kind) {
		case "number":
			return node.value;
		case "variable": {
			const value = variables[node.name] ?? constants[node.name];
			if (value === undefined) {
				throw new Error(`Unknown variable ${node.name}.`);
			}
			return value;
		}
		case "unary": {
			const value = evaluate(node.operand, variables);
			return node.operator === "-" ? -value : value;
		}
		case "binary": {
			const left = evaluate(node.left, variables);
			const right = evaluate(node.right, variables);
			switch (node.operator) {
				case "+":
					return left + right;
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return left / right;
				default:
					return left ** right;
			}
		}
		default:
			return evaluateCall(node, variables);
	}
}

function evaluateCall(
	node: Extract<Node, { kind: "call" }>,
	variables: Record<string, number>
): number {
	const [first, second, third] = node.args;
	if (node.name === "if" || node.name === "ifnot") {
		if (!(first && second)) {
			throw new Error(`${node.name} needs two or three arguments.`);
		}
		const condition = evaluate(first, variables) !== 0;
		const chosen = condition === (node.name === "if") ? second : third;
		return chosen ? evaluate(chosen, variables) : 0;
	}
	const run = functions[node.name];
	if (!run) {
		throw new Error(`Unsupported function ${node.name}.`);
	}
	return run(...node.args.map((arg) => evaluate(arg, variables)));
}

/** Evaluate an FFmpeg expression with the given variables. */
export function evaluateFfmpegExpression(
	expression: string,
	variables: Record<string, number> = {}
): number {
	return evaluate(new Parser(expression).parse(), variables);
}

/** Parse once and evaluate many times (for dense sampling in tests). */
export function compileFfmpegExpression(
	expression: string
): (variables: Record<string, number>) => number {
	const node = new Parser(expression).parse();
	return (variables) => evaluate(node, variables);
}
