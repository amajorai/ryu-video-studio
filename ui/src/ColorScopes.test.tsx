import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { computeScopeWaveforms } = await import("../../shared/color-scopes.ts");
const { testVideo } = await import("./editor/test-runtime.ts");
const {
	ColorScopes,
	HISTOGRAM_HEIGHT,
	histogramCells,
	PARADE_GAP,
	paradeCells,
	paradeWidth,
	vectorscopeCells,
} = await import("./ColorScopes.tsx");

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

afterEach(() => {
	Reflect.deleteProperty(window, "ryu");
});

/** Left half pure red, right half pure blue, 4x2. */
function redBlue() {
	const frame = new Uint8Array(4 * 2 * 3);
	for (let y = 0; y < 2; y++) {
		frame.set([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255], y * 12);
	}
	return computeScopeWaveforms(frame, 4, 2, 2);
}

describe("scope drawings", () => {
	test("histogram bars reach full height at the peak", () => {
		const cells = histogramCells(redBlue().histogram);
		expect(cells.map((cell) => cell.x)).toEqual([18, 54]);
		for (const cell of cells) {
			expect(cell.height).toBe(HISTOGRAM_HEIGHT);
			expect(cell.y).toBe(0);
		}
	});

	test("parade panels sit side by side with bright values on top", () => {
		const { parade } = redBlue();
		expect(paradeWidth(parade)).toBe(2 * 3 + PARADE_GAP * 2);
		const cells = paradeCells(parade);
		const red = cells.filter((cell) => cell.channel === "r");
		expect(red).toContainEqual({
			alpha: 1,
			channel: "r",
			height: 1,
			width: 1,
			x: 0,
			y: 0,
		});
		expect(red).toContainEqual(
			expect.objectContaining({ x: 1, y: parade.bins - 1 })
		);
		const blue = cells.filter((cell) => cell.channel === "b");
		const blueOffset = 2 * (parade.columns + PARADE_GAP);
		expect(blue.map((cell) => cell.x).sort()).toEqual([
			blueOffset,
			blueOffset + 1,
		]);
	});

	test("vectorscope cells match the computed counts", () => {
		const cells = vectorscopeCells(redBlue().vectorscope);
		expect(cells).toHaveLength(2);
		expect(cells.every((cell) => cell.alpha === 1)).toBe(true);
	});
});

describe("ColorScopes", () => {
	test("requests full scopes and draws three labelled canvases", async () => {
		const asset = testVideo();
		const requests: string[] = [];
		const waveforms = redBlue();
		Object.defineProperty(window, "ryu", {
			configurable: true,
			value: {
				app: {
					request: async (input: { path: string }) => {
						requests.push(input.path);
						return {
							assetId: asset.id,
							chroma: { u: 0.5, v: 0.5 },
							clipping: { black: false, white: true },
							hueDegrees: 120,
							luma: { average: 0.4, max: 1, min: 0 },
							sampledAt: 0,
							saturation: { average: 0.5, max: 1, min: 0 },
							waveforms,
						};
					},
				},
			},
			writable: true,
		});
		const errors: string[] = [];
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		await act(async () => {
			root.render(
				<ColorScopes asset={asset} onError={(text) => errors.push(text)} />
			);
		});
		await act(async () => {
			element.querySelector("button")?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(requests).toEqual([
			`/assets/${asset.id}/scopes?time=0&detail=full&columns=64`,
		]);
		expect(errors).toEqual([]);
		expect(element.textContent).toContain("white clip");
		const labels = [...element.querySelectorAll("canvas")].map((canvas) =>
			canvas.getAttribute("aria-label")
		);
		expect(labels).toEqual(["Luma histogram", "RGB parade", "Vectorscope"]);
		await act(async () => root.unmount());
		element.remove();
	});
});
