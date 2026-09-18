import { describe, expect, test } from "bun:test";
import { renderMeshPng } from "../sidecar/src/mesh-render.ts";
import { meshBounds, parseObj } from "./mesh.ts";
import { meshPoseAtTime, meshVerticesAtTime } from "./mesh-animation.ts";
import { newProject, validateProject } from "./project.ts";

describe("OBJ mesh production", () => {
	test("parses bounded vertices and faces, including negative indices", () => {
		const mesh = parseObj(`
v -1 -1 0
v 1 -1 0
v 1 1 0
v -1 1 0
f -4 -3 -2 -1
`);
		expect(mesh.vertices).toHaveLength(4);
		expect(mesh.faces[0]).toEqual([0, 1, 2, 3]);
		expect(meshBounds(mesh).maxX).toBe(1);
	});

	test("rasterizes a mesh into a transparent PNG for export", () => {
		const project = newProject("Mesh render");
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				scale: 0.3,
				start: 0,
				vertices: [
					[-1, -1, 0],
					[1, -1, 0],
					[0, 1, 0],
				],
				x: 0,
				y: 0,
				z: 0,
			},
		];
		const bytes = renderMeshPng(project, project.meshes[0]!, 64, 64);
		expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(bytes.length).toBeGreaterThan(100);
	});

	test("interpolates bounded mesh motion keyframes", () => {
		const project = newProject("Animated mesh");
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				keyframes: [
					{
						id: crypto.randomUUID(),
						property: "rotationY",
						time: 0,
						value: 0,
					},
					{
						id: crypto.randomUUID(),
						property: "rotationY",
						time: 1,
						value: 90,
					},
				],
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				scale: 0.3,
				start: 0,
				vertices: [
					[-1, -1, 0],
					[1, -1, 0],
					[0, 1, 0],
				],
				x: 0,
				y: 0,
				z: 0,
			},
		];
		expect(meshPoseAtTime(project.meshes[0]!, 0.5).rotationY).toBe(45);
	});

	test("rasterizes an embedded PNG texture through the same mesh path", () => {
		const project = newProject("Textured mesh render");
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				scale: 0.3,
				start: 0,
				texture:
					"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
				uvs: [
					[0, 0],
					[1, 0],
					[0, 1],
				],
				vertices: [
					[-1, -1, 0],
					[1, -1, 0],
					[0, 1, 0],
				],
				x: 0,
				y: 0,
				z: 0,
			},
		];
		const bytes = renderMeshPng(project, project.meshes[0]!, 64, 64);
		expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(bytes.length).toBeGreaterThan(100);
	});

	test("interpolates baked skeletal deformation frames", () => {
		const project = newProject("Skeletal mesh");
		project.meshes = [
			{
				deformationFrames: [
					{
						time: 0,
						vertices: [
							[-1, -1, 0],
							[1, -1, 0],
							[0, 1, 0],
						],
					},
					{
						time: 1,
						vertices: [
							[-1, -1, 0],
							[1, -1, 0],
							[0, 2, 0],
						],
					},
				],
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				scale: 0.3,
				start: 0,
				vertices: [
					[-1, -1, 0],
					[1, -1, 0],
					[0, 1, 0],
				],
				x: 0,
				y: 0,
				z: 0,
			},
		];
		expect(meshVerticesAtTime(project.meshes[0]!, 0.5)[2]?.[1]).toBe(1.5);
	});

	test("interpolates editable rig joint keyframes", () => {
		const project = newProject("Editable rig");
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				rig: {
					bindMatrices: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]],
					influences: [
						[0, 0, 0, 0],
						[0, 0, 0, 0],
						[0, 0, 0, 0],
					],
					joints: [
						{
							name: "Root",
							origin: [0, 0, 0],
							parent: -1,
							rotationX: 0,
							rotationY: 0,
							rotationZ: 0,
							x: 0,
							y: 0,
							z: 0,
						},
					],
					keyframes: [
						{
							id: crypto.randomUUID(),
							joint: 0,
							property: "x",
							time: 0,
							value: 0,
						},
						{
							id: crypto.randomUUID(),
							joint: 0,
							property: "x",
							time: 1,
							value: 1,
						},
					],
					meshMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
					vertices: [
						[0, 0, 0],
						[1, 0, 0],
						[0, 1, 0],
					],
					weights: [
						[1, 0, 0, 0],
						[1, 0, 0, 0],
						[1, 0, 0, 0],
					],
				},
				scale: 1,
				start: 0,
				vertices: [
					[0, 0, 0],
					[1, 0, 0],
					[0, 1, 0],
				],
				x: 0,
				y: 0,
				z: 0,
			},
		];
		expect(meshVerticesAtTime(project.meshes[0]!, 0.5)[0]?.[0]).toBe(0.5);
	});

	test("propagates a parent joint pose to child influences", () => {
		const project = newProject("Hierarchical rig");
		const vertices = [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
		] as [number, number, number][];
		const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rig: {
					bindMatrices: [identity, identity],
					influences: [
						[0, 0, 0, 0],
						[1, 1, 1, 1],
						[0, 0, 0, 0],
					],
					joints: [
						{
							name: "Root",
							origin: [0, 0, 0],
							parent: -1,
							rotationX: 0,
							rotationY: 0,
							rotationZ: 0,
							x: 0,
							y: 0,
							z: 0,
						},
						{
							name: "Child",
							origin: [1, 0, 0],
							parent: 0,
							rotationX: 0,
							rotationY: 0,
							rotationZ: 0,
							x: 0,
							y: 0,
							z: 0,
						},
					],
					keyframes: [
						{
							id: crypto.randomUUID(),
							joint: 0,
							property: "x",
							time: 0,
							value: 0,
						},
						{
							id: crypto.randomUUID(),
							joint: 0,
							property: "x",
							time: 1,
							value: 0.5,
						},
					],
					meshMatrix: identity,
					vertices,
					weights: [
						[1, 0, 0, 0],
						[1, 0, 0, 0],
						[1, 0, 0, 0],
					],
				},
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				scale: 1,
				start: 0,
				vertices,
				x: 0,
				y: 0,
				z: 0,
			},
		];
		expect(meshVerticesAtTime(project.meshes[0]!, 1)[1]?.[0]).toBe(1.5);
	});

	test("clamps keyed joint poses with local translation and rotation limits", () => {
		const project = newProject("Constrained rig");
		const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		const vertices = [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
		] as [number, number, number][];
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				rig: {
					bindMatrices: [identity],
					constraints: [
						{
							axis: "x",
							joint: 0,
							max: 0.25,
							min: -0.25,
							type: "translation-limit",
						},
						{
							axis: "rotationZ",
							joint: 0,
							max: 30,
							min: -30,
							type: "rotation-limit",
						},
					],
					influences: [
						[0, 0, 0, 0],
						[0, 0, 0, 0],
						[0, 0, 0, 0],
					],
					joints: [
						{
							name: "Root",
							origin: [0, 0, 0],
							parent: -1,
							rotationX: 0,
							rotationY: 0,
							rotationZ: 0,
							x: 0,
							y: 0,
							z: 0,
						},
					],
					keyframes: [
						{
							id: crypto.randomUUID(),
							joint: 0,
							property: "x",
							time: 1,
							value: 1,
						},
						{
							id: crypto.randomUUID(),
							joint: 0,
							property: "rotationZ",
							time: 1,
							value: 90,
						},
					],
					meshMatrix: identity,
					vertices,
					weights: [
						[1, 0, 0, 0],
						[1, 0, 0, 0],
						[1, 0, 0, 0],
					],
				},
				scale: 1,
				start: 0,
				vertices,
				x: 0,
				y: 0,
				z: 0,
			},
		];
		const posed = meshVerticesAtTime(project.meshes[0]!, 1);
		expect(posed[0]?.[0]).toBe(0.25);
		expect(posed[1]?.[0]).toBeCloseTo(0.25 + Math.cos(Math.PI / 6), 6);
		expect(posed[1]?.[1]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
	});

	test("rejects inverted or duplicate rig limits", () => {
		const project = newProject("Invalid constrained rig");
		const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		const vertices = [
			[0, 0, 0],
			[1, 0, 0],
			[0, 1, 0],
		] as [number, number, number][];
		project.meshes = [
			{
				end: 2,
				faces: [[0, 1, 2]],
				fill: "#a855f7",
				id: crypto.randomUUID(),
				rotationX: 0,
				rotationY: 0,
				rotationZ: 0,
				rig: {
					bindMatrices: [identity],
					constraints: [
						{
							axis: "x",
							joint: 0,
							max: -1,
							min: 1,
							type: "translation-limit",
						},
						{
							axis: "x",
							joint: 0,
							max: 1,
							min: -1,
							type: "translation-limit",
						},
					],
					influences: [
						[0, 0, 0, 0],
						[0, 0, 0, 0],
						[0, 0, 0, 0],
					],
					joints: [
						{
							name: "Root",
							origin: [0, 0, 0],
							parent: -1,
							rotationX: 0,
							rotationY: 0,
							rotationZ: 0,
							x: 0,
							y: 0,
							z: 0,
						},
					],
					meshMatrix: identity,
					vertices,
					weights: [
						[1, 0, 0, 0],
						[1, 0, 0, 0],
						[1, 0, 0, 0],
					],
				},
				scale: 1,
				start: 0,
				vertices,
				x: 0,
				y: 0,
				z: 0,
			},
		];
		expect(() => validateProject(project, [])).toThrow(
			"Invalid or duplicate mesh rig constraint."
		);
	});
});
