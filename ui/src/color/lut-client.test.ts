import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { identityCubeLut, serializeCubeLut } from "../../../shared/cube-lut.ts";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
});
const {
	deleteLut,
	ensurePreviewLut,
	importLut,
	listLuts,
	lutImportBody,
	lutUnavailableReason,
	readLut,
	usePreviewLut,
} = await import("./lut-client.ts");
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { clearPreviewLuts, hasPreviewLut } = await import(
	"../preview/gl/passes/grade.ts"
);

const ID = "00000000-0000-4000-8000-0000000000aa";
const record = {
	createdAt: "2026-01-01T00:00:00.000Z",
	id: ID,
	name: "Identity",
	size: 2,
};
const cube = serializeCubeLut(identityCubeLut(2));
const calls: unknown[] = [];

function mockHost(
	reply: (input: { method?: string; path: string }) => unknown
) {
	window.ryu = {
		app: {
			request: (input) => {
				calls.push(input);
				return Promise.resolve(reply(input) as never);
			},
		},
	};
}

afterEach(() => {
	calls.length = 0;
	clearPreviewLuts();
	window.ryu = undefined;
});

test("lists, reads, imports and deletes through the sidecar routes", async () => {
	mockHost(({ method, path }) => {
		if (path === "/luts" && method === "POST") {
			return record;
		}
		if (path === "/luts") {
			return { luts: [record] };
		}
		if (method === "DELETE") {
			return { deleted: ID };
		}
		return { cube, lut: record };
	});
	expect(await listLuts()).toEqual([record]);
	expect((await readLut(ID)).size).toBe(2);
	expect(await importLut("Identity", cube)).toEqual(record);
	await deleteLut(ID);
	expect(calls).toEqual([
		{ method: "GET", path: "/luts" },
		{ method: "GET", path: `/luts?id=${ID}` },
		{ body: { cube, name: "Identity" }, method: "POST", path: "/luts" },
		{ method: "DELETE", path: `/luts?id=${ID}` },
	]);
});

test("sidecar refusals surface as errors", async () => {
	mockHost(() => ({ code: "LUT_IN_USE", message: "This LUT is used." }));
	await expect(deleteLut(ID)).rejects.toThrow("This LUT is used.");
});

test("preview LUTs load once", async () => {
	let reads = 0;
	const read = () => {
		reads += 1;
		return Promise.resolve(identityCubeLut(3));
	};
	expect(await ensurePreviewLut(ID, read)).toBe(true);
	expect(hasPreviewLut(ID)).toBe(true);
	expect(await ensurePreviewLut(ID, read)).toBe(false);
	expect(reads).toBe(1);
});

test("concurrent preview loads share one request", async () => {
	let reads = 0;
	const read = () => {
		reads += 1;
		return Promise.resolve(identityCubeLut(3));
	};
	const [first, second] = await Promise.all([
		ensurePreviewLut(ID, read),
		ensurePreviewLut(ID, read),
	]);
	expect([first, second]).toEqual([true, true]);
	expect(reads).toBe(1);
});

test("usePreviewLut loads a referenced LUT and re-renders when it arrives", async () => {
	Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
		configurable: true,
		value: true,
		writable: true,
	});
	let release: (lut: ReturnType<typeof identityCubeLut>) => void = () =>
		undefined;
	const read = () =>
		new Promise<ReturnType<typeof identityCubeLut>>((resolve) => {
			release = resolve;
		});
	const seen: number[] = [];
	function Layer({ lutId }: { lutId?: string }) {
		seen.push(usePreviewLut(lutId, read));
		return null;
	}
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => {
			root.render(createElement(Layer, { lutId: ID }));
		});
		expect(hasPreviewLut(ID)).toBe(false);
		await act(async () => {
			release(identityCubeLut(3));
			await Promise.resolve();
		});
		expect(hasPreviewLut(ID)).toBe(true);
		expect(seen.at(-1)).toBe(1);
	} finally {
		act(() => root.unmount());
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

test("imports larger than the sidecar's request limit fail clearly", () => {
	const small = serializeCubeLut(identityCubeLut(33));
	expect(lutImportBody("Film", small)).toEqual({ cube: small, name: "Film" });
	const large = serializeCubeLut(identityCubeLut(65));
	expect(() => lutImportBody("Big", large)).toThrow(
		/65-point\) is \d+\.\d MB once validated; imports are limited to 2\.0 MB/
	);
});

test("a missing lut3d filter explains why LUTs are disabled", () => {
	expect(lutUnavailableReason({ filters: { lut3d: false } })).toContain(
		"lut3d"
	);
	expect(lutUnavailableReason({ filters: { lut3d: true } })).toBeNull();
	expect(lutUnavailableReason(undefined)).toBeNull();
});
