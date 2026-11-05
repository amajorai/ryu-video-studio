import { describe, expect, test } from "bun:test";
import {
	CubeLutError,
	identityCubeLut,
	MAX_CUBE_BYTES,
	parseCubeLut,
	resampleCubeLut,
	sampleCubeLut,
	serializeCubeLut,
} from "./cube-lut.ts";

const invertRows = (size: number) => {
	const rows: string[] = [];
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				rows.push(
					`${1 - r / (size - 1)} ${1 - g / (size - 1)} ${1 - b / (size - 1)}`
				);
			}
		}
	}
	return rows.join("\n");
};

describe("parseCubeLut", () => {
	test("reads comments, title, domain and the table", () => {
		const lut = parseCubeLut(`# a comment line
TITLE "Invert"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
LUT_IN_VIDEO_RANGE

${invertRows(2)}   # trailing comment
`);
		expect(lut.size).toBe(2);
		expect(lut.title).toBe("Invert");
		expect(lut.domainMin).toEqual([0, 0, 0]);
		expect(lut.domainMax).toEqual([1, 1, 1]);
		expect(Array.from(lut.data.slice(0, 6))).toEqual([1, 1, 1, 0, 1, 1]);
	});

	test("accepts CRLF line endings and LUT_3D_INPUT_RANGE", () => {
		const lut = parseCubeLut(
			`LUT_3D_SIZE 2\r\nLUT_3D_INPUT_RANGE 0 2\r\n${invertRows(2).replaceAll("\n", "\r\n")}`
		);
		expect(lut.domainMax).toEqual([2, 2, 2]);
	});

	test("rejects a row count that does not match the size", () => {
		expect(() => parseCubeLut(`LUT_3D_SIZE 3\n${invertRows(2)}`)).toThrow(
			"The table has 8 rows; LUT_3D_SIZE 3 needs 27."
		);
		expect(() =>
			parseCubeLut(`LUT_3D_SIZE 2\n${invertRows(2)}\n0 0 0`)
		).toThrow("more than the 8 rows");
	});

	test("rejects bad sizes, 1D LUTs and malformed rows", () => {
		expect(() => parseCubeLut("LUT_3D_SIZE 66\n")).toThrow(CubeLutError);
		expect(() => parseCubeLut("LUT_3D_SIZE 1\n")).toThrow("from 2 to 65");
		expect(() => parseCubeLut("LUT_3D_SIZE 2.5\n")).toThrow("whole number");
		expect(() => parseCubeLut("LUT_1D_SIZE 1024\n")).toThrow("1D LUTs");
		expect(() => parseCubeLut("0 0 0\n")).toThrow("before the table");
		expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0\n")).toThrow(
			"Line 2: Expected 3 numbers."
		);
		expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 NaN 0\n")).toThrow(
			"not a finite number"
		);
		expect(() => parseCubeLut("LUT_3D_SIZE 2\n1e39 0 0\n")).toThrow(
			"outside the supported range"
		);
		expect(() => parseCubeLut("DOMAIN_MAX 1e7 1 1\n")).toThrow(
			"outside the supported range"
		);
		expect(() => parseCubeLut(`LUT_3D_SIZE 2\n0 0 0\nTITLE "late"\n`)).toThrow(
			"Keywords must come before the table."
		);
		expect(() =>
			parseCubeLut(`LUT_3D_SIZE 2\nDOMAIN_MAX 0 1 1\n${invertRows(2)}`)
		).toThrow("DOMAIN_MAX must exceed DOMAIN_MIN.");
		expect(() => parseCubeLut('TITLE "x"\n')).toThrow("no LUT_3D_SIZE");
		expect(() => parseCubeLut(" ".repeat(MAX_CUBE_BYTES + 1))).toThrow("5 MB");
	});
});

describe("serialization and sampling", () => {
	test("in-range extreme values survive a canonical round trip", () => {
		const rows = Array.from({ length: 8 }, (_, index) =>
			index === 0 ? "1e6 -1e6 0" : "0 0 0"
		).join("\n");
		const lut = parseCubeLut(`LUT_3D_SIZE 2\n${rows}`);
		const text = serializeCubeLut(lut);
		expect(text).not.toContain("Infinity");
		expect(parseCubeLut(text).data[0]).toBe(1e6);
	});

	test("canonical text round-trips", () => {
		const lut = parseCubeLut(`TITLE "Invert"\nLUT_3D_SIZE 2\n${invertRows(2)}`);
		const text = serializeCubeLut(lut);
		expect(
			text.startsWith(
				'TITLE "Invert"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n1 1 1\n'
			)
		).toBe(true);
		expect(serializeCubeLut(parseCubeLut(text))).toBe(text);
	});

	test("identity LUTs sample to their input", () => {
		const lut = identityCubeLut(5);
		for (const rgb of [
			[0, 0, 0],
			[0.2, 0.5, 0.9],
			[1, 1, 1],
			[0.33, 0.66, 0.01],
		] as const) {
			const out = sampleCubeLut(lut, rgb[0], rgb[1], rgb[2]);
			out.forEach((value, index) => {
				expect(value).toBeCloseTo(rgb[index] ?? 0, 6);
			});
		}
	});

	test("trilinear sampling interpolates and honours the domain", () => {
		const invert = parseCubeLut(`LUT_3D_SIZE 2\n${invertRows(2)}`);
		const [r, g, b] = sampleCubeLut(invert, 0.2, 0.5, 0.75);
		expect(r).toBeCloseTo(0.8, 6);
		expect(g).toBeCloseTo(0.5, 6);
		expect(b).toBeCloseTo(0.25, 6);
		const wide = parseCubeLut(
			`LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n${invertRows(2)}`
		);
		expect(sampleCubeLut(wide, 1, 1, 1)[0]).toBeCloseTo(0.5, 6);
		// Out-of-domain inputs clamp to the edge.
		expect(sampleCubeLut(invert, -1, 2, 0)).toEqual([1, 0, 1]);
	});

	test("resampling folds the domain into a unit grid", () => {
		const wide = parseCubeLut(
			`LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n${invertRows(2)}`
		);
		const small = resampleCubeLut(wide, 3);
		expect(small.size).toBe(3);
		expect(small.domainMax).toEqual([1, 1, 1]);
		expect(small.data).toHaveLength(81);
		// Unit-cube input 1 is the middle of the [0, 2] domain.
		expect(sampleCubeLut(small, 1, 1, 1)[0]).toBeCloseTo(0.5, 6);
	});
});
