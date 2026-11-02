import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityCubeLut, serializeCubeLut } from "../../../shared/cube-lut.ts";
import { newSegment, type Title } from "../../../shared/project.ts";
import { fontLibraryFor } from "../font-library.ts";
import { bundledFontsDirectory } from "../fonts.ts";
import { lutStoreFor } from "../lut-store.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-archive-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
	const call = async (path: string, body?: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: body === undefined ? "GET" : "POST",
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

test("a project archive carries its media to another node and reopens there", async () => {
	const source = await studio();
	const clipPath = join(source.store.directory, "clip.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=160x90:r=10:d=1",
		"-pix_fmt",
		"yuv420p",
		clipPath,
	]);
	const asset = {
		...(await probe(clipPath)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "clip.mp4",
	};
	await Bun.write(source.store.mediaPath(asset.id), Bun.file(clipPath));
	source.store.putAsset(asset);
	const project = source.store.save({
		...source.store.create("Archive me"),
		segments: [newSegment(asset)],
	});

	const built = await source.call(`/projects/${project.id}/package?media=1`);
	expect(built.status).toBe(200);
	expect(built.body).toMatchObject({ assets: 1, missing: [] });
	expect(built.body.filename).toBe("Archive me.ryu-video-project.zip");
	const parts: Buffer[] = [];
	for (let offset = 0; ; ) {
		const chunk = await source.call(
			`/package-archive-data?id=${built.body.archiveId}&offset=${offset}`
		);
		expect(chunk.status).toBe(200);
		const bytes = Buffer.from(chunk.body.data, "base64");
		parts.push(bytes);
		offset += bytes.length;
		if (chunk.body.done) {
			break;
		}
	}
	const archive = Buffer.concat(parts);
	expect(archive.length).toBe(built.body.size);
	// The archive is removed once its last chunk is read.
	expect(
		(await source.call(`/package-archive-data?id=${built.body.archiveId}`))
			.status
	).toBe(404);

	const target = await studio();
	const started = await target.call("/package-archive-imports", {
		size: archive.length,
	});
	expect(started.status).toBe(201);
	for (let offset = 0; offset < archive.length; ) {
		const data = archive.subarray(offset, offset + started.body.chunkSize);
		const sent = await target.call("/package-archive-import-chunks", {
			data: data.toString("base64"),
			id: started.body.id,
			offset,
		});
		expect(sent.status).toBe(200);
		offset = sent.body.offset;
	}
	const finished = await target.call("/package-archive-import-finish", {
		id: started.body.id,
	});
	expect(finished.status).toBe(201);
	expect(finished.body.added).toEqual([asset.id]);
	expect(finished.body.project.title).toBe("Archive me (imported)");
	expect(finished.body.project.segments[0].assetId).toBe(asset.id);
	const imported = target.store.assets().find((item) => item.id === asset.id);
	expect(imported).toMatchObject({ kind: "video", name: "clip.mp4" });
	expect(Bun.file(target.store.mediaPath(asset.id)).size).toBe(
		Bun.file(source.store.mediaPath(asset.id)).size
	);
});

test("an archive without its package is refused", async () => {
	const { call } = await studio();
	const started = await call("/package-archive-imports", { size: 22 });
	const empty = Buffer.alloc(22);
	empty.writeUInt32LE(0x06_05_4b_50, 0);
	await call("/package-archive-import-chunks", {
		data: empty.toString("base64"),
		id: started.body.id,
		offset: 0,
	});
	const finished = await call("/package-archive-import-finish", {
		id: started.body.id,
	});
	expect(finished.status).toBe(400);
	expect(finished.body.message).toContain("no package.json");
});

type Studio = Awaited<ReturnType<typeof studio>>;

async function downloadArchive(source: Studio, projectId: string) {
	const built = await source.call(`/projects/${projectId}/package-archive`);
	if (built.status !== 200) {
		throw new Error(`building the archive answered ${built.status}`);
	}
	const parts: Buffer[] = [];
	for (let offset = 0; ; ) {
		const chunk = await source.call(
			`/package-archive-data?id=${built.body.archiveId}&offset=${offset}`
		);
		const bytes = Buffer.from(chunk.body.data, "base64");
		parts.push(bytes);
		offset += bytes.length;
		if (chunk.body.done) {
			break;
		}
	}
	return { archive: Buffer.concat(parts), built: built.body };
}

async function uploadArchive(target: Studio, archive: Buffer) {
	const started = await target.call("/package-archive-imports", {
		size: archive.length,
	});
	for (let offset = 0; offset < archive.length; ) {
		const sent = await target.call("/package-archive-import-chunks", {
			data: archive
				.subarray(offset, offset + started.body.chunkSize)
				.toString("base64"),
			id: started.body.id,
			offset,
		});
		offset = sent.body.offset;
	}
	return await target.call("/package-archive-import-finish", {
		id: started.body.id,
	});
}

test("a project archive carries its imported LUTs and title fonts under the same ids", async () => {
	const source = await studio();
	const clipPath = join(source.store.directory, "clip.mp4");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=160x90:r=10:d=1",
		"-pix_fmt",
		"yuv420p",
		clipPath,
	]);
	const asset = {
		...(await probe(clipPath)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "clip.mp4",
	};
	await Bun.write(source.store.mediaPath(asset.id), Bun.file(clipPath));
	source.store.putAsset(asset);
	const luts = lutStoreFor(source.store.directory);
	const lut = await luts.add("Identity", serializeCubeLut(identityCubeLut(5)));
	const unused = await luts.add("Unused", serializeCubeLut(identityCubeLut(3)));
	const bundled = bundledFontsDirectory();
	expect(bundled).toBeTruthy();
	const fontBytes = await readFile(join(bundled ?? "", "Lobster-Regular.ttf"));
	const font = await fontLibraryFor(source.store.directory).add(
		"Lobster.ttf",
		fontBytes
	);
	const segment = newSegment(asset);
	const title: Title = {
		animation: "fade",
		color: "#ffffff",
		customFont: { family: font.family, id: font.id },
		end: 1,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.1,
		id: crypto.randomUUID(),
		start: 0,
		text: "Graded",
		x: 0.5,
		y: 0.5,
	};
	const project = source.store.save({
		...source.store.create("Graded"),
		segments: [
			{
				...segment,
				colorGrade: {
					...segment.colorGrade,
					lut: { intensity: 1, lutId: lut.id },
				},
			},
		],
		titles: [title],
	});

	const { archive, built } = await downloadArchive(source, project.id);
	expect(built).toMatchObject({
		fonts: 1,
		luts: 1,
		missingFonts: [],
		missingLuts: [],
	});
	expect(archive.includes(Buffer.from(`luts/${lut.id}.cube`))).toBe(true);
	expect(archive.includes(Buffer.from(`luts/${unused.id}.cube`))).toBe(false);
	expect(archive.includes(Buffer.from(`fonts/${font.id}.ttf`))).toBe(true);

	const target = await studio();
	const finished = await uploadArchive(target, archive);
	expect(finished.status).toBe(201);
	expect(finished.body.luts).toEqual({ added: [lut.id], reused: [] });
	expect(finished.body.fonts).toEqual({ added: [font.id], reused: [] });
	const targetLuts = lutStoreFor(target.store.directory);
	expect((await targetLuts.list()).map((record) => record.id)).toEqual([
		lut.id,
	]);
	expect(await targetLuts.read(lut.id)).toBe(await luts.read(lut.id));
	const targetFonts = fontLibraryFor(target.store.directory);
	expect(await targetFonts.get(font.id)).toMatchObject({
		family: font.family,
		format: font.format,
	});
	expect(Buffer.from(await targetFonts.read(font.id)).equals(fontBytes)).toBe(
		true
	);
	expect(finished.body.project.titles[0].customFont.id).toBe(font.id);
	expect(finished.body.project.segments[0].colorGrade.lut.lutId).toBe(lut.id);

	// A second import of the same archive reuses what the node already holds.
	const again = await uploadArchive(target, archive);
	expect(again.status).toBe(201);
	expect(again.body.luts).toEqual({ added: [], reused: [lut.id] });
	expect(again.body.fonts).toEqual({ added: [], reused: [font.id] });
	expect(await targetLuts.list()).toHaveLength(1);
});

test("a LUT gone from the library is reported and left out of the archive", async () => {
	const source = await studio();
	const clipPath = join(source.store.directory, "still.png");
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=gray:s=64x36:d=1",
		"-frames:v",
		"1",
		clipPath,
	]);
	const asset = {
		...(await probe(clipPath)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "still.png",
	};
	await Bun.write(source.store.mediaPath(asset.id), Bun.file(clipPath));
	source.store.putAsset(asset);
	const segment = newSegment(asset);
	const ghost = crypto.randomUUID();
	const project = source.store.save({
		...source.store.create("Ghost LUT"),
		segments: [
			{
				...segment,
				colorGrade: {
					...segment.colorGrade,
					lut: { intensity: 1, lutId: ghost },
				},
			},
		],
	});
	const { built } = await downloadArchive(source, project.id);
	expect(built).toMatchObject({ luts: 0, missingLuts: [ghost] });
});
