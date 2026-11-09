import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	formatMessage,
	type MessageValuesInput,
	messageIdForLiteral,
} from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { newProject, type Project } from "../../../shared/project.ts";
import {
	type RenderPlan,
	resolveRenderPlan,
} from "../../../shared/render-options.ts";
import { planSummary } from "./export-form.ts";

/** A German stand-in catalog for the plan summary's labels. */
const GERMAN = new Map<string, string>([
	[messageIdForLiteral("with audio"), "mit Ton"],
	[messageIdForLiteral("no audio"), "ohne Ton"],
	[messageIdForLiteral("transparent"), "transparent (Alpha)"],
	[messageIdForLiteral("HDR tags"), "HDR-Kennzeichnung"],
]);

const germanRuntime = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(GERMAN.get(id) ?? fallback ?? id, values, "de");
	},
};

beforeEach(() => registerActiveI18nRuntime(germanRuntime));
afterEach(() => unregisterActiveI18nRuntime(germanRuntime));

const project = (patch: Partial<Project> = {}): Project => ({
	...newProject("Launch"),
	fps: 30,
	height: 1080,
	width: 1920,
	...patch,
});

test("plan summary labels follow the UI language", () => {
	const plan = resolveRenderPlan(
		project(),
		{ overrides: { alpha: true, container: "mov" } },
		{ timelineDuration: 4 }
	);
	const summary = planSummary(plan);
	expect(summary).toContain(" · mit Ton · transparent (Alpha)");
	expect(summary).not.toContain("with audio");
	expect(summary).toContain("4,0");

	const silent: RenderPlan = { ...plan, includeAudio: false };
	expect(planSummary(silent)).toContain(" · ohne Ton");
	const hdr: RenderPlan = { ...plan, hdr: "smpte2084" };
	expect(planSummary(hdr)).toEndWith(" · HDR-Kennzeichnung");
});
