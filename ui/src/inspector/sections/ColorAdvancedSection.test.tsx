import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";
import type { ColorGrade } from "../../../../shared/schema/color.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";

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
const { EditorProvider } = await import("../../editor/context.tsx");
const { ColorAdvancedSection } = await import("./ColorAdvancedSection.tsx");
const { clearPreviewLuts, hasPreviewLut } = await import(
	"../../preview/gl/passes/grade.ts"
);
const { identityCubeLut, serializeCubeLut } = await import(
	"../../../../shared/cube-lut.ts"
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
	duration: 8,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const LUT_ID = "00000000-0000-4000-8000-0000000000aa";
const lutRecord = {
	createdAt: "2026-01-01T00:00:00.000Z",
	id: LUT_ID,
	name: "Film",
	size: 2,
};

const hostCalls: { method?: string; path: string }[] = [];
const statuses: string[] = [];
const roots: { unmount: () => void }[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	hostCalls.length = 0;
	statuses.length = 0;
	clearPreviewLuts();
	window.ryu = undefined;
	document.body.innerHTML = "";
});

function graded(grade: Partial<ColorGrade> = {}): Segment {
	const segment = newSegment(video);
	return segmentSchema.parse({
		...segment,
		colorGrade: { ...segment.colorGrade, ...grade },
	});
}

async function renderSection(
	segment: Segment,
	options: { lut3d?: boolean; visual?: boolean } = {}
) {
	window.ryu = {
		app: {
			request: (input) => {
				hostCalls.push(input);
				if (input.path.startsWith("/luts?id=")) {
					return Promise.resolve({
						cube: serializeCubeLut(identityCubeLut(2)),
						lut: lutRecord,
					} as never);
				}
				return Promise.resolve({ luts: [lutRecord] } as never);
			},
		},
	};
	const patches: Partial<Segment>[] = [];
	const runtime = {
		api: async (path: string) => {
			await Promise.resolve();
			if (path === "/capabilities") {
				return { encoders: {}, filters: { lut3d: options.lut3d ?? true } };
			}
			throw new Error(`Unexpected request ${path}`);
		},
		assets: [video],
		project: { ...newProject("Grade"), segments: [segment] },
		setStatus: (status: string) => statuses.push(status),
	} as unknown as EditorRuntime;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<ColorAdvancedSection
					isAudio={options.visual === false}
					onChange={(patch) => patches.push(patch)}
					segment={segment}
					visualControls={options.visual ?? true}
				/>
			</EditorProvider>
		);
	});
	for (let tick = 0; tick < 4; tick++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
	return { container, patches };
}

const input = (container: HTMLElement, label: string) =>
	container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const select = (container: HTMLElement, label: string) =>
	container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const button = (container: HTMLElement, label: string) =>
	[...container.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === label
	);

async function typeNumber(element: HTMLInputElement | null, value: string) {
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("blur", { bubbles: true }));
			element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		}
	});
}

async function choose(element: HTMLSelectElement | null, value: string) {
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
}

describe("ColorAdvancedSection", () => {
	test("renders nothing without picture controls", async () => {
		const { container } = await renderSection(graded(), { visual: false });
		expect(container.innerHTML).toBe("");
	});

	test("tone fields patch the grade and clear the look", async () => {
		const { container, patches } = await renderSection(
			graded({ look: "noir" })
		);
		expect(
			container.querySelector('[data-testid="applied-look"]')?.textContent
		).toBe("Look: Noir");
		await typeNumber(input(container, "Blacks"), "0.3");
		const grade = patches.at(-1)?.colorGrade;
		expect(grade?.blacks).toBe(0.3);
		expect(grade?.look).toBeUndefined();
		await typeNumber(input(container, "Whites"), "-0.5");
		expect(patches.at(-1)?.colorGrade?.whites).toBe(-0.5);
	});

	test("curve points move with the keyboard and the channel picker", async () => {
		const { container, patches } = await renderSection(
			graded({
				curves: {
					red: [
						{ x: 0, y: 0 },
						{ x: 0.5, y: 0.5 },
						{ x: 1, y: 1 },
					],
				},
			})
		);
		await choose(select(container, "Curve channel"), "red");
		const points = container.querySelectorAll<SVGCircleElement>(
			'[data-testid="curve-Red curve"] circle'
		);
		expect(points).toHaveLength(3);
		await act(async () => {
			points[1]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
			);
		});
		expect(patches.at(-1)?.colorGrade?.curves?.red?.[1]).toEqual({
			x: 0.5,
			y: 0.51,
		});
		await act(async () => {
			points[1]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
			);
		});
		expect(patches.at(-1)?.colorGrade?.curves?.red).toHaveLength(2);
		await act(async () => {
			button(container, "Reset curve")?.click();
		});
		expect(patches.at(-1)?.colorGrade?.curves).toBeUndefined();
	});

	test("HSL bands and wheels patch their fields", async () => {
		const { container, patches } = await renderSection(graded());
		const orange = [...container.querySelectorAll('[role="radio"]')].find(
			(element) => element.getAttribute("aria-label") === "Orange"
		);
		await act(async () => {
			(orange as HTMLButtonElement | undefined)?.click();
		});
		await typeNumber(input(container, "Orange saturation"), "0.4");
		expect(patches.at(-1)?.colorGrade?.hsl).toEqual([
			{ band: "orange", hue: 0, lightness: 0, saturation: 0.4 },
		]);
		const lift = container.querySelector('[data-testid="wheel-lift"]');
		await act(async () => {
			lift?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		expect(patches.at(-1)?.colorGrade?.lift?.r).toBe(0.02);
		await typeNumber(input(container, "Gain master"), "0.25");
		expect(patches.at(-1)?.colorGrade?.gain).toEqual({
			b: 0,
			g: 0,
			master: 0.25,
			r: 0,
		});
	});

	test("LUTs are listed, chosen and loaded into the preview", async () => {
		const { container, patches } = await renderSection(graded());
		const lutSelect = select(container, "Clip LUT");
		expect(
			[...(lutSelect?.options ?? [])].map((option) => option.value)
		).toEqual(["", LUT_ID]);
		await choose(lutSelect, LUT_ID);
		expect(patches.at(-1)?.colorGrade?.lut).toEqual({
			intensity: 1,
			lutId: LUT_ID,
		});
		const withLut = await renderSection(
			graded({ lut: { intensity: 0.5, lutId: LUT_ID } })
		);
		expect(input(withLut.container, "LUT intensity")?.value).toBe("0.5");
		expect(hasPreviewLut(LUT_ID)).toBe(true);
		expect(hostCalls).toContainEqual({
			method: "GET",
			path: `/luts?id=${LUT_ID}`,
		});
		expect(statuses).toContain("LUT loaded into the preview.");
	});

	test("a node without lut3d disables LUT controls with a reason", async () => {
		const { container } = await renderSection(graded(), { lut3d: false });
		expect(container.textContent).toContain("no lut3d filter");
		expect(select(container, "Clip LUT")?.disabled).toBe(true);
		expect(button(container, "Import .cube")?.hasAttribute("disabled")).toBe(
			true
		);
	});

	test("reset clears advanced controls but keeps the LUT", async () => {
		const lut = { intensity: 1, lutId: LUT_ID };
		const { container, patches } = await renderSection(
			graded({ lut, shadows: 0.4, whites: 0.2 })
		);
		await act(async () => {
			button(container, "Reset advanced grade")?.click();
		});
		const grade = patches.at(-1)?.colorGrade;
		expect(grade?.shadows).toBeUndefined();
		expect(grade?.whites).toBeUndefined();
		expect(grade?.lut).toEqual(lut);
	});
});
