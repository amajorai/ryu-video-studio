import { describe, expect, test } from "bun:test";
import {
	applyBackgroundEdit,
	backgroundEditRequestSchema,
	backgroundForType,
	backgroundImageCandidates,
	backgroundReferencesAsset,
	blurBrightness,
	blurFillCss,
	blurSigma,
	clearAssetBackgrounds,
	clipBackgroundOf,
	cssBackgroundOf,
	describeBackground,
	gradientCoefficients,
	gradientGrid,
	gradientLine,
	gradientPosition,
	hexToRgb,
	loopedMediaTime,
	normalizeHexColor,
	pushPullLevels,
	renderableClipBackground,
	setClipBackground,
	setProjectBackground,
} from "./background.ts";
import { type Asset, newProject, newSegment, type Segment } from "./project.ts";
import { backgroundOf } from "./schema/defaults.ts";

const asset = (kind: Asset["kind"], id: string): Asset => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: kind !== "image",
	height: 360,
	id,
	kind,
	name: `${kind} ${id.slice(-1)}`,
	width: 640,
});
const image = asset("image", "00000000-0000-4000-8000-000000000001");
const video = asset("video", "00000000-0000-4000-8000-000000000002");
const audio = asset("audio", "00000000-0000-4000-8000-000000000003");

describe("gradient line", () => {
	test("CSS angles point up, right, down and left", () => {
		expect(gradientLine(0, 200, 100)).toEqual({
			x0: 100,
			x1: 100,
			y0: 100,
			y1: 0,
		});
		expect(gradientLine(90, 200, 100)).toEqual({
			x0: 0,
			x1: 200,
			y0: 50,
			y1: 50,
		});
		expect(gradientLine(180, 200, 100)).toEqual({
			x0: 100,
			x1: 100,
			y0: 0,
			y1: 100,
		});
		expect(gradientLine(270, 200, 100)).toEqual({
			x0: 200,
			x1: 0,
			y0: 50,
			y1: 50,
		});
		expect(gradientLine(360, 200, 100)).toEqual(gradientLine(0, 200, 100));
	});

	test("diagonal lines put the far corners exactly on the stops", () => {
		for (const angle of [30, 45, 135, 200, 315]) {
			const line = gradientLine(angle, 320, 180);
			const corners = [
				[0, 0],
				[320, 0],
				[0, 180],
				[320, 180],
			].map(([x, y]) => gradientPosition(line, x ?? 0, y ?? 0));
			expect(Math.min(...corners)).toBeCloseTo(0, 6);
			expect(Math.max(...corners)).toBeCloseTo(1, 6);
		}
		const line = gradientLine(45, 320, 180);
		expect(gradientPosition(line, 160, 90)).toBeCloseTo(0.5, 6);
	});

	test("positions clamp outside the line", () => {
		const line = gradientLine(90, 100, 100);
		expect(gradientPosition(line, -50, 50)).toBe(0);
		expect(gradientPosition(line, 150, 50)).toBe(1);
		expect(gradientPosition({ x0: 1, x1: 1, y0: 1, y1: 1 }, 5, 5)).toBe(0);
	});

	test("grid coefficients reproduce the line at grid pixel centers", () => {
		const frame = { height: 180, width: 320 };
		const grid = gradientGrid(frame.width, frame.height);
		expect(grid).toEqual({ height: 36, width: 64 });
		for (const angle of [0, 72, 135, 250]) {
			const { a, b, c } = gradientCoefficients(angle, frame, grid);
			const line = gradientLine(angle, frame.width, frame.height);
			for (const [gx, gy] of [
				[0, 0],
				[63, 35],
				[20, 11],
			]) {
				const x = ((gx ?? 0) + 0.5) * (frame.width / grid.width);
				const y = ((gy ?? 0) + 0.5) * (frame.height / grid.height);
				expect(a * (gx ?? 0) + b * (gy ?? 0) + c).toBeCloseTo(
					gradientPosition(line, x, y),
					5
				);
			}
		}
	});

	test("small or tall frames keep a usable grid", () => {
		expect(gradientGrid(40, 30)).toEqual({ height: 30, width: 40 });
		expect(gradientGrid(128, 3840)).toEqual({ height: 1920, width: 64 });
		expect(gradientGrid(3840, 128)).toEqual({ height: 2, width: 64 });
	});
});

