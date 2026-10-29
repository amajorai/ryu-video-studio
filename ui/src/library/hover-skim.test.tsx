import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const {
	pointerFraction,
	SKIM_BUCKETS,
	SkimFrameCache,
	skimFramePath,
	skimTime,
	useHoverSkim,
} = await import("./hover-skim.ts");

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

const video = { duration: 64, id: crypto.randomUUID(), kind: "video" } as const;

describe("skim time mapping", () => {
	test("pointer x maps to a clamped fraction of the tile", () => {
		const rect = { left: 100, width: 200 };
		expect(pointerFraction(100, rect)).toBe(0);
		expect(pointerFraction(200, rect)).toBe(0.5);
		expect(pointerFraction(50, rect)).toBe(0);
		expect(pointerFraction(400, rect)).toBe(1);
		expect(pointerFraction(150, { left: 0, width: 0 })).toBe(0);
	});

	test("fractions quantize to the centre of a bucket", () => {
		// 64 s over 32 buckets: 2 s per bucket, centres at 1, 3, 5 … 63.
		expect(skimTime(0, video)).toBe(1);
		expect(skimTime(0.03, video)).toBe(1);
		expect(skimTime(0.032, video)).toBe(3);
		expect(skimTime(0.5, video)).toBe(33);
		expect(skimTime(1, video)).toBe(63);
		expect(skimTime(0.999, video, 4)).toBe(56);
		const times = new Set(
			Array.from({ length: 500 }, (_, index) => skimTime(index / 499, video))
		);
		expect(times.size).toBe(SKIM_BUCKETS);
	});

	test("stills and audio do not move", () => {
		expect(skimTime(0.7, { duration: 5, kind: "image" })).toBe(0);
		expect(skimTime(0.7, { duration: 5, kind: "audio" })).toBe(0);
		expect(skimTime(0.7, { duration: 0, kind: "video" })).toBe(0);
	});

	test("frame paths carry the time and height", () => {
		expect(skimFramePath("abc", 1.5, 90)).toBe(
			"/assets/abc/skim-frame?height=90&time=1.5"
		);
	});

	test("the frame cache evicts the least recently used entry", () => {
		const cache = new SkimFrameCache(2);
		cache.set("a", "1");
		cache.set("b", "2");
		expect(cache.get("a")).toBe("1");
		cache.set("c", "3");
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("1");
		expect(cache.size).toBe(2);
	});
});

describe("useHoverSkim", () => {
	test("coalesces moves, caches frames, and stops after a failure", async () => {
		const requests: string[] = [];
		let release: (() => void) | undefined;
		const load = (path: string) => {
			requests.push(path);
			return new Promise<{ data: string }>((resolve) => {
				release = () => resolve({ data: "AAAA" });
			});
		};
		const cache = new SkimFrameCache();
		let skim: ReturnType<typeof useHoverSkim> | undefined;
		function Probe() {
			skim = useHoverSkim(video, { cache, height: 90, load });
			return null;
		}
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(<Probe />));
		const move = (clientX: number) =>
			skim?.onPointerMove({
				clientX,
				currentTarget: {
					getBoundingClientRect: () => ({ left: 0, width: 320 }),
				},
			});
		await act(async () => {
			move(0);
			move(100);
			move(160);
		});
		// One request in flight; later moves wait and only the latest is loaded.
		expect(requests).toEqual([skimFramePath(video.id, 1, 90)]);
		expect(skim?.time).toBe(33);
		await act(async () => {
			release?.();
			await Promise.resolve();
		});
		await act(async () => {
			release?.();
			await Promise.resolve();
		});
		expect(requests).toEqual([
			skimFramePath(video.id, 1, 90),
			skimFramePath(video.id, 33, 90),
		]);
		expect(skim?.frame).toBe("data:image/jpeg;base64,AAAA");
		// A cached time shows without another request.
		await act(async () => move(0));
		expect(requests).toHaveLength(2);
		await act(async () => skim?.onPointerLeave());
		expect(skim?.time).toBeNull();
		expect(skim?.frame).toBe("data:image/jpeg;base64,AAAA");
		await act(async () => root.unmount());

		const failing = () => Promise.reject(new Error("offline"));
		let broken: ReturnType<typeof useHoverSkim> | undefined;
		const calls: string[] = [];
		function Broken() {
			broken = useHoverSkim(video, {
				cache: new SkimFrameCache(),
				load: (path) => {
					calls.push(path);
					return failing();
				},
			});
			return null;
		}
		const other = createRoot(host);
		await act(async () => other.render(<Broken />));
		await act(async () => {
			broken?.showTime(5);
			await Promise.resolve();
		});
		expect(broken?.unavailable).toBe(true);
		await act(async () => broken?.showTime(9));
		expect(calls).toHaveLength(1);
		await act(async () => other.unmount());
		host.remove();
	});
	test("a slow fetch for an older time never replaces a newer cached frame", async () => {
		const cache = new SkimFrameCache();
		cache.set(`${video.id}:90:2`, "data:image/jpeg;base64,CACHED");
		let release: (() => void) | undefined;
		const load = () =>
			new Promise<{ data: string }>((resolve) => {
				release = () => resolve({ data: "STALE" });
			});
		let skim: ReturnType<typeof useHoverSkim> | undefined;
		function Probe() {
			skim = useHoverSkim(video, { cache, height: 90, load });
			return null;
		}
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(<Probe />));
		await act(async () => skim?.showTime(5));
		await act(async () => skim?.showTime(2));
		expect(skim?.frame).toBe("data:image/jpeg;base64,CACHED");
		await act(async () => {
			release?.();
			await Promise.resolve();
		});
		expect(skim?.time).toBe(2);
		expect(skim?.frame).toBe("data:image/jpeg;base64,CACHED");
		// The fetched frame is still cached for when the pointer returns.
		expect(cache.get(`${video.id}:90:5`)).toBe("data:image/jpeg;base64,STALE");
		await act(async () => root.unmount());
		host.remove();
	});
});
