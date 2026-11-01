import { describe, expect, test } from "bun:test";
import { type GltfDocument, gltfDocumentSchema, parseGltf } from "./gltf.ts";

function triangleGltf() {
	const bytes = new Uint8Array(106);
	const view = new DataView(bytes.buffer);
	[
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
	].forEach((point, index) => {
		point.forEach((value, axis) =>
			view.setFloat32((index * 3 + axis) * 4, value, true)
		);
	});
	[0, 1, 2].forEach((value, index) =>
		view.setUint16(36 + index * 2, value, true)
	);
	view.setFloat32(42, 0, true);
	view.setFloat32(46, 1, true);
	view.setFloat32(50, 0, true);
	view.setFloat32(54, 0, true);
	view.setFloat32(58, 0, true);
	view.setFloat32(62, 1, true);
	view.setFloat32(66, 0, true);
	view.setFloat32(70, Math.SQRT1_2, true);
	view.setFloat32(74, 0, true);
	view.setFloat32(78, Math.SQRT1_2, true);
	view.setFloat32(82, 0, true);
	view.setFloat32(86, 0, true);
	view.setFloat32(90, 0, true);
	view.setFloat32(94, 0.5, true);
	view.setFloat32(98, 0.2, true);
	view.setFloat32(102, 0, true);
	const base64 = Buffer.from(bytes).toString("base64");
	return new TextEncoder().encode(
		JSON.stringify({
			asset: { version: "2.0" },
			buffers: [
				{
					byteLength: bytes.byteLength,
					uri: `data:application/octet-stream;base64,${base64}`,
				},
			],
			bufferViews: [
				{ buffer: 0, byteLength: 36 },
				{ buffer: 0, byteLength: 6, byteOffset: 36 },
				{ buffer: 0, byteLength: 8, byteOffset: 42 },
				{ buffer: 0, byteLength: 32, byteOffset: 50 },
				{ buffer: 0, byteLength: 24, byteOffset: 82 },
			],
			accessors: [
				{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
				{ bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
				{ bufferView: 2, componentType: 5126, count: 2, type: "SCALAR" },
				{ bufferView: 3, componentType: 5126, count: 2, type: "VEC4" },
				{ bufferView: 4, componentType: 5126, count: 2, type: "VEC3" },
			],
			meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
			nodes: [{ mesh: 0, translation: [1, 2, 0] }],
			scene: 0,
			scenes: [{ nodes: [0] }],
			animations: [
				{
					channels: [
						{ sampler: 0, target: { node: 0, path: "rotation" } },
						{ sampler: 1, target: { node: 0, path: "translation" } },
					],
					samplers: [
						{ input: 2, interpolation: "LINEAR", output: 3 },
						{ input: 2, interpolation: "LINEAR", output: 4 },
					],
				},
			],
		})
	);
}

function skinnedGltf(animated = true) {
	const bytes = new Uint8Array(198);
	const view = new DataView(bytes.buffer);
	[
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
	].forEach((point, index) =>
		point.forEach((value, axis) =>
			view.setFloat32((index * 3 + axis) * 4, value, true)
		)
	);
	for (let index = 0; index < 3; index++) {
		view.setUint8(36 + index * 4, 0);
		view.setFloat32(48 + index * 16, 1, true);
	}
	[0, 1, 2].forEach((value, index) =>
		view.setUint16(96 + index * 2, value, true)
	);
	for (let index = 0; index < 16; index++) {
		view.setFloat32(102 + index * 4, index % 5 === 0 ? 1 : 0, true);
	}
	view.setFloat32(166, 0, true);
	view.setFloat32(170, 1, true);
	view.setFloat32(174, 0, true);
	view.setFloat32(178, 0, true);
	view.setFloat32(182, 0, true);
	view.setFloat32(186, 0, true);
	view.setFloat32(190, 1, true);
	view.setFloat32(194, 0, true);
	const base64 = Buffer.from(bytes).toString("base64");
	const document: GltfDocument = {
		asset: { version: "2.0" },
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
			{ bufferView: 1, componentType: 5121, count: 3, type: "VEC4" },
			{ bufferView: 2, componentType: 5126, count: 3, type: "VEC4" },
			{ bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
			{ bufferView: 4, componentType: 5126, count: 1, type: "MAT4" },
			{ bufferView: 5, componentType: 5126, count: 2, type: "SCALAR" },
			{ bufferView: 6, componentType: 5126, count: 2, type: "VEC3" },
		],
		bufferViews: [
			{ buffer: 0, byteLength: 36, byteOffset: 0 },
			{ buffer: 0, byteLength: 12, byteOffset: 36 },
			{ buffer: 0, byteLength: 48, byteOffset: 48 },
			{ buffer: 0, byteLength: 6, byteOffset: 96 },
			{ buffer: 0, byteLength: 64, byteOffset: 102 },
			{ buffer: 0, byteLength: 8, byteOffset: 166 },
			{ buffer: 0, byteLength: 24, byteOffset: 174 },
		],
		buffers: [
			{
				byteLength: bytes.byteLength,
				uri: `data:application/octet-stream;base64,${base64}`,
			},
		],
		meshes: [
			{
				primitives: [
					{
						attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 },
						indices: 3,
					},
				],
			},
		],
		nodes: [{ mesh: 0, skin: 0 }, {}],
		scene: 0,
		scenes: [{ nodes: [0, 1] }],
		skins: [{ inverseBindMatrices: 4, joints: [1] }],
	};
	if (animated) {
		document.animations = [
			{
				channels: [{ sampler: 0, target: { node: 1, path: "translation" } }],
				samplers: [{ input: 5, interpolation: "LINEAR", output: 6 }],
			},
		];
	}
	return new TextEncoder().encode(JSON.stringify(document));
}

describe("glTF geometry import", () => {
	test("rejects repeated nodes, including cycles and duplicate scene roots, before geometry work", () => {
		for (const nodes of [
			[{ children: [1, 1] }, {}],
			[{ children: [1] }, { children: [0] }],
			[{ children: [2] }, { children: [2] }, {}],
		]) {
			expect(() =>
				parseGltf(
					new TextEncoder().encode(
						JSON.stringify({ asset: { version: "2.0" }, nodes })
					)
				)
			).toThrow();
		}
		expect(() =>
			parseGltf(
				new TextEncoder().encode(
					JSON.stringify({
						asset: { version: "2.0" },
						nodes: [{}],
						scenes: [{ nodes: [0, 0] }],
					})
				)
			)
		).toThrow("distinct root nodes");
	});

	test("rejects oversized animation metadata and repeated targets before reading accessors", () => {
		const channel = { sampler: 0, target: { node: 0, path: "rotation" } };
		for (const channels of [
			Array.from({ length: 193 }, () => channel),
			[channel, channel],
		]) {
			expect(() =>
				parseGltf(
					new TextEncoder().encode(
						JSON.stringify({
							asset: { version: "2.0" },
							nodes: [{}],
							animations: [{ channels }],
						})
					)
				)
			).toThrow();
		}
	});

	test("bounds joints even without inverse bind matrices", () => {
		for (const joints of [
			Array.from({ length: 65 }, () => 0),
			[0, 0],
			[2],
			[-1],
		]) {
			expect(() =>
				parseGltf(
					new TextEncoder().encode(
						JSON.stringify({
							asset: { version: "2.0" },
							nodes: [{}],
							skins: [{ joints }],
						})
					)
				)
			).toThrow("distinct existing joints");
		}
	});
	test("reads bounded embedded geometry and applies node transforms", () => {
		const parsed = parseGltf(triangleGltf());
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.mesh.faces).toEqual([[0, 1, 2]]);
		expect(parsed[0]?.mesh.vertices[0]).toEqual([1, 2, 0]);
		expect(
			parsed[0]?.keyframes?.some(
				(keyframe) => keyframe.property === "rotationY" && keyframe.value > 80
			)
		).toBe(true);
		expect(
			parsed[0]?.keyframes?.some(
				(keyframe) => keyframe.property === "x" && keyframe.value > 0.2
			)
		).toBe(true);
	});

	test("rejects external buffers instead of fetching arbitrary URLs", () => {
		const value = gltfDocumentSchema.parse(
			JSON.parse(new TextDecoder().decode(triangleGltf()))
		);
		value.buffers![0]!.uri = "https://example.com/model.bin";
		expect(() =>
			parseGltf(new TextEncoder().encode(JSON.stringify(value)))
		).toThrow("External glTF buffers are not accepted");
	});

	test("keeps bounded embedded PNG textures and rejects external images", () => {
		const texture =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";
		const value = gltfDocumentSchema.parse(
			JSON.parse(new TextDecoder().decode(triangleGltf()))
		);
		value.images = [{ uri: texture }];
		value.textures = [{ source: 0 }];
		value.materials = [
			{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
		];
		value.meshes![0]!.primitives![0]!.material = 0;
		const parsed = parseGltf(new TextEncoder().encode(JSON.stringify(value)));
		expect(parsed[0]?.texture).toBe(texture);
		value.images = [{ uri: "https://example.com/texture.png" }];
		expect(() =>
			parseGltf(new TextEncoder().encode(JSON.stringify(value)))
		).toThrow("External glTF textures are not accepted");
	});

	test("bakes a bounded linear skin animation into deformation frames", () => {
		const parsed = parseGltf(skinnedGltf());
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.deformationFrames).toHaveLength(2);
		expect(parsed[0]?.deformationFrames?.[1]?.vertices[2]?.[1]).toBe(2);
	});

	test("exposes a static skin as an editable bounded rig", () => {
		const parsed = parseGltf(skinnedGltf(false));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.rig?.joints[0]?.name).toBe("Joint 1");
		expect(parsed[0]?.rig?.influences).toHaveLength(3);
		expect(parsed[0]?.rig?.bindMatrices).toHaveLength(1);
	});
});

test("rejects malformed node coordinates at the glTF JSON boundary", () => {
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			asset: { version: "2.0" },
			nodes: [{ translation: ["invalid", 0, 0] }],
		})
	);
	expect(() => parseGltf(bytes)).toThrow("expected number");
});
