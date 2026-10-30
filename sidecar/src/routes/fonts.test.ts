import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	importedFontFile,
	MAX_FONT_BYTES,
	MAX_INLINE_FONT_BYTES,
} from "../../../shared/font-file.ts";
import { BUNDLED_FONT_FILES } from "../../../shared/text-style.ts";
import { fontLibraryFor } from "../font-library.ts";
import { createStudioServer } from "../server.ts";
import { MAX_MEDIA_ASSETS, StudioStore } from "../store.ts";
import { resetSystemFonts } from "../system-fonts.ts";
import { routes } from "./fonts.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) {
		await task();
	}
});

async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-fonts-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const call = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				...init,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...init.headers,
				},
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, directory, store };
}

const lobster = await Bun.file(
	join(import.meta.dir, "../../assets/fonts/Lobster-Regular.ttf")
).bytes();
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

test("imports a TTF, lists it, and returns its bytes for the preview", async () => {
	const { call } = await harness();
	const imported = await call("/fonts", {
		body: JSON.stringify({ data: base64(lobster), name: "My Lobster.ttf" }),
		method: "POST",
	});
	expect(imported.status).toBe(201);
	expect(imported.body).toMatchObject({
		family: "Lobster",
		format: "truetype",
		name: "My Lobster",
		size: lobster.byteLength,
	});
	const listed = await call("/fonts");
	expect(listed.body.fonts).toHaveLength(1);
	const read = await call(`/fonts?id=${imported.body.id}`);
	expect(
		Buffer.from(read.body.data, "base64").equals(Buffer.from(lobster))
	).toBe(true);
	expect((await call(`/fonts?id=${crypto.randomUUID()}`)).status).toBe(404);
});

test("refuses web fonts and files that are not fonts", async () => {
	const { call } = await harness();
	const woff2 = new Uint8Array(64);
	woff2.set(new TextEncoder().encode("wOF2"));
	const refused = await call("/fonts", {
		body: JSON.stringify({ data: base64(woff2), name: "web.woff2" }),
		method: "POST",
	});
	expect(refused.status).toBe(400);
	expect(refused.body.code).toBe("INVALID_FONT");
	const text = await call("/fonts", {
		body: JSON.stringify({
			data: base64(new TextEncoder().encode("definitely not a font file")),
		}),
		method: "POST",
	});
	expect(text.status).toBe(400);
});

test("a font used by a title cannot be deleted until the title changes", async () => {
	const { call, store } = await harness();
	const font = (
		await call("/fonts", {
			body: JSON.stringify({ data: base64(lobster), name: "Lobster" }),
			method: "POST",
		})
	).body;
	const project = store.save({
		...store.create("Fonts"),
		titles: [
			{
				animation: "fade",
				color: "#ffffff",
				customFont: { family: font.family, id: font.id },
				end: 2,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.08,
				id: crypto.randomUUID(),
				start: 0,
				text: "Hello",
				x: 0.5,
				y: 0.5,
			},
		],
	});
	const blocked = await call(`/fonts?id=${font.id}`, { method: "DELETE" });
	expect(blocked.status).toBe(409);
	expect(blocked.body.code).toBe("FONT_IN_USE");
	store.save({ ...project, titles: [] });
	const deleted = await call(`/fonts?id=${font.id}`, { method: "DELETE" });
	expect(deleted.status).toBe(200);
	expect((await call("/fonts")).body.fonts).toHaveLength(0);
});

test("a render's fontsdir holds the bundled fonts and only the imported fonts the project uses", async () => {
	const { call, directory } = await harness();
	const library = fontLibraryFor(directory);
	expect(await library.renderFontsDirectory([], "/bundled")).toBe("/bundled");
	const importFont = async (name: string) =>
		(
			await call("/fonts", {
				body: JSON.stringify({ data: base64(lobster), name }),
				method: "POST",
			})
		).body;
	const used = await importFont("Used");
	const unused = await importFont("Unused");
	const bundled = join(import.meta.dir, "../../assets/fonts");
	// A project that uses no imported font renders from the bundled fonts.
	expect(await library.renderFontsDirectory([], bundled)).toBe(bundled);
	const render = await library.renderFontsDirectory([used.id], bundled);
	expect(render?.startsWith(join(directory, "fonts", "render"))).toBe(true);
	const files = (await readdir(render ?? "")).sort();
	expect(files).toEqual([...BUNDLED_FONT_FILES, importedFontFile(used)].sort());
	expect(files).not.toContain(importedFontFile(unused));
	// Hard-linked from the library, not a second copy of the bytes.
	const [stored, linked] = await Promise.all([
		stat(library.path(used)),
		stat(join(render ?? "", importedFontFile(used))),
	]);
	expect(linked.ino).toBe(stored.ino);
	// Another font set is its own directory; the same set is reused.
	const both = await library.renderFontsDirectory(
		[used.id, unused.id],
		bundled
	);
	expect(both).not.toBe(render);
	expect(await library.renderFontsDirectory([used.id], bundled)).toBe(render);
	// Deleting a font drops the sets that linked it.
	await library.remove(used.id, []);
	expect(existsSync(render ?? "")).toBe(false);
	expect(existsSync(both ?? "")).toBe(false);
	expect(await library.renderFontsDirectory([used.id], bundled)).toBe(bundled);
});

