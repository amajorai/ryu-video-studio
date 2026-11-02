import { describe, expect, test } from "bun:test";
import type { DragEvent as ReactDragEvent } from "react";
import { testVideo } from "../editor/test-runtime.ts";
import {
	ASSET_DRAG_MIME,
	activeAssetDrag,
	assetDragPayload,
	assetDragProps,
	hasAssetDrag,
	payloadDuration,
	readAssetDrag,
} from "./drag-source.ts";

/** A minimal DataTransfer that records `setData` like a browser would. */
function transfer(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		dropEffect: "none",
		effectAllowed: "uninitialized",
		getData: (type: string) => data.get(type) ?? "",
		setData: (type: string, value: string) => {
			data.set(type, value);
		},
		get types() {
			return [...data.keys()];
		},
	};
}

const asDataTransfer = (value: ReturnType<typeof transfer>) =>
	value as unknown as DataTransfer;

describe("library drag source", () => {
	test("tiles drag the asset id and an optional marked range", () => {
		const asset = testVideo("a.mp4", 8);
		const props = assetDragProps(asset, { end: 6, start: 2 });
		expect(props.draggable).toBe(true);
		const dataTransfer = transfer();
		const tile = { closest: () => null };
		props.onDragStart({
			currentTarget: tile,
			dataTransfer,
			target: tile,
		} as unknown as ReactDragEvent<HTMLElement>);
		expect(dataTransfer.effectAllowed).toBe("copy");
		expect(JSON.parse(dataTransfer.getData(ASSET_DRAG_MIME))).toEqual({
			assetId: asset.id,
			sourceIn: 2,
			sourceOut: 6,
		});
		expect(dataTransfer.getData("text/plain")).toBe("a.mp4");
		expect(activeAssetDrag()?.asset).toBe(asset);
		props.onDragEnd();
		expect(activeAssetDrag()).toBeNull();
	});

	test("payloads parse strictly and malformed drags are ignored", () => {
		const asset = testVideo();
		const good = transfer({
			[ASSET_DRAG_MIME]: JSON.stringify(assetDragPayload(asset)),
		});
		expect(hasAssetDrag(asDataTransfer(good))).toBe(true);
		expect(readAssetDrag(asDataTransfer(good))).toEqual({ assetId: asset.id });
		expect(readAssetDrag(asDataTransfer(transfer()))).toBeNull();
		expect(hasAssetDrag(asDataTransfer(transfer({ Files: "" })))).toBe(false);
		expect(
			readAssetDrag(asDataTransfer(transfer({ [ASSET_DRAG_MIME]: "{nope" })))
		).toBeNull();
		expect(
			readAssetDrag(
				asDataTransfer(
					transfer({
						[ASSET_DRAG_MIME]: JSON.stringify({ assetId: asset.id, extra: 1 }),
					})
				)
			)
		).toBeNull();
		expect(hasAssetDrag(null)).toBe(false);
	});

	test("payload duration follows the marked range and image defaults", () => {
		const video = testVideo("v.mp4", 12);
		expect(payloadDuration(video, {})).toBe(12);
		expect(payloadDuration(video, { sourceIn: 2, sourceOut: 5 })).toBe(3);
		expect(payloadDuration(video, { sourceIn: 10, sourceOut: 40 })).toBe(2);
		const image = { ...testVideo("still.png", 0), kind: "image" as const };
		expect(payloadDuration(image, {})).toBe(5);
	});
});