describe("blur fill", () => {
	test("sigma and brightness follow amount and dim", () => {
		expect(blurSigma(0)).toBe(0);
		expect(blurSigma(0.5)).toBe(30);
		expect(blurSigma(1)).toBe(60);
		expect(blurBrightness(0)).toBe(1);
		expect(blurBrightness(0.25)).toBe(0.75);
		expect(blurBrightness(1)).toBe(0);
	});

	test("push-pull levels halve from the working grid to one pixel", () => {
		expect(pushPullLevels(1080, 1920)).toEqual([
			{ height: 171, width: 96 },
			{ height: 86, width: 48 },
			{ height: 43, width: 24 },
			{ height: 22, width: 12 },
			{ height: 11, width: 6 },
			{ height: 6, width: 3 },
			{ height: 3, width: 2 },
			{ height: 2, width: 1 },
			{ height: 1, width: 1 },
		]);
		expect(pushPullLevels(40, 20)).toEqual([
			{ height: 20, width: 40 },
			{ height: 10, width: 20 },
			{ height: 5, width: 10 },
			{ height: 3, width: 5 },
			{ height: 2, width: 3 },
			{ height: 1, width: 2 },
			{ height: 1, width: 1 },
		]);
	});

	test("preview CSS scales the sigma with the preview width", () => {
		expect(blurFillCss({ amount: 0.5, dim: 0.2, type: "blur" }, 1080)).toBe(
			"blur(calc(var(--studio-preview-width) * 0.027778)) brightness(0.8)"
		);
		expect(blurFillCss({ amount: 0, dim: 0, type: "blur" }, 1080)).toBe(
			"brightness(1)"
		);
	});
});

describe("clip backgrounds", () => {
	const project = newProject("Clip fills");
	const base = { ...newSegment(video), track: 0 };
	const upper = { ...newSegment(video), track: 1 };

	test("a project blur fills base-track clips only", () => {
		const blurred = {
			...project,
			background: { amount: 0.3, dim: 0.1, type: "blur" as const },
		};
		expect(clipBackgroundOf(blurred, base)).toEqual(blurred.background);
		expect(clipBackgroundOf(blurred, upper)).toBeUndefined();
		const colored = {
			...project,
			background: { color: "#123456", type: "color" as const },
		};
		expect(clipBackgroundOf(colored, base)).toBeUndefined();
	});

	test("a clip's own background wins, and clip images are drawn", () => {
		const own = {
			...upper,
			background: { color: "#ff0000", type: "color" as const },
		};
		expect(clipBackgroundOf(project, own)).toEqual(own.background);
		const pictured = {
			...base,
			background: { assetId: image.id, type: "image" as const },
		};
		expect(clipBackgroundOf(project, pictured)).toEqual(pictured.background);
		expect(renderableClipBackground(project, pictured)).toEqual(
			pictured.background
		);
	});

	test("waveform (audio) clips get no fill at all", () => {
		const blurred = {
			...project,
			background: { amount: 0.3, dim: 0.1, type: "blur" as const },
		};
		const wave = {
			...newSegment(audio),
			track: 0,
			visualization: "waveform" as const,
		};
		expect(renderableClipBackground(blurred, wave)).toBeUndefined();
		const own = {
			...wave,
			background: { color: "#ff00ff", type: "color" as const },
		};
		expect(renderableClipBackground(project, own)).toBeUndefined();
		// The preview passes the asset kind.
		const plain = { ...newSegment(audio), track: 0 };
		expect(renderableClipBackground(blurred, plain, "audio")).toBeUndefined();
		expect(renderableClipBackground(blurred, base, "video")).toEqual(
			blurred.background
		);
	});

	test("keyed or masked clips skip the project blur but keep their own fill", () => {
		const blurred = {
			...project,
			background: { amount: 0.3, dim: 0.1, type: "blur" as const },
		};
		const masked = { ...base, masks: [{ id: "m1" }] } as unknown as Segment;
		const keyed = { ...base, key: { type: "chroma" } } as unknown as Segment;
		expect(renderableClipBackground(blurred, masked)).toBeUndefined();
		expect(renderableClipBackground(blurred, keyed)).toBeUndefined();
		const own = {
			...keyed,
			background: { color: "#00ff00", type: "color" as const },
		};
		expect(renderableClipBackground(blurred, own)).toEqual(own.background);
	});

	test("a looped canvas video wraps the timeline time", () => {
		expect(loopedMediaTime(7.3, 2)).toBeCloseTo(1.3, 6);
		expect(loopedMediaTime(1.5, 2)).toBe(1.5);
		expect(loopedMediaTime(4, 2)).toBe(0);
		expect(loopedMediaTime(-1, 2)).toBe(0);
		expect(loopedMediaTime(3, 0)).toBe(0);
		expect(loopedMediaTime(Number.NaN, 2)).toBe(0);
	});
});