test("imported fonts count against the media storage allowance", async () => {
	const { call, store } = await harness();
	const before = store.mediaStorageBytes();
	const font = (
		await call("/fonts", {
			body: JSON.stringify({ data: base64(lobster), name: "Lobster" }),
			method: "POST",
		})
	).body;
	// The font file, plus its small index.
	const grown = store.mediaStorageBytes() - before;
	expect(grown).toBeGreaterThanOrEqual(font.size);
	expect(grown).toBeLessThan(font.size + 4096);
	const reserved: { asset?: boolean; bytes: number }[] = [];
	const reserve = store.reserveMediaStorage.bind(store);
	store.reserveMediaStorage = (bytes, options) => {
		reserved.push({ bytes, ...options });
		if (reserved.length > 1) {
			throw new Error("Media storage quota reached.");
		}
		return reserve(bytes, options);
	};
	expect(
		(
			await call("/fonts", {
				body: JSON.stringify({ data: base64(lobster), name: "Second" }),
				method: "POST",
			})
		).status
	).toBe(201);
	const refused = await call("/fonts", {
		body: JSON.stringify({ data: base64(lobster), name: "Third" }),
		method: "POST",
	});
	expect(refused.status).toBe(400);
	expect(refused.body.message).toBe("Media storage quota reached.");
	expect(reserved).toEqual([
		{ asset: false, bytes: lobster.byteLength },
		{ asset: false, bytes: lobster.byteLength },
	]);
	expect((await call("/fonts")).body.fonts).toHaveLength(2);
});

test("a font upload opens while the media library is full and cannot be finished as media", async () => {
	const { call, store } = await harness();
	const full = Array.from({ length: MAX_MEDIA_ASSETS }, () => ({}));
	store.assets = () => full as ReturnType<StudioStore["assets"]>;
	const media = await call("/uploads", {
		body: JSON.stringify({ name: "Clip.mp4", size: 1000 }),
		method: "POST",
	});
	expect(media.status).toBe(400);
	expect(media.body.message).toBe("Media upload limit reached.");
	const upload = await call("/uploads", {
		body: JSON.stringify({
			name: "Big.ttf",
			purpose: "font",
			size: lobster.byteLength,
		}),
		method: "POST",
	});
	expect(upload.status).toBe(201);
	const { id } = upload.body as { id: string };
	await call(`/uploads/${id}`, {
		body: JSON.stringify({ data: base64(lobster), offset: 0 }),
		method: "PUT",
	});
	const finish = await call(`/uploads/${id}/finish`, {
		body: "{}",
		method: "POST",
	});
	expect(finish.status).toBe(400);
	expect(finish.body.message).toContain("POST /fonts");
	const imported = await call("/fonts", {
		body: JSON.stringify({ name: "Big.ttf", uploadId: id }),
		method: "POST",
	});
	expect(imported.status).toBe(201);
	expect(imported.body.family).toBe("Lobster");
	const oversized = await call("/uploads", {
		body: JSON.stringify({
			name: "Huge.ttf",
			purpose: "font",
			size: MAX_FONT_BYTES + 1,
		}),
		method: "POST",
	});
	expect(oversized.status).toBe(400);
});

test("adopt stores an archived font under its id and refuses a mislabeled file", async () => {
	const directories = await Promise.all([
		mkdtemp(join(tmpdir(), "ryu-video-studio-fonts-a-")),
		mkdtemp(join(tmpdir(), "ryu-video-studio-fonts-b-")),
	]);
	cleanup.push(async () => {
		for (const directory of directories) {
			await rm(directory, { force: true, recursive: true });
		}
	});
	const [from, to] = directories.map((directory) => fontLibraryFor(directory));
	const record = await from?.add("Lobster.ttf", lobster);
	if (!(record && to)) {
		throw new Error("font libraries were not created");
	}
	expect(await to.adopt(record, lobster)).toBe("added");
	expect(await to.get(record.id)).toEqual(record);
	expect(
		Buffer.from(await to.read(record.id)).equals(Buffer.from(lobster))
	).toBe(true);
	expect(await to.adopt(record, lobster)).toBe("reused");
	const mislabeled = { ...record, family: "Inter", id: crypto.randomUUID() };
	await expect(to.adopt(mislabeled, lobster)).rejects.toThrow(
		"reads as Lobster"
	);
	expect(await to.list()).toHaveLength(1);
});

