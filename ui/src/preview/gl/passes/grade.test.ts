import { afterEach, describe, expect, test } from "bun:test";
import { identityCubeLut } from "../../../../../shared/cube-lut.ts";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../../shared/project.ts";
import type { ColorGrade } from "../../../../../shared/schema/color.ts";
import { mediaLayerStyle } from "../../preview-style.ts";
import { segmentGlPasses } from "../segment-passes.ts";
import {
	basicColorUniforms,
	CURVE_SAMPLES,
	clearPreviewLuts,
	gradeFragment,
	gradePass,
	gradeUniforms,
	hasGradePass,
	hasPreviewLut,
	hueMaskOf,
	PREVIEW_LUT_SIZE,
	setPreviewLut,
} from "./grade.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 360,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 640,
};
const LUT_ID = "00000000-0000-4000-8000-0000000000aa";

function graded(grade: Partial<ColorGrade>): Segment {
	const segment = newSegment(video);
	return segmentSchema.parse({
		...segment,
		colorGrade: { ...segment.colorGrade, ...grade },
	});
}

afterEach(() => clearPreviewLuts());

describe("grade pass", () => {
	test("no pass for a neutral or basic-only grade", () => {
		expect(gradePass(newSegment(video), 0)).toBeNull();
		expect(gradePass(graded({ exposure: 1, temperature: 0.5 }), 0)).toBeNull();
		expect(segmentGlPasses(newSegment(video), 0)).toEqual([]);
	});

	test("levels, tone and wheels become uniforms with step flags", () => {
		const pass = gradePass(
			graded({
				blacks: 0.4,
				lift: { b: 0.2, g: 0, master: 0, r: 0 },
				shadows: 0.5,
			}),
			0
		);
		expect(pass?.id).toBe("grade");
		expect(pass?.uniforms.u_levels).toEqual([0.1, 1, 0, 1]);
		expect(pass?.uniforms.u_steps).toEqual([1, 1, 1, 0]);
		expect(pass?.uniforms.u_shadows).toEqual([0, 0, 0.1]);
		expect(pass?.uniforms.u_lutIntensity).toBe(0);
	});

	test("curves are packed as sampled vec4 tables", () => {
		const uniforms = gradeUniforms(
			graded({
				curves: {
					master: [
						{ x: 0, y: 1 },
						{ x: 1, y: 0 },
					],
				},
			}),
			false
		);
		expect(uniforms.u_channels).toEqual([1, 0, 0, 0]);
		expect(uniforms["u_master[0]"]).toEqual([1, 0.968_75, 0.9375, 0.906_25]);
		const vectors = Math.ceil(CURVE_SAMPLES / 4);
		expect(uniforms[`u_master[${vectors - 1}]`]).toEqual([0, 0, 0, 0]);
		// Unused curves carry the identity table.
		expect(uniforms["u_red[0]"]).toEqual([0, 0.031_25, 0.0625, 0.093_75]);
	});

	test("HSL filters carry their ranges as a bit mask", () => {
		const uniforms = gradeUniforms(
			graded({
				hsl: [{ band: "orange", hue: 0, lightness: 0, saturation: 0.4 }],
			}),
			false
		);
		expect(uniforms.u_hueCount).toBe(1);
		expect(uniforms["u_hueAdjust[0]"]).toEqual([0, 0.2, 0, 1]);
		expect(uniforms["u_hueMask[0]"]).toBe(3);
		expect(uniforms["u_hueMask[1]"]).toBe(0);
		expect(hueMaskOf(["r", "y", "g", "c", "b", "m"])).toBe(63);
	});

	test("a LUT joins the shader once its table is loaded", () => {
		const segment = graded({ lut: { intensity: 0.5, lutId: LUT_ID } });
		expect(gradePass(segment, 0)).toBeNull();
		setPreviewLut(LUT_ID, identityCubeLut(17));
		expect(hasPreviewLut(LUT_ID)).toBe(true);
		const pass = gradePass(segment, 0);
		expect(pass?.id).toBe(`grade:${LUT_ID}`);
		expect(pass?.uniforms.u_lutIntensity).toBe(0.5);
		expect(pass?.fragment).toContain(
			`const vec3 LUT[${PREVIEW_LUT_SIZE ** 3}]`
		);
		expect(segmentGlPasses(segment, 0).map((item) => item.id)).toEqual([
			`grade:${LUT_ID}`,
		]);
		clearPreviewLuts(LUT_ID);
		expect(hasPreviewLut(LUT_ID)).toBe(false);
	});

	test("an unloaded LUT does not hide the rest of the grade", () => {
		const pass = gradePass(
			graded({ lut: { intensity: 1, lutId: LUT_ID }, whites: 0.2 }),
			0
		);
		expect(pass?.id).toBe("grade");
		expect(pass?.uniforms.u_lutIntensity).toBe(0);
		expect(pass?.fragment).toContain("vec3 lutSample(vec3 c) { return c; }");
	});

	test("the shader declares every uniform the pass sets", () => {
		const fragment = gradeFragment();
		const uniforms = gradeUniforms(graded({ blacks: 0.1 }), false);
		for (const name of Object.keys(uniforms)) {
			const base = name.replace(/\[\d+\]$/, "");
			expect(fragment).toMatch(new RegExp(`uniform \\w+ ${base}[\\[;]`));
		}
	});
});

describe("basic colour inside the grade pass", () => {
	test("the grade pass carries the render's eq and colorbalance values", () => {
		const segment = {
			...graded({
				exposure: 0.3,
				temperature: 0.25,
				tint: -0.1,
				vibrance: 0.4,
			}),
			brightness: 0.1,
			contrast: 1.2,
			saturation: 0.8,
		};
		expect(basicColorUniforms(segment)).toEqual({
			u_basic: [0.2, 1.2, 0.8 * 1.2, 1],
			u_basicBalance: [0.25, -0.1, -0.25],
		});
		const uniforms = gradeUniforms(segment, false);
		expect(uniforms.u_basic).toEqual([0.2, 1.2, 0.8 * 1.2, 1]);
		const fragment = gradeFragment();
		// Basic colour runs before the levels step, as in the render chain.
		expect(fragment.indexOf("u_basic.w > 0.5")).toBeLessThan(
			fragment.indexOf("u_steps.x > 0.5")
		);
	});

	test("the CSS filter drops basic colour only while the grade pass draws it", () => {
		const warm = {
			...graded({ temperature: 0.5 }),
			brightness: 0.2,
		};
		const plain = segmentGlPasses(warm, 0);
		expect(hasGradePass(plain)).toBe(false);
		const cssOnly = mediaLayerStyle(warm, 0, {
			active: true,
			basicColorInGl: hasGradePass(plain),
		})["--studio-media-filter"];
		expect(cssOnly).toContain("brightness(");
		const curved = {
			...warm,
			colorGrade: {
				...warm.colorGrade,
				curves: {
					master: [
						{ x: 0, y: 0.1 },
						{ x: 1, y: 1 },
					],
				},
			},
		};
		const passes = segmentGlPasses(curved, 0);
		expect(hasGradePass(passes)).toBe(true);
		const folded = mediaLayerStyle(curved, 0, {
			active: true,
			basicColorInGl: hasGradePass(passes),
		})["--studio-media-filter"];
		expect(folded).not.toContain("brightness(");
		expect(folded).not.toContain("hue-rotate(");
	});
});
