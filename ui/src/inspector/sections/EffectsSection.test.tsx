import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Effect, EffectType } from "../../../../shared/effects.ts";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
	EFFECT_GROUPS,
	EffectsSection,
	moveEffectPatch,
	newEffect,
	removeEffectsPatch,
	seedEdit,
} = await import("./EffectsSection.tsx");
const { effectTypeSchema, MAX_EFFECT_STACK } = await import(
	"../../../../shared/effects.ts"
);
afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
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

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const FIRST = "00000000-0000-4000-9000-000000000001";
const SECOND = "00000000-0000-4000-9000-000000000002";

const effect = (type: EffectType, patch: Partial<Effect> = {}): Effect => ({
	amount: 1,
	enabled: true,
	type,
	...patch,
});

const clip = (patch: Partial<Segment> = {}): Segment =>
	segmentSchema.parse({ ...newSegment(video), ...patch });

async function renderSection(
	segment: Segment,
	visualControls = true
): Promise<{ container: HTMLElement; patches: Partial<Segment>[] }> {
	const patches: Partial<Segment>[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<EffectsSection
				isAudio={!visualControls}
				onChange={(patch) => patches.push(patch)}
				segment={segment}
				visualControls={visualControls}
			/>
		);
	});
	return { container, patches };
}

const addSelect = (container: HTMLElement) =>
	container.querySelector<HTMLSelectElement>('select[aria-label="Add effect"]');

async function click(container: HTMLElement, label: string) {
	const element = container.querySelector<HTMLElement>(
		`[aria-label="${label}"]`
	);
	if (!element) {
		throw new Error(`No control labelled ${label}`);
	}
	await act(async () => {
		element.click();
	});
}

