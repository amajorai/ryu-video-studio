import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Drives the real lottie-web light canvas build (in happy-dom, with a no-op
 * 2D context) to check which frame it actually draws for each output frame.
 * lottie-web counts `goToAndStop` frames from the animation's in point, so a
 * file whose `ip` is not 0 must not be offset.
 */

GlobalRegistrator.register();
const canvasPrototype = HTMLCanvasElement.prototype;
const originalGetContext = Object.getOwnPropertyDescriptor(
	canvasPrototype,
	"getContext"
);
const originalToDataUrl = Object.getOwnPropertyDescriptor(
	canvasPrototype,
	"toDataURL"
);
const noop = () => undefined;
const context = new Proxy<Record<string | symbol, unknown>>(
	{},
	{
		get: (target, key) => (key in target ? target[key] : noop),
		set: (target, key, value) => {
			target[key] = value;
			return true;
		},
	}
);
Object.defineProperty(canvasPrototype, "getContext", {
	configurable: true,
	value: () => context,
});
Object.defineProperty(canvasPrototype, "toDataURL", {
	configurable: true,
	value: () => "data:image/png;base64,AAAA",
});

const { default: lottie } = await import(
	"lottie-web/build/player/lottie_light_canvas"
);
const { createCanvasLottieRenderer } = await import("./lottie-import.ts");
const { lottieSourceFrame, parseLottieDocument, planLottieImport } =
	await import("../../../shared/lottie.ts");

afterAll(() => {
	for (const [name, descriptor] of [
		["getContext", originalGetContext],
		["toDataURL", originalToDataUrl],
	] as const) {
		if (descriptor) {
			Object.defineProperty(canvasPrototype, name, descriptor);
		}
	}
	GlobalRegistrator.unregister();
});

interface SpiedAnimation {
	renderer: { renderFrame: (frame: number) => void };
}

/** Capture the animation lottie-web creates so its renderer can be spied on. */
function captureAnimation(): () => SpiedAnimation | undefined {
	let captured: SpiedAnimation | undefined;
	const load = lottie.loadAnimation.bind(lottie);
	lottie.loadAnimation = (parameters) => {
		const item = load(parameters);
		captured = item as unknown as SpiedAnimation;
		return item;
	};
	return () => captured;
}

describe("canvas Lottie renderer", () => {
	for (const ip of [0, 30]) {
		test(`draws the planned absolute frames when ip is ${ip}`, async () => {
			const animation = parseLottieDocument(
				JSON.stringify({
					assets: [],
					fr: 30,
					h: 100,
					ip,
					layers: [],
					op: ip + 60,
					v: "5.7.0",
					w: 100,
				})
			);
			const plan = planLottieImport(animation, 30);
			const animationOf = captureAnimation();
			const renderer = await createCanvasLottieRenderer(animation, plan);
			const item = animationOf();
			if (!item) {
				throw new Error("lottie-web created no animation");
			}
			const drawn: number[] = [];
			const renderFrame = item.renderer.renderFrame.bind(item.renderer);
			item.renderer.renderFrame = (frame) => {
				drawn.push(frame);
				renderFrame(frame);
			};
			const indices = [0, 30, 59];
			for (const index of indices) {
				expect(await renderer.render(lottieSourceFrame(plan, index))).toBe(
					"AAAA"
				);
			}
			renderer.destroy();
			expect(drawn).toEqual(
				indices.map((index) => lottieSourceFrame(plan, index))
			);
			expect(drawn).toEqual([ip, ip + 30, ip + 59]);
		});
	}
});
