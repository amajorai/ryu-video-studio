import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const {
	armEyedropper,
	averagePixel,
	EYEDROPPER_TOGGLE_ATTRIBUTE,
	containBox,
	eyedropperSource,
	hitMediaLayer,
	normalizedPoint,
	pickPreviewColor,
} = await import("./eyedropper.ts");
afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
});

const layer = <Tag extends keyof HTMLElementTagNameMap>(
	tag: Tag,
	label?: string
): HTMLElementTagNameMap[Tag] => {
	const element = document.createElement(tag);
	element.classList.add("studio-media-layer");
	if (label !== undefined) {
		if (element instanceof HTMLImageElement) {
			element.alt = label;
		} else {
			element.setAttribute("aria-label", label);
		}
	}
	return element;
};

describe("eyedropper geometry", () => {
	test("containBox letterboxes media inside its element", () => {
		const fitted = containBox(
			{ height: 100, left: 10, top: 20, width: 400 },
			1920,
			1080
		);
		expect(fitted.height).toBe(100);
		expect(fitted.top).toBe(20);
		expect(fitted.width).toBeCloseTo(177.778, 3);
		expect(fitted.left).toBeCloseTo(10 + (400 - 177.778) / 2, 3);
		const unknown = { height: 50, left: 0, top: 0, width: 50 };
		expect(containBox(unknown, 0, 0)).toBe(unknown);
	});

	test("normalizedPoint maps inside the box and refuses points outside", () => {
		const box = { height: 100, left: 10, top: 20, width: 200 };
		expect(normalizedPoint(box, 110, 70)).toEqual({ x: 0.5, y: 0.5 });
		expect(normalizedPoint(box, 5, 70)).toBeNull();
		expect(normalizedPoint(box, 110, 121)).toBeNull();
		expect(normalizedPoint({ ...box, width: 0 }, 10, 20)).toBeNull();
	});

	test("averagePixel averages opaque neighbours and skips transparent ones", () => {
		// 3x1: red, green (transparent), blue.
		const data = [255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255];
		expect(averagePixel(data, 3, 1, { x: 0.5, y: 0.5 })).toEqual([128, 0, 128]);
		const transparent = [10, 20, 30, 0];
		expect(averagePixel(transparent, 1, 1, { x: 0, y: 0 })).toEqual([
			10, 20, 30,
		]);
		expect(averagePixel([], 0, 0, { x: 0, y: 0 })).toEqual([0, 0, 0]);
	});
});

describe("eyedropper targets", () => {
	test("a WebGL canvas samples the media element it draws from", () => {
		const parent = document.createElement("div");
		const video = layer("video");
		const canvas = layer("canvas");
		parent.append(video, canvas);
		expect(eyedropperSource(canvas)).toBe(video);
		expect(eyedropperSource(video)).toBe(video);
		expect(eyedropperSource(document.createElement("canvas"))).toBeNull();
		expect(eyedropperSource(document.createElement("div"))).toBeNull();
	});

	test("hitMediaLayer prefers the inspected clip's layer", () => {
		const top = layer("img", "Overlay");
		const below = layer("video", "Green screen");
		const plain = document.createElement("div");
		expect(hitMediaLayer([plain, top, below], "Green screen")?.source).toBe(
			below
		);
		expect(hitMediaLayer([plain, top, below])?.source).toBe(top);
		expect(hitMediaLayer([top], "Missing")?.source).toBe(top);
		expect(hitMediaLayer([plain])).toBeNull();
	});

	test("pickPreviewColor explains a click outside any clip", async () => {
		await expect(
			pickPreviewColor({ clientX: 1, clientY: 1, elements: [] })
		).rejects.toThrow("Click the clip in the preview");
	});

	test("an unreadable frame reports why when there is no fallback", async () => {
		const video = layer("video", "Green screen");
		video.getBoundingClientRect = () =>
			({ height: 90, left: 0, top: 0, width: 160 }) as DOMRect;
		await expect(
			pickPreviewColor({
				clientX: 80,
				clientY: 45,
				elements: [video],
				label: "Green screen",
			})
		).rejects.toThrow("no frame to sample");
	});
});

describe("armEyedropper", () => {
	const events = () => {
		const log: string[] = [];
		return {
			handlers: {
				onCancel: () => log.push("cancel"),
				onError: (message: string) => log.push(`error:${message}`),
				onPick: (hex: string) => log.push(`pick:${hex}`),
			},
			log,
		};
	};

	test("Escape cancels and disarms", () => {
		const { handlers, log } = events();
		armEyedropper(handlers);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(log).toEqual(["cancel"]);
	});

	test("a click outside the preview frame cancels", () => {
		const { handlers, log } = events();
		const target = document as Document & {
			elementsFromPoint: (x: number, y: number) => Element[];
		};
		const original = target.elementsFromPoint;
		target.elementsFromPoint = () => [document.body];
		try {
			armEyedropper(handlers);
			document.dispatchEvent(
				new PointerEvent("pointerdown", { button: 0, clientX: 1, clientY: 1 })
			);
		} finally {
			target.elementsFromPoint = original;
		}
		expect(log).toEqual(["cancel"]);
	});

	test("a press on the toggle button is left to the button", () => {
		const { handlers, log } = events();
		const toggle = document.createElement("button");
		toggle.setAttribute(EYEDROPPER_TOGGLE_ATTRIBUTE, "");
		const label = document.createElement("span");
		toggle.append(label);
		document.body.append(toggle);
		const target = document as Document & {
			elementsFromPoint: (x: number, y: number) => Element[];
		};
		const original = target.elementsFromPoint;
		target.elementsFromPoint = () => [label, toggle, document.body];
		try {
			const disarm = armEyedropper(handlers);
			label.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, button: 0 })
			);
			expect(log).toEqual([]);
			// Still armed: Escape cancels it.
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			expect(log).toEqual(["cancel"]);
			disarm();
		} finally {
			target.elementsFromPoint = original;
			toggle.remove();
		}
	});

	test("the returned function disarms without cancelling", () => {
		const { handlers, log } = events();
		const disarm = armEyedropper(handlers);
		disarm();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(log).toEqual([]);
	});
});
