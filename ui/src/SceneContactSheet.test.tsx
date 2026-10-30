import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { type Asset, newProject, sceneSchema } from "../../shared/project.ts";
import * as bridge from "./bridge.ts";

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
const { SceneContactSheet } = await import("./SceneContactSheet.tsx");
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

test("failed thumbnails settle without repeated requests and explicit retry recovers", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const asset: Asset = {
		id: crypto.randomUUID(),
		name: "Missing preview",
		kind: "image",
		width: 320,
		height: 180,
		duration: 5,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
	const scenes = [
		sceneSchema.parse({
			id: crypto.randomUUID(),
			title: "Opening",
			script: "",
			prompt: "",
			assetIds: [asset.id],
			duration: 5,
			sourceIn: 0,
			approved: false,
		}),
	];
	const requests = spyOn(bridge, "request").mockRejectedValue(
		new Error("Thumbnail unavailable")
	);
	const props = {
		assets: [asset],
		scenes,
		project: newProject("Contact sheet"),
		onStatus: () => undefined,
	};
	try {
		await act(async () => {
			root.render(<SceneContactSheet {...props} />);
		});
		await act(async () => {
			await Bun.sleep(50);
		});
		expect(requests).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Preview unavailable");
		await act(async () => {
			root.render(<SceneContactSheet {...props} assets={[asset]} />);
			await Bun.sleep(50);
		});
		expect(requests).toHaveBeenCalledTimes(1);
		requests.mockResolvedValue({ data: "/9j/AA==" });
		const retry = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Retry unavailable previews"
		);
		expect(retry).toBeDefined();
		await act(async () => {
			retry!.click();
			await Bun.sleep(20);
		});
		expect(requests).toHaveBeenCalledTimes(2);
		expect(container.querySelector('img[alt="Scene 1 take"]')).not.toBeNull();
		expect(container.textContent).not.toContain("Retry unavailable previews");
	} finally {
		await act(async () => root.unmount());
		container.remove();
		mock.restore();
	}
});
