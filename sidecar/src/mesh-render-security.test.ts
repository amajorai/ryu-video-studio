import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { meshRigSchema } from "../../shared/mesh-animation.ts";
import { meshSchema, newProject } from "../../shared/project.ts";
import { renderMeshPng } from "./mesh-render.ts";
import { renderMeshPngAsync } from "./mesh-render-runner.ts";

function mesh() {
	return meshSchema.parse({
		id: crypto.randomUUID(),
		start: 0,
		end: 1,
		fill: "#a855f7",
		scale: 3.75,
		vertices: [
			[-0.1, -0.1, 0],
			[0.1, -0.1, 0],
			[0, 0.1, 0],
		],
		faces: [[0, 1, 2]],
	});
}

function pngChunk(type: string, body: Uint8Array) {
	const bytes = Buffer.alloc(body.length + 12);
	bytes.writeUInt32BE(body.length);
	bytes.write(type, 4);
	bytes.set(body, 8);
	return bytes;
}

test("mesh workers preserve ordinary output and let the server timer run", async () => {
	const project = newProject();
	const meshFixture = mesh();
	let timerRan = false;
	const timer = setTimeout(() => {
		timerRan = true;
	}, 0);
	const result = await renderMeshPngAsync(project, meshFixture, 64, 64);
	clearTimeout(timer);
	expect(timerRan).toBe(true);
	expect(result).toEqual(renderMeshPng(project, meshFixture, 64, 64));
});

test("active mesh preprocessing is cancelable and worker termination completes", async () => {
	const controller = new AbortController();
	const meshFixture = mesh();
	meshFixture.faces = Array.from({ length: 2000 }, () => [
		0, 1, 2, 1, 2, 1, 2, 1,
	]);
	const pending = renderMeshPngAsync(
		newProject(),
		meshFixture,
		256,
		256,
		0,
		controller.signal
	);
	setTimeout(() => controller.abort(), 10);
	await expect(pending).rejects.toThrow("canceled");
	expect(
		(await renderMeshPngAsync(newProject(), mesh(), 16, 16)).byteLength
	).toBeGreaterThan(0);
});

test("workers preserve rig deformation and aggregate work accounting", async () => {
	const meshFixture = mesh();
	const identity = Array.from({ length: 16 }, (_, index) =>
		index % 5 === 0 ? 1 : 0
	);
	meshFixture.rig = meshRigSchema.parse({
		bindMatrices: [identity],
		meshMatrix: identity,
		joints: [{ name: "Joint", origin: [0, 0, 0] }],
		influences: meshFixture.vertices.map(() => [0, 0, 0, 0]),
		weights: meshFixture.vertices.map(() => [1, 0, 0, 0]),
		vertices: meshFixture.vertices,
		keyframes: [
			{
				id: crypto.randomUUID(),
				joint: 0,
				property: "rotationZ",
				time: 0,
				value: 0,
			},
			{
				id: crypto.randomUUID(),
				joint: 0,
				property: "rotationZ",
				time: 1,
				value: 90,
			},
		],
	});
	const work = { remainingPixels: 256 };
	expect(
		await renderMeshPngAsync(
			newProject(),
			meshFixture,
			16,
			16,
			0.5,
			undefined,
			work
		)
	).toEqual(renderMeshPng(newProject(), meshFixture, 16, 16, 0.5));
	expect(work.remainingPixels).toBeLessThan(256);
	work.remainingPixels = 1;
	await expect(
		renderMeshPngAsync(newProject(), meshFixture, 16, 16, 0.5, undefined, work)
	).rejects.toThrow("pixel-work budget");
});

test("PNG expansion is bounded by the declared scanline size", () => {
	const meshFixture = mesh();
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 6;
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const image = (decoded: Uint8Array) =>
		`data:image/png;base64,${Buffer.concat([signature, pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(decoded)), pngChunk("IEND", new Uint8Array())]).toString("base64")}`;
	meshFixture.texture = image(new Uint8Array(1024));
	expect(() => renderMeshPng(newProject(), meshFixture, 16, 16)).toThrow();
	meshFixture.texture = image(new Uint8Array([0, 255, 0, 0, 255]));
	expect(
		renderMeshPng(newProject(), meshFixture, 16, 16).byteLength
	).toBeGreaterThan(0);
});

// Exercises the full rasterization budget, which outlasts the 5 s default on a
// loaded CI runner.
test("rasterization rejects the repeated full-frame triangle work within its finite budget", async () => {
	const meshFixture = mesh();
	meshFixture.faces = Array.from({ length: 2000 }, () => [
		0, 1, 2, 1, 2, 1, 2, 1,
	]);
	await expect(
		renderMeshPngAsync(newProject(), meshFixture, 128, 128)
	).rejects.toThrow("pixel-work budget");
}, 30_000);
