import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	identityCubeLut,
	parseCubeLut,
	serializeCubeLut,
} from "../../shared/cube-lut.ts";
import { lutIdsIn } from "../../shared/library-refs.ts";
import { newProject, newSegment, type Project } from "../../shared/project.ts";
import {
	LutInUseError,
	LutStore,
	lutResolver,
	lutStoreFor,
	projectsUsingLut,
} from "./lut-store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0)) {
		await task();
	}
});

async function tempStore() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-luts-"));
	cleanup.push(() =>
		rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	);
	return new LutStore(directory);
}

const messyCube = `# exported by a grading tool
TITLE "Warm"
LUT_3D_SIZE 2

0 0 0
1 0 0   # red corner
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

function projectUsing(lutId: string): Project {
	const segment = newSegment({
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Clip",
		width: 640,
	});
	segment.colorGrade = {
		...segment.colorGrade,
		lut: { intensity: 1, lutId },
	};
	return { ...newProject("Graded"), segments: [segment] };
}

test("imports canonicalize, list, read and delete LUTs", async () => {
	const store = await tempStore();
	const record = await store.add("  My LUT ", messyCube);
	expect(record).toMatchObject({ name: "My LUT", size: 2 });
	expect(await store.list()).toEqual([record]);
	const text = await store.read(record.id);
	expect(text).toBe(serializeCubeLut(parseCubeLut(messyCube)));
	expect(await readFile(store.path(record.id), "utf8")).toBe(text);
	await store.remove(record.id, []);
	expect(await store.list()).toEqual([]);
	expect(existsSync(store.path(record.id))).toBe(false);
});

test("an unnamed import falls back to the LUT title", async () => {
	const store = await tempStore();
	expect((await store.add("", messyCube)).name).toBe("Warm");
	expect((await store.add("", serializeCubeLut(identityCubeLut(3)))).name).toBe(
		"LUT"
	);
});

test("invalid LUTs are refused before anything is written", async () => {
	const store = await tempStore();
	await expect(store.add("bad", "LUT_3D_SIZE 2\n0 0 0\n")).rejects.toThrow(
		"needs 8"
	);
	expect(await store.list()).toEqual([]);
	expect(existsSync(store.directory)).toBe(false);
});

test("concurrent imports keep every record", async () => {
	const store = await tempStore();
	const cube = serializeCubeLut(identityCubeLut(2));
	await Promise.all(
		Array.from({ length: 6 }, (_, index) => store.add(`LUT ${index}`, cube))
	);
	expect((await store.list()).map((record) => record.name).sort()).toEqual(
		["LUT 0", "LUT 1", "LUT 2", "LUT 3", "LUT 4", "LUT 5"].sort()
	);
});

test("a LUT in use cannot be deleted", async () => {
	const store = await tempStore();
	const record = await store.add("Used", messyCube);
	const project = projectUsing(record.id);
	expect(projectsUsingLut([project], record.id)).toEqual(["Graded"]);
	expect(projectsUsingLut([project], crypto.randomUUID())).toEqual([]);
	await expect(store.remove(record.id, [project])).rejects.toBeInstanceOf(
		LutInUseError
	);
	expect(await store.list()).toHaveLength(1);
	await expect(store.remove(crypto.randomUUID(), [])).rejects.toThrow(
		"LUT not found."
	);
});

test("a LUT referenced only by saved history is retired, then purged", async () => {
	const store = await tempStore();
	const record = await store.add("Undo", messyCube);
	const revision = projectUsing(record.id);
	const current = { ...revision, segments: [] };
	expect(projectsUsingLut([revision, revision], record.id)).toEqual(["Graded"]);
	expect(await store.remove(record.id, [current], [revision])).toEqual({
		keptForHistory: true,
	});
	expect(await store.list()).toEqual([]);
	expect(await store.retired()).toEqual([record]);
	expect(existsSync(store.path(record.id))).toBe(true);
	expect(await store.get(record.id)).toEqual(record);
	await store.assertAvailable({ lut: { lutId: record.id } });
	// Deleting another LUT once history no longer names it purges the file.
	const other = await store.add("Other", messyCube);
	expect(await store.remove(other.id, [current], [current])).toEqual({
		keptForHistory: false,
	});
	expect(await store.retired()).toEqual([]);
	expect(existsSync(store.path(record.id))).toBe(false);
	expect(await store.get(record.id)).toBeUndefined();
});

test("a retired LUT that undo restored cannot be deleted again", async () => {
	const store = await tempStore();
	const record = await store.add("Back", messyCube);
	const revision = projectUsing(record.id);
	await store.remove(record.id, [{ ...revision, segments: [] }], [revision]);
	await expect(store.remove(record.id, [revision])).rejects.toBeInstanceOf(
		LutInUseError
	);
	expect(await store.retired()).toEqual([record]);
});

test("lutIdsIn finds nested lutId references", () => {
	const project = projectUsing("a");
	expect([...lutIdsIn({ patch: { lut: { lutId: "b" } }, project })]).toEqual([
		"b",
		"a",
	]);
	expect(lutIdsIn({ lut: null, lutId: 3 }).size).toBe(0);
});

test("assertAvailable refuses references to LUTs that are not stored", async () => {
	const store = await tempStore();
	const record = await store.add("Here", messyCube);
	await store.assertAvailable({ patch: { lut: { lutId: record.id } } });
	await store.assertAvailable({ patch: { lut: null } });
	await expect(
		store.assertAvailable({ lut: { lutId: crypto.randomUUID() } })
	).rejects.toThrow("is not in the library");
});

test("lutResolver returns stored LUT files and explains missing ones", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-luts-"));
	cleanup.push(() =>
		rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	);
	const record = await lutStoreFor(directory).add("Resolved", messyCube);
	const resolve = lutResolver(directory);
	expect(resolve(record.id)).toBe(join(directory, "luts", `${record.id}.cube`));
	expect(() => resolve(crypto.randomUUID())).toThrow(
		"missing from the library"
	);
});

test("paths only accept LUT ids", async () => {
	const store = await tempStore();
	expect(() => store.path("../escape")).toThrow();
	await expect(store.read(crypto.randomUUID())).rejects.toThrow(
		"LUT not found."
	);
});

test("adopt stores an archived LUT under its id, reuses and un-retires known ones", async () => {
	const source = await tempStore();
	const record = await source.add("Carried", messyCube);
	const text = await source.read(record.id);
	const target = await tempStore();
	expect(await target.adopt(record, text)).toBe("added");
	expect(await target.list()).toEqual([record]);
	expect(await target.read(record.id)).toBe(text);
	expect(await target.adopt(record, text)).toBe("reused");
	expect(await target.list()).toHaveLength(1);
	// A LUT the target retired comes back into its library.
	const revision = projectUsing(record.id);
	await target.remove(record.id, [], [revision]);
	expect(await target.list()).toEqual([]);
	expect(await target.adopt(record, text)).toBe("reused");
	expect(await target.list()).toEqual([record]);
	expect(await target.retired()).toEqual([]);
	// Text that is not a LUT is refused before anything is written.
	const other = { ...record, id: crypto.randomUUID() };
	await expect(target.adopt(other, "not a lut")).rejects.toThrow();
	expect(existsSync(target.path(other.id))).toBe(false);
});
