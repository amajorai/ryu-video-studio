import { describe, expect, test } from "bun:test";
import { revealTransitions } from "../../../shared/reveal-transitions.ts";
import {
	demoAnimationName,
	demoCut,
	transitionDemoKeyframes,
} from "./transition-demo.ts";
import {
	carriesTransition,
	readTransitionDrag,
	TRANSITION_DRAG_TYPE,
	writeTransitionDrag,
} from "./transition-drag.ts";

function transfer() {
	const data = new Map<string, string>();
	return {
		getData: (format: string) => data.get(format) ?? "",
		setData: (format: string, value: string) => {
			data.set(format, value);
		},
		get types() {
			return [...data.keys()];
		},
	};
}

describe("transition drag payload", () => {
	test("round-trips a transition and ignores other drags", () => {
		const dragged = transfer();
		writeTransitionDrag(dragged, "circle-open");
		expect(carriesTransition(dragged)).toBe(true);
		expect(readTransitionDrag(dragged)).toBe("circle-open");
		const other = transfer();
		other.setData("text/plain", "hello");
		expect(carriesTransition(other)).toBe(false);
		expect(readTransitionDrag(other)).toBeUndefined();
		const bogus = transfer();
		bogus.setData(TRANSITION_DRAG_TYPE, "spiral");
		expect(readTransitionDrag(bogus)).toBeUndefined();
	});
});

describe("gallery demos", () => {
	test("every transition gets keyframes for both layers", () => {
		for (const type of revealTransitions) {
			const css = transitionDemoKeyframes(type);
			expect(css).toContain(`@keyframes ${demoAnimationName(type, "a")}`);
			expect(css).toContain(`@keyframes ${demoAnimationName(type, "b")}`);
			expect(css).not.toContain("NaN");
			expect(css).not.toContain("undefined");
		}
	});

	test("demos replay the preview stage: a wipe clips, a push moves A", () => {
		expect(transitionDemoKeyframes("wipe-left")).toContain(
			"clip-path: inset(0% 50% 0% 0%)"
		);
		const push = transitionDemoKeyframes("push-left");
		expect(push).toContain("translate(-100%, 0%)");
		expect(demoCut("push-left").a.exitTransition).toBe("slide-left");
		expect(demoCut("dissolve").a.exitTransition).toBeUndefined();
	});
});
