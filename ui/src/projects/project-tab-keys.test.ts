import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { projectTabKeyOffset, readsRightToLeft } from "./project-tab-keys.ts";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

afterEach(() => {
	document.documentElement.removeAttribute("dir");
	document.body.replaceChildren();
});

describe("projectTabKeyOffset", () => {
	test("ArrowRight moves to the next tab left-to-right", () => {
		expect(projectTabKeyOffset("ArrowRight", false)).toBe(1);
		expect(projectTabKeyOffset("ArrowLeft", false)).toBe(-1);
	});

	test("flips under right-to-left so arrows follow the visible order", () => {
		expect(projectTabKeyOffset("ArrowRight", true)).toBe(-1);
		expect(projectTabKeyOffset("ArrowLeft", true)).toBe(1);
	});

	test("ignores keys that are not horizontal arrows", () => {
		expect(projectTabKeyOffset("Home", true)).toBeUndefined();
		expect(projectTabKeyOffset("ArrowDown", false)).toBeUndefined();
	});
});

describe("readsRightToLeft", () => {
	test("reads left-to-right without a dir", () => {
		const tab = document.createElement("button");
		document.body.append(tab);
		expect(readsRightToLeft(tab)).toBe(false);
		expect(readsRightToLeft()).toBe(false);
	});

	test("follows the document direction", () => {
		document.documentElement.setAttribute("dir", "rtl");
		const tab = document.createElement("button");
		document.body.append(tab);
		expect(readsRightToLeft(tab)).toBe(true);
		expect(readsRightToLeft()).toBe(true);
	});

	test("prefers the nearest explicit dir", () => {
		const strip = document.createElement("nav");
		strip.setAttribute("dir", "ltr");
		const tab = document.createElement("button");
		strip.append(tab);
		document.body.append(strip);
		document.documentElement.setAttribute("dir", "rtl");
		expect(readsRightToLeft(tab)).toBe(false);
	});
});