describe("deleted background media", () => {
	const backdrop = { assetId: image.id, type: "image" as const };
	const clip = newSegment(video);

	test("finds and clears project and clip references", () => {
		const project = {
			...newProject("Deleted"),
			background: backdrop,
			segments: [{ ...clip, background: backdrop }, newSegment(video)],
		};
		expect(backgroundReferencesAsset(project, image.id)).toBe(true);
		expect(backgroundReferencesAsset(project, video.id)).toBe(false);
		const cleared = clearAssetBackgrounds(project, image.id);
		expect("background" in cleared).toBe(false);
		expect(cleared.segments.every((segment) => !segment.background)).toBe(true);
		expect(backgroundReferencesAsset(cleared, image.id)).toBe(false);
	});

	test("unrelated projects come back unchanged", () => {
		const project = {
			...newProject("Kept"),
			background: { color: "#123456", type: "color" as const },
			segments: [clip],
		};
		expect(clearAssetBackgrounds(project, image.id)).toBe(project);
		const clipOnly = {
			...project,
			segments: [{ ...clip, background: backdrop }],
		};
		const cleared = clearAssetBackgrounds(clipOnly, image.id);
		expect(cleared.background).toEqual(project.background);
		expect(cleared.segments[0]?.background).toBeUndefined();
	});
});

describe("presentation helpers", () => {
	test("hex colors parse and invalid ones are refused", () => {
		expect(hexToRgb("#0a80Ff")).toEqual({ b: 255, g: 128, r: 10 });
		expect(() => hexToRgb("red")).toThrow("#rrggbb");
	});

	test("picker values normalize to #rrggbb", () => {
		expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
		expect(normalizeHexColor(" #A1B2C3 ")).toBe("#a1b2c3");
		expect(normalizeHexColor("#a1b2c3ff")).toBe("#a1b2c3");
		expect(normalizeHexColor("rgb(1, 2, 3)")).toBeUndefined();
	});

	test("CSS backgrounds match the gradient semantics", () => {
		expect(cssBackgroundOf({ color: "#112233", type: "color" })).toBe(
			"#112233"
		);
		expect(
			cssBackgroundOf({
				angle: 135,
				color: "#000000",
				color2: "#ffffff",
				type: "gradient",
			})
		).toBe("linear-gradient(135deg, #000000, #ffffff)");
	});

	test("switching type keeps the color and needs media for images", () => {
		const current = { color: "#224466", type: "color" as const };
		const options = { fallbackColor: "#000000" };
		expect(backgroundForType("gradient", current, options)).toEqual({
			angle: 180,
			color: "#224466",
			color2: "#000000",
			type: "gradient",
		});
		expect(backgroundForType("blur", current, options)).toEqual({
			amount: 0.5,
			dim: 0.2,
			type: "blur",
		});
		expect(backgroundForType("image", current, options)).toBeUndefined();
		expect(
			backgroundForType("image", current, {
				...options,
				imageAssetId: image.id,
			})
		).toEqual({ assetId: image.id, type: "image" });
		expect(
			backgroundForType(
				"color",
				{ amount: 1, dim: 0, type: "blur" },
				{ fallbackColor: "#101010" }
			)
		).toEqual({ color: "#101010", type: "color" });
	});

	test("descriptions name the fill", () => {
		expect(describeBackground({ amount: 0.5, dim: 0.25, type: "blur" })).toBe(
			"Blur fill 50%, dimmed 25%"
		);
		expect(
			describeBackground({ assetId: image.id, type: "image" }, [image])
		).toBe(`Image ${image.name}`);
	});

	test("only images and videos can be background media", () => {
		expect(backgroundImageCandidates([image, video, audio])).toEqual([
			image,
			video,
		]);
	});
});

