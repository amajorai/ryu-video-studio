import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CurvePoint } from "../../../shared/schema/color.ts";

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
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { clientToCurve, CurvesEditor } = await import("./CurvesEditor.tsx");
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

const roots: { unmount: () => void }[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

let latest: CurvePoint[] | undefined;

function Harness({ initial }: { initial: CurvePoint[] }) {
	const [points, setPoints] = useState<CurvePoint[] | undefined>(initial);
	latest = points;
	return (
		<CurvesEditor
			label="Master curve"
			mode="tone"
			onChange={setPoints}
			points={points}
		/>
	);
}

function mount(initial: CurvePoint[]) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<Harness initial={initial} />));
	return host;
}

function press(key: string) {
	const active = document.activeElement;
	if (!active) {
		throw new Error("Nothing is focused.");
	}
	act(() => {
		active.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

test("repeated horizontal arrow presses keep focus on the moving point", () => {
	const host = mount([
		{ x: 0, y: 0 },
		{ x: 0.5, y: 0.5 },
		{ x: 1, y: 1 },
	]);
	const circle = host.querySelectorAll("circle")[1];
	if (!circle) {
		throw new Error("The middle point did not render.");
	}
	act(() => circle.focus());
	press("ArrowRight");
	expect(document.activeElement).toBe(circle);
	press("ArrowRight");
	press("ArrowRight");
	expect(document.activeElement).toBe(circle);
	expect(latest?.[1]?.x).toBeCloseTo(0.53, 6);
	press("ArrowLeft");
	expect(latest?.[1]?.x).toBeCloseTo(0.52, 6);
	expect(circle.getAttribute("cx")).toBe("52");
});

test("pointer coordinates map through the padded viewBox", () => {
	const box = { height: 104, left: 10, top: 20, width: 208 };
	// A point drawn at x = 0.25 sits at viewBox 25, i.e. (25 + 2) / 104 across.
	const point = clientToCurve(
		box,
		10 + (27 / 104) * 208,
		20 + (77 / 104) * 104
	);
	expect(point.x).toBeCloseTo(0.25, 9);
	expect(point.y).toBeCloseTo(0.25, 9);
	// The plot's corners are inside the element, not at its edges.
	const origin = clientToCurve(
		box,
		10 + (2 / 104) * 208,
		20 + (102 / 104) * 104
	);
	expect(origin.x).toBeCloseTo(0, 9);
	expect(origin.y).toBeCloseTo(0, 9);
});
