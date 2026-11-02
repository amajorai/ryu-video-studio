import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { createTestRuntime, lastStatus, testProject } from "../test-runtime.ts";
import { applyToolEdit } from "./trim.ts";

function rippleRuntime() {
	const { asset, first, project } = testProject();
	const runtime = createTestRuntime(project, [asset]);
	runtime.setTool("ripple");
	return { first, runtime };
}

test("a tool drag reports the applied offset as one whole sentence", () => {
	const { first, runtime } = rippleRuntime();
	applyToolEdit(runtime, first, "end", -1);
	expect(lastStatus(runtime)).toBe("Ripple edit applied · -1.000s.");
});

test("a tool drag that was cut short says so in its own message", () => {
	const { first, runtime } = rippleRuntime();
	applyToolEdit(runtime, first, "end", -1.25);
	expect(lastStatus(runtime)).toBe(
		"Ripple edit applied · -1.233s (limited by source media or a neighbouring clip)."
	);
});

test("the status goes through the caller's translator with its values", () => {
	const { first, runtime } = rippleRuntime();
	const seen: [string, unknown][] = [];
	const tl: LiteralMessage = (source, values) => {
		seen.push([source, values]);
		return source;
	};
	applyToolEdit(runtime, first, "end", -0.5, tl);
	expect(seen).toContainEqual(["Ripple", undefined]);
	expect(seen).toContainEqual([
		"{toolLabel} edit applied · {offset}.",
		{ offset: "-0.500s", toolLabel: "Ripple" },
	]);
});