describe("project background edits", () => {
	test("set and clear keep legacy projects byte-identical", () => {
		const project = newProject("Edits");
		const before = JSON.stringify(project);
		const set = setProjectBackground(project, [], {
			color: "#336699",
			type: "color",
		});
		expect(set.background).toEqual({ color: "#336699", type: "color" });
		expect(backgroundOf(set)).toEqual({ color: "#336699", type: "color" });
		const cleared = setProjectBackground(set, [], null);
		expect(JSON.stringify(cleared)).toBe(before);
		expect(backgroundOf(cleared).type).toBe("color");
	});

	test("images must reference visual library media", () => {
		const project = newProject("Images");
		expect(() =>
			setProjectBackground(project, [audio], {
				assetId: audio.id,
				type: "image",
			})
		).toThrow("image or video");
		expect(() =>
			setProjectBackground(project, [], { assetId: image.id, type: "image" })
		).toThrow("image or video");
		expect(
			setProjectBackground(project, [video], {
				assetId: video.id,
				type: "image",
			}).background
		).toEqual({ assetId: video.id, type: "image" });
	});

	test("the request schema is strict and needs a revision", () => {
		expect(
			backgroundEditRequestSchema.safeParse({ background: null, revision: 2 })
				.success
		).toBe(true);
		expect(
			backgroundEditRequestSchema.safeParse({
				background: null,
				clipId: "clip-1",
				revision: 2,
			}).success
		).toBe(true);
		for (const value of [
			{ background: null },
			{ background: null, revision: -1 },
			{ background: null, other: 1, revision: 1 },
			{
				background: {
					angle: 400,
					color: "#000000",
					color2: "#ffffff",
					type: "gradient",
				},
				revision: 1,
			},
			{ background: { amount: 0.5, type: "blur" }, revision: 1 },
			{ background: null, clipId: "", revision: 1 },
		]) {
			expect(backgroundEditRequestSchema.safeParse(value).success).toBe(false);
		}
	});
});

describe("clip background edits", () => {
	const clip = newSegment(video);
	const project = { ...newProject("Clip edits"), segments: [clip] };

	test("set and clear one clip's fill; clearing restores the clip", () => {
		const fill = { color: "#c02090", type: "color" as const };
		const set = setClipBackground(project, clip.id, fill);
		expect(set.segments[0]?.background).toEqual(fill);
		const cleared = applyBackgroundEdit(set, [], {
			background: null,
			clipId: clip.id,
		});
		expect(JSON.stringify(cleared)).toBe(JSON.stringify(project));
	});

	test("unknown clips and clip images without library media are refused", () => {
		expect(() =>
			setClipBackground(project, "missing", {
				color: "#000000",
				type: "color",
			})
		).toThrow("Clip not found");
		expect(() =>
			setClipBackground(project, clip.id, { assetId: image.id, type: "image" })
		).toThrow("Choose an image or video");
		const pictured = setClipBackground(
			project,
			clip.id,
			{ assetId: image.id, type: "image" },
			[image]
		);
		expect(pictured.segments.find((s) => s.id === clip.id)?.background).toEqual(
			{ assetId: image.id, type: "image" }
		);
	});

	test("without a clip id the edit targets the project canvas", () => {
		const fill = { color: "#336699", type: "color" as const };
		const set = applyBackgroundEdit(project, [], { background: fill });
		expect(set.background).toEqual(fill);
		expect(set.segments[0]?.background).toBeUndefined();
	});
});