describe("EffectsSection", () => {
	test("the add menu offers the whole library once", async () => {
		const { container } = await renderSection(clip());
		const select = addSelect(container);
		const values = [...(select?.options ?? [])]
			.map((option) => option.value)
			.filter(Boolean);
		expect(values.sort()).toEqual([...effectTypeSchema.options].sort());
		expect(EFFECT_GROUPS.flatMap(([, types]) => types)).toHaveLength(
			effectTypeSchema.options.length
		);
		expect(select?.value).toBe("");
	});

	test("adding appends a full-strength effect with an id", async () => {
		const { container, patches } = await renderSection(
			clip({ effects: [effect("blur")] })
		);
		const select = addSelect(container);
		await act(async () => {
			if (select) {
				select.value = "light-leak";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		const added = patches[0]?.effects?.[1];
		expect(patches[0]?.effects?.[0]).toEqual(effect("blur"));
		expect(added?.type).toBe("light-leak");
		expect(added?.amount).toBe(1);
		expect(added?.enabled).toBe(true);
		expect(added?.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("a full stack disables the add menu", async () => {
		const effects = Array.from({ length: MAX_EFFECT_STACK }, () =>
			effect("grain")
		);
		const { container } = await renderSection(clip({ effects }));
		expect(addSelect(container)?.disabled).toBe(true);
		expect(container.textContent).toContain(`Stack full (${MAX_EFFECT_STACK})`);
	});

	test("rows toggle, reorder and remove effects", async () => {
		const segment = clip({
			effects: [
				effect("glow", { id: FIRST }),
				effect("mosaic", { id: SECOND }),
			],
		});
		const { container, patches } = await renderSection(segment);
		expect(
			container
				.querySelector('[aria-label="Enable Glow"]')
				?.getAttribute("aria-pressed")
		).toBe("true");
		await click(container, "Enable Glow");
		await click(container, "Move Mosaic up");
		await click(container, "Remove Glow effect");
		expect(patches[0]?.effects?.[0]?.enabled).toBe(false);
		expect(patches[1]?.effects?.map((entry) => entry.type)).toEqual([
			"mosaic",
			"glow",
		]);
		expect(patches[2]).toEqual({
			effects: [effect("mosaic", { id: SECOND })],
		});
		expect(
			container.querySelector<HTMLButtonElement>('[aria-label="Move Glow up"]')
				?.disabled
		).toBe(true);
	});

	test("seeded effects show a seed and temporal effects say render-only", async () => {
		const { container } = await renderSection(
			clip({ effects: [effect("grain", { seed: 12 }), effect("echo")] })
		);
		expect(
			container.querySelector<HTMLInputElement>(
				'input[aria-label="Film grain seed"]'
			)?.value
		).toBe("12");
		expect(
			container.querySelector('input[aria-label="Echo trails seed"]')
		).toBeNull();
		expect(container.textContent).toContain(
			"Shown in renders and exports only."
		);
	});

	test("an unset seed shows blank, not 0, and blank clears a seed", async () => {
		const { container, patches } = await renderSection(
			clip({ effects: [effect("grain", { id: FIRST })] })
		);
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="Film grain seed"]'
		);
		expect(input?.value).toBe("");
		expect(input?.placeholder).toBe("Default");
		if (!input) {
			throw new Error("seed field missing");
		}
		await act(async () => {
			input.value = "0";
			input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(patches.at(-1)?.effects?.[0]?.seed).toBe(0);

		const grain = effect("grain", { seed: 7 });
		const cleared = seedEdit(grain, "  ");
		expect(cleared).toEqual(effect("grain"));
		expect(cleared && "seed" in cleared).toBe(false);
		expect(seedEdit(effect("grain"), "")).toBeUndefined();
		expect(seedEdit(grain, "7")).toBeUndefined();
		expect(seedEdit(grain, "1.5")).toBeUndefined();
		expect(seedEdit(grain, "10000")).toBeUndefined();
		expect(seedEdit(grain, "-1")).toBeUndefined();
		expect(seedEdit(grain, "9999")?.seed).toBe(9999);
	});

	test("audio clips without a visualization hide the controls", async () => {
		const { container } = await renderSection(clip(), false);
		expect(addSelect(container)).toBeNull();
	});
});

describe("effect stack patches", () => {
	test("new effects carry a fresh id", () => {
		expect(newEffect("glow").id).not.toBe(newEffect("glow").id);
	});

	test("removing an effect drops the keyframes that target it", () => {
		const segment = clip({
			effects: [effect("glow", { id: FIRST }), effect("grain", { id: SECOND })],
			keyframes: [
				{
					id: "00000000-0000-4000-a000-000000000001",
					property: "effectAmount",
					target: FIRST,
					time: 0,
					value: 0,
				},
				{
					id: "00000000-0000-4000-a000-000000000002",
					property: "effectAmount",
					target: SECOND,
					time: 0,
					value: 0,
				},
				{
					id: "00000000-0000-4000-a000-000000000003",
					property: "opacity",
					time: 0,
					value: 1,
				},
			],
		});
		const patch = removeEffectsPatch(segment, new Set([0]));
		expect(patch.effects).toEqual([effect("grain", { id: SECOND })]);
		expect(patch.keyframes?.map((frame) => frame.target ?? "-")).toEqual([
			SECOND,
			"-",
		]);
		// The patched clip is still valid.
		expect(segmentSchema.safeParse({ ...segment, ...patch }).success).toBe(
			true
		);
		expect(
			removeEffectsPatch(clip({ effects: [effect("blur")] }), new Set([0]))
		).toEqual({ effects: [] });
	});

	test("moving past either end is a no-op", () => {
		const segment = clip({ effects: [effect("glow"), effect("grain")] });
		expect(moveEffectPatch(segment, 0, -1)).toBeNull();
		expect(moveEffectPatch(segment, 1, 1)).toBeNull();
		expect(
			moveEffectPatch(segment, 0, 1)?.effects?.map((entry) => entry.type)
		).toEqual(["grain", "glow"]);
	});
});
