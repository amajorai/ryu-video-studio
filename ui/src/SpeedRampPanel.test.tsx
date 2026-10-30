import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import { SPEED_RAMP_LIMITS } from "../../shared/speed-ramp.ts";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { SpeedRampPanel } = await import("./SpeedRampPanel.tsx");
const { addPoint, movePoint, speedForY } = await import(
	"./SpeedCurveEditor.tsx"
);
afterAll(() => {
	GlobalRegistrator.unregister();
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

const mounted: { container: HTMLElement; root: Root }[] = [];
afterEach(() => {
	for (const { container, root } of mounted.splice(0)) {
		act(() => root.unmount());
		container.remove();
	}
});

const video: Asset = {
	createdAt: new Date().toISOString(),
	duration: 8,
	hasAudio: false,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "Shot",
	width: 640,
};

async function render(prepare?: (project: Project) => Project) {
	const initial = newSegment(video, 0, 0);
	const base: Project = { ...newProject("Ramp"), segments: [initial] };
	const project = prepare ? prepare(base) : base;
	const segment = project.segments[0] ?? initial;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	const edits: { next: Project; status: string }[] = [];
	const errors: string[] = [];
	await act(async () => {
		root.render(
			<SpeedRampPanel
				assets={[video]}
				busy={false}
				onEdit={(next, status) => edits.push({ next, status })}
				onError={(text) => errors.push(text)}
				project={project}
				segment={segment}
			/>
		);
	});
	return { container, edits, errors };
}

const button = (container: HTMLElement, text: string) => {
	const found = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === text
	);
	if (!found) {
		throw new Error(`Missing ${text} button.`);
	}
	return found;
};

async function click(container: HTMLElement, text: string) {
	await act(async () => {
		button(container, text).click();
		await Bun.sleep(5);
	});
}

test("the Jump cut preset ramps fast, slow, fast", async () => {
	const { container, edits } = await render();
	await click(container, "Jump cut");
	await click(container, "Steps");
	await click(container, "Apply speed ramp");
	expect(edits).toHaveLength(1);
	expect(edits[0]?.status).toContain("Jump cut");
	const speeds = edits[0]?.next.segments.map((segment) => segment.speed) ?? [];
	expect(speeds[0]).toBe(3);
	expect(Math.min(...speeds)).toBe(0.5);
	expect(speeds.at(-1)).toBe(3);
});

test("the custom curve editor adds points and applies them", async () => {
	const { container, edits } = await render();
	await click(container, "Custom");
	expect(
		container.querySelector('[aria-label^="Custom speed curve"]')
	).not.toBeNull();
	// Montage starts with five points; add one and slow the clip end down.
	expect(container.querySelectorAll("circle[data-point]")).toHaveLength(5);
	await click(container, "Add point");
	expect(container.querySelectorAll("circle[data-point]")).toHaveLength(6);
	await click(container, "Steps");
	await click(container, "Apply speed ramp");
	expect(edits).toHaveLength(1);
	expect(edits[0]?.status).toContain("Custom");
	expect(edits[0]?.next.segments.length).toBe(12);
});

test("custom points stay sorted, inside the bounds, and pinned at the ends", () => {
	const points = [
		{ speed: 1, t: 0 },
		{ speed: 2, t: 0.5 },
		{ speed: 1, t: 1 },
	];
	expect(movePoint(points, 1, { t: 2, speed: 99 }, SPEED_RAMP_LIMITS)).toEqual([
		{ speed: 1, t: 0 },
		{ speed: 10, t: 0.99 },
		{ speed: 1, t: 1 },
	]);
	expect(movePoint(points, 0, { t: 0.4 }, SPEED_RAMP_LIMITS)[0]?.t).toBe(0);
	const added = addPoint(points, SPEED_RAMP_LIMITS);
	expect(added.index).toBe(1);
	expect(added.points.map((point) => point.t)).toEqual([0, 0.25, 0.5, 1]);
	const full = Array.from({ length: 12 }, (_, index) => ({
		speed: 1,
		t: index / 11,
	}));
	expect(addPoint(full, SPEED_RAMP_LIMITS).index).toBe(-1);
	expect(speedForY(0, SPEED_RAMP_LIMITS)).toBe(10);
	expect(speedForY(80, SPEED_RAMP_LIMITS)).toBe(0.1);
	expect(speedForY(40, SPEED_RAMP_LIMITS)).toBe(1);
});

test("a smooth curve keeps one clip, then bakes or resets", async () => {
	const { container, edits } = await render();
	await click(container, "Hero");
	await click(container, "Apply speed curve");
	expect(edits).toHaveLength(1);
	expect(edits[0]?.status).toContain("smooth");
	const curved = edits[0]?.next;
	expect(curved?.segments).toHaveLength(1);
	expect(curved?.segments[0]?.speedCurve?.points.length).toBeGreaterThan(2);
	if (!curved) {
		throw new Error("no curved project");
	}
	const view = await render(() => curved);
	expect(view.container.textContent).toContain("plays a smooth speed curve");
	await click(view.container, "Bake to clips");
	expect(view.edits[0]?.next.segments).toHaveLength(12);
	await click(view.container, "Reset to constant");
	const flat = view.edits[1]?.next.segments;
	expect(flat).toHaveLength(1);
	expect(flat?.[0]?.speedCurve).toBeUndefined();
});

test("a curved clip switches its audio between pitch kept and tape-style", async () => {
	const { container, edits } = await render();
	await click(container, "Hero");
	await click(container, "Apply speed curve");
	const curved = edits[0]?.next;
	if (!curved) {
		throw new Error("no curved project");
	}
	const view = await render(() => curved);
	const toggle = view.container.querySelector(
		'[aria-label="Preserve pitch on the speed curve"]'
	);
	if (!(toggle instanceof HTMLElement)) {
		throw new Error("no pitch switch on a curved clip");
	}
	expect(toggle.getAttribute("aria-checked")).toBe("true");
	await act(async () => {
		toggle.click();
	});
	expect(view.edits.at(-1)?.status).toContain("tape-style");
	expect(view.edits.at(-1)?.next.segments[0]?.speedCurve?.preservePitch).toBe(
		false
	);
	// A clip without a curve has no curve pitch switch.
	const plain = await render();
	expect(
		plain.container.querySelector(
			'[aria-label="Preserve pitch on the speed curve"]'
		)
	).toBeNull();
});
