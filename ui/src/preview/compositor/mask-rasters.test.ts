import { describe, expect, test } from "bun:test";
import { MaskRasters } from "./mask-rasters.ts";
import type { CompositorMask } from "./plan.ts";

interface Pending {
	key: string;
	reject: (error: Error) => void;
	resolve: (raster: string) => void;
}

/** A rasterizer whose loads finish only when the test says so. */
function controlledRasters() {
	const pending: Pending[] = [];
	let ready = 0;
	const rasters = new MaskRasters<string>(
		() => {
			ready++;
		},
		(_frame, masks) =>
			new Promise<string>((resolve, reject) => {
				pending.push({ key: masks[0]?.svg ?? "", reject, resolve });
			})
	);
	return { pending, rasters, readyCount: () => ready };
}

const frame = { height: 90, width: 160 };
const mask = (svg: string): CompositorMask[] => [{ pad: 0, svg }];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MaskRasters", () => {
	test("a clip's first mask is not ready until it loads, then is exact", async () => {
		const { pending, rasters, readyCount } = controlledRasters();
		expect(rasters.get("clip", frame, mask("a"), 0)).toBeNull();
		expect(rasters.get("clip", frame, mask("a"), 0)).toBeNull();
		expect(pending).toHaveLength(1);
		pending[0]?.resolve("raster-a");
		await settle();
		expect(readyCount()).toBe(1);
		expect(rasters.get("clip", frame, mask("a"), 0)).toEqual({
			age: 0,
			exact: true,
			raster: "raster-a",
		});
	});

	test("an animated mask draws with the last ready raster and keeps one load in flight", async () => {
		const { pending, rasters } = controlledRasters();
		rasters.get("clip", frame, mask("t0"), 0);
		pending.shift()?.resolve("raster-t0");
		await settle();
		// Playback: every frame interpolates a new mask (a new key).
		for (const time of ["t1", "t2", "t3", "t4"]) {
			expect(rasters.get("clip", frame, mask(time), 0)).toEqual({
				age: 0,
				exact: false,
				raster: "raster-t0",
			});
		}
		// Only the first new key started loading; the rest waited for it.
		expect(pending.map((load) => load.key)).toEqual(["t1"]);
		pending.shift()?.resolve("raster-t1");
		await settle();
		// The finished raster is used at once, and the newest mask loads next.
		expect(rasters.get("clip", frame, mask("t5"), 0)).toEqual({
			age: 0,
			exact: false,
			raster: "raster-t1",
		});
		expect(pending.map((load) => load.key)).toEqual(["t5"]);
	});

	test("a previous mask ages from the frame that asked for it", async () => {
		const { pending, rasters } = controlledRasters();
		rasters.get("clip", frame, mask("t0"), 1000);
		pending.shift()?.resolve("raster-t0");
		await settle();
		// Exact at 1040 ms: that frame asked for it now.
		expect(rasters.get("clip", frame, mask("t0"), 1040)?.age).toBe(0);
		// The next mask is loading; the previous one was asked for at 1040 ms.
		expect(rasters.get("clip", frame, mask("t1"), 1056)?.age).toBe(16);
		pending.shift()?.resolve("raster-t1");
		await settle();
		// A finished load counts from when its frame asked (1056 ms), so a
		// mask that keeps decoding stays young; a stalled load ages.
		expect(rasters.get("clip", frame, mask("t2"), 1072)).toEqual({
			age: 16,
			exact: false,
			raster: "raster-t1",
		});
		expect(rasters.get("clip", frame, mask("t3"), 1600)?.age).toBe(544);
	});

	test("clips load independently and forget their raster when they leave", async () => {
		const { pending, rasters } = controlledRasters();
		rasters.get("one", frame, mask("a"), 0);
		rasters.get("two", frame, mask("b"), 0);
		expect(pending).toHaveLength(2);
		pending.shift()?.resolve("raster-a");
		pending.shift()?.resolve("raster-b");
		await settle();
		rasters.retain(new Set(["two"]));
		expect(rasters.get("one", frame, mask("c"), 0)).toBeNull();
		expect(rasters.get("two", frame, mask("d"), 0)?.raster).toBe("raster-b");
	});

	test("a mask that fails to draw is not retried on every frame", async () => {
		const { pending, rasters, readyCount } = controlledRasters();
		rasters.get("clip", frame, mask("broken"), 0);
		pending.shift()?.reject(new Error("bad svg"));
		await settle();
		expect(readyCount()).toBe(1);
		expect(rasters.get("clip", frame, mask("broken"), 0)).toBeNull();
		expect(pending).toHaveLength(0);
	});
});
