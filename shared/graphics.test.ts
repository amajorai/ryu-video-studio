import { describe, expect, test } from "bun:test";
import { buildRender } from "../sidecar/src/render.ts";
import { avatarPoseAtTime } from "./avatar.ts";
import { newProject, type Project } from "./project.ts";

function graphicProject(): Project {
	const project = newProject("Motion card");
	project.graphics = [
		{
			id: crypto.randomUUID(),
			start: 0,
			end: 2,
			x: 0.1,
			y: 0.2,
			width: 0.4,
			height: 0.2,
			fill: "#ff3b30",
			opacity: 0.85,
			animation: "slide-up",
			entryDuration: 0.35,
			shape: "rectangle",
			stroke: "#ffffff",
			strokeWidth: 0,
		},
	];
	return project;
}

describe("motion graphic cards", () => {
	test("validate timing and render a graphics-only project", () => {
		const project = graphicProject();
		expect(project.graphics).toHaveLength(1);
		expect(
			buildRender(project, [], () => "/tmp/missing.mp4").join(" ")
		).toContain("drawbox");
		const invalid = {
			...project,
			graphics: [{ ...project.graphics[0]!, end: 0 }],
		};
		expect(() => buildRender(invalid, [], () => "/tmp/missing.mp4")).toThrow(
			"Invalid graphic timing"
		);
	});

	test("render graph draws animated cards above the timeline", () => {
		const project = graphicProject();
		project.titles = [];
		const render = buildRender(
			{
				...project,
				segments: [],
				titles: [
					{
						id: crypto.randomUUID(),
						start: 0,
						end: 2,
						text: "Base",
						x: 0.5,
						y: 0.5,
						fontSize: 0.08,
						color: "#ffffff",
						fadeIn: 0,
						fadeOut: 0,
						animation: "fade",
					},
				],
			},
			[],
			() => "/tmp/missing.mp4"
		);
		expect(render.join(" ")).toContain("drawbox");
	});

	test("render bounded vector shapes with local fill and stroke", () => {
		const project = graphicProject();
		project.graphics = [
			{
				...project.graphics[0]!,
				shape: "ellipse",
				stroke: "#ffffff",
				strokeWidth: 0.01,
			},
			{
				...project.graphics[0]!,
				id: crypto.randomUUID(),
				shape: "triangle",
				x: 0.55,
				y: 0.4,
			},
			{
				...project.graphics[0]!,
				id: crypto.randomUUID(),
				shape: "line",
				x: 0.1,
				y: 0.7,
				width: 0.8,
				stroke: "#00ff88",
				strokeWidth: 0.012,
			},
		];
		const render = buildRender(project, [], () => "/tmp/missing.mp4").join(" ");
		expect(render).toContain("graphic0ellipse0");
		expect(render).toContain("graphic1triangle15");
		expect(render).toContain("graphic2line");
	});
});

describe("procedural avatars", () => {
	test("render a bounded 2.5D avatar with depth motion", () => {
		const project = newProject("Avatar stage");
		project.avatars = [
			{
				accent: "#f97316",
				animation: "idle",
				depth: 0.6,
				end: 3,
				entryDuration: 0.4,
				height: 0.65,
				id: crypto.randomUUID(),
				outfit: "#4f46e5",
				pose: "wave",
				skin: "#f4c7a1",
				start: 0,
				width: 0.3,
				x: 0.55,
				y: 0.18,
			},
		];
		const render = buildRender(project, [], () => "/tmp/missing.mp4").join(" ");
		expect(render).toContain("avatar0part0");
		expect(render).toContain("sin((t-0)*6.283185)");

		const invalid = {
			...project,
			avatars: [{ ...project.avatars[0]!, end: 0 }],
		};
		expect(() => buildRender(invalid, [], () => "/tmp/missing.mp4")).toThrow(
			"Invalid avatar timing"
		);
	});

	test("rig keyframes interpolate articulated pose values", () => {
		const project = newProject("Rigged avatar");
		const avatar = {
			accent: "#f97316",
			animation: "none" as const,
			depth: 0.4,
			end: 3,
			entryDuration: 0.2,
			height: 0.65,
			id: crypto.randomUUID(),
			outfit: "#4f46e5",
			pose: "neutral" as const,
			rigKeyframes: [
				{
					id: crypto.randomUUID(),
					property: "leftArm" as const,
					time: 0,
					value: -40,
				},
				{
					id: crypto.randomUUID(),
					property: "leftArm" as const,
					time: 1,
					value: 40,
				},
			],
			skin: "#f4c7a1",
			start: 0,
			width: 0.3,
			x: 0.55,
			y: 0.18,
		};
		project.avatars = [avatar];
		expect(avatarPoseAtTime(avatar, 0).leftArm).toBe(-40);
		expect(avatarPoseAtTime(avatar, 0.5).leftArm).toBe(0);
		expect(avatarPoseAtTime(avatar, 1).leftArm).toBe(40);
		const render = buildRender(project, [], () => "/tmp/missing.mp4").join(" ");
		expect(render).toContain("avatar0part");
		expect(render).toContain("if(lt((t-0),1)");
	});
});

describe("3D stage blocks", () => {
	test("render perspective faces with bounded camera motion", () => {
		const project = newProject("3D stage");
		project.stageCamera = {
			x: 0.1,
			y: 0,
			zoom: 1.2,
			orbit: 0.05,
			tilt: 0,
		};
		project.spatialObjects = [
			{
				animation: "orbit-right",
				depth: 0.24,
				end: 3,
				entryDuration: 0.4,
				fill: "#0ea5e9",
				height: 0.24,
				id: crypto.randomUUID(),
				start: 0,
				width: 0.3,
				x: 0.1,
				y: -0.05,
				z: 0.35,
			},
		];
		const render = buildRender(project, [], () => "/tmp/missing.mp4").join(" ");
		expect(render).toContain("stage0part0");
		expect(render).toContain("sin((t-0)*6.283185)");
		expect(render).toContain("0.5+(0.1-0.1");

		const invalid = {
			...project,
			spatialObjects: [{ ...project.spatialObjects[0]!, end: 0 }],
		};
		expect(() => buildRender(invalid, [], () => "/tmp/missing.mp4")).toThrow(
			"Invalid 3D object timing"
		);
	});
});