test("a font used by a caption style is in use too", async () => {
	const { call, store } = await harness();
	const font = (
		await call("/fonts", {
			body: JSON.stringify({ data: base64(lobster), name: "Lobster" }),
			method: "POST",
		})
	).body;
	const project = store.save({
		...store.create("Caption fonts"),
		captionStyle: { customFont: { family: font.family, id: font.id } },
	});
	const blocked = await call(`/fonts?id=${font.id}`, { method: "DELETE" });
	expect(blocked.status).toBe(409);
	expect(blocked.body.message).toContain("captions");
	const { captionStyle: _style, ...rest } = project;
	store.save(rest);
	expect(
		(await call(`/fonts?id=${font.id}`, { method: "DELETE" })).status
	).toBe(200);
});

test("lists installed system font families", async () => {
	const { call } = await harness();
	resetSystemFonts();
	const listed = await call("/system-fonts");
	expect(listed.status).toBe(200);
	expect(typeof listed.body.available).toBe("boolean");
	expect(Array.isArray(listed.body.fonts)).toBe(true);
	resetSystemFonts();
});

test("imports a 10 MB font through 512 KiB upload chunks and reads it back in chunks", async () => {
	const { call } = await harness();
	// A real TrueType file padded past the one-request limit (the table
	// directory still points inside it, so it reads as Lobster).
	const big = new Uint8Array(10_000_000);
	big.set(lobster);
	const upload = await call("/uploads", {
		body: JSON.stringify({ name: "Big Lobster.ttf", size: big.byteLength }),
		method: "POST",
	});
	expect(upload.status).toBe(201);
	const { chunkSize, id } = upload.body as { chunkSize: number; id: string };
	expect(chunkSize).toBe(512 * 1024);
	let chunks = 0;
	for (let offset = 0; offset < big.byteLength; offset += chunkSize) {
		const sent = await call(`/uploads/${id}`, {
			body: JSON.stringify({
				data: base64(big.subarray(offset, offset + chunkSize)),
				offset,
			}),
			method: "PUT",
		});
		expect(sent.status).toBe(200);
		chunks++;
	}
	expect(chunks).toBe(20);
	const imported = await call("/fonts", {
		body: JSON.stringify({ name: "Big Lobster.ttf", uploadId: id }),
		method: "POST",
	});
	expect(imported.status).toBe(201);
	expect(imported.body).toMatchObject({
		family: "Lobster",
		name: "Big Lobster",
		size: 10_000_000,
	});
	// The upload session is consumed: it cannot be finished as media too.
	expect(
		(await call(`/uploads/${id}/finish`, { body: "{}", method: "POST" })).status
	).toBe(404);
	const parts: Uint8Array[] = [];
	let offset = 0;
	for (;;) {
		const read = await call(`/fonts?id=${imported.body.id}&offset=${offset}`);
		const bytes = Buffer.from(read.body.data, "base64");
		parts.push(bytes);
		offset += bytes.byteLength;
		if (read.body.done) {
			expect(read.body.size).toBe(10_000_000);
			break;
		}
	}
	expect(Buffer.concat(parts).equals(Buffer.from(big))).toBe(true);
});

test("refuses an incomplete upload, and data with an uploadId", async () => {
	const { call } = await harness();
	const upload = await call("/uploads", {
		body: JSON.stringify({ name: "Half.ttf", size: 2_000_000 }),
		method: "POST",
	});
	const { id } = upload.body as { id: string };
	await call(`/uploads/${id}`, {
		body: JSON.stringify({
			data: base64(lobster.subarray(0, 1000)),
			offset: 0,
		}),
		method: "PUT",
	});
	const incomplete = await call("/fonts", {
		body: JSON.stringify({ uploadId: id }),
		method: "POST",
	});
	expect(incomplete.status).toBe(400);
	expect(incomplete.body.message).toBe("The upload is incomplete.");
	const both = await call("/fonts", {
		body: JSON.stringify({ data: base64(lobster), uploadId: id }),
		method: "POST",
	});
	expect(both.status).toBe(400);
});

test("a font over the inline limit is read only in chunks", async () => {
	const { call } = await harness();
	const big = new Uint8Array(MAX_INLINE_FONT_BYTES + 1);
	big.set(lobster);
	const upload = await call("/uploads", {
		body: JSON.stringify({
			name: "Wide.ttf",
			purpose: "font",
			size: big.byteLength,
		}),
		method: "POST",
	});
	const { chunkSize, id } = upload.body as { chunkSize: number; id: string };
	for (let offset = 0; offset < big.byteLength; offset += chunkSize) {
		await call(`/uploads/${id}`, {
			body: JSON.stringify({
				data: base64(big.subarray(offset, offset + chunkSize)),
				offset,
			}),
			method: "PUT",
		});
	}
	const font = (
		await call("/fonts", {
			body: JSON.stringify({ name: "Wide.ttf", uploadId: id }),
			method: "POST",
		})
	).body;
	const whole = await call(`/fonts?id=${font.id}`);
	expect(whole.status).toBe(413);
	expect(whole.body.code).toBe("FONT_CHUNKED_READ");
	expect(whole.body.data).toBeUndefined();
	const first = await call(`/fonts?id=${font.id}&offset=0`);
	expect(first.status).toBe(200);
	expect(first.body.size).toBe(big.byteLength);
});
