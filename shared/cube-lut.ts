/**
 * `.cube` 3D LUT parsing, validation, sampling and canonical serialization
 * (W2-V5). The sidecar stores every imported LUT in the canonical form that
 * `serializeCubeLut` writes, so FFmpeg's `lut3d` only ever reads files this
 * module produced. The preview resamples LUTs to a small grid
 * (`resampleCubeLut`) and the CPU reference (`sampleCubeLut`) mirrors the
 * trilinear lookup the WebGL grade pass performs.
 */

/** Largest `.cube` text the parser reads, in bytes (a raw file before canonicalizing). */
export const MAX_CUBE_BYTES = 5 * 1024 * 1024;
/**
 * Largest LUT import request the sidecar accepts, in bytes: its global request
 * body limit. The canonical text of a typical LUT up to `LUT_3D_SIZE` 33 fits
 * comfortably; most 65-point LUTs do not.
 */
export const MAX_LUT_REQUEST_BYTES = 2 * 1024 * 1024;
/** Largest absolute LUT value accepted (well inside Float32 range). */
export const MAX_CUBE_VALUE = 1e6;
/** Smallest and largest accepted `LUT_3D_SIZE`. */
export const MIN_CUBE_SIZE = 2;
export const MAX_CUBE_SIZE = 65;

export type Triple = [number, number, number];

export interface CubeLut {
	/** RGB output triples, red varying fastest, then green, then blue. */
	data: Float32Array;
	domainMax: Triple;
	domainMin: Triple;
	size: number;
	title?: string;
}

/** A `.cube` file this module refuses, with the 1-based line when known. */
export class CubeLutError extends Error {
	readonly line: number | undefined;
	constructor(message: string, line?: number) {
		super(line === undefined ? message : `Line ${line}: ${message}`);
		this.name = "CubeLutError";
		this.line = line;
	}
}

const keywordLine = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/;

function numbers(text: string, count: number, line: number): number[] {
	const parts = text.trim().split(/\s+/);
	if (parts.length !== count) {
		throw new CubeLutError(`Expected ${count} numbers.`, line);
	}
	return parts.map((part) => {
		const value = Number(part);
		if (!(part && Number.isFinite(value))) {
			throw new CubeLutError(`"${part}" is not a finite number.`, line);
		}
		if (Math.abs(value) > MAX_CUBE_VALUE) {
			throw new CubeLutError(
				`"${part}" is outside the supported range of ±${MAX_CUBE_VALUE}.`,
				line
			);
		}
		return value;
	});
}

function triple(text: string, line: number): Triple {
	const [a = 0, b = 0, c = 0] = numbers(text, 3, line);
	return [a, b, c];
}

function stripComment(raw: string): string {
	const hash = raw.indexOf("#");
	return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

interface Header {
	domainMax: Triple;
	domainMin: Triple;
	size: number | undefined;
	title: string | undefined;
}

/** Apply one keyword line to the header; returns false for unknown keywords. */
function applyKeyword(
	header: Header,
	keyword: string,
	rest: string,
	line: number
) {
	switch (keyword) {
		case "TITLE":
			header.title = rest.replace(/^"|"$/g, "").trim().slice(0, 120);
			return;
		case "LUT_1D_SIZE":
			throw new CubeLutError("1D LUTs are not supported; use a 3D LUT.", line);
		case "LUT_3D_SIZE": {
			const [size = 0] = numbers(rest, 1, line);
			if (
				!Number.isInteger(size) ||
				size < MIN_CUBE_SIZE ||
				size > MAX_CUBE_SIZE
			) {
				throw new CubeLutError(
					`LUT_3D_SIZE must be a whole number from ${MIN_CUBE_SIZE} to ${MAX_CUBE_SIZE}.`,
					line
				);
			}
			header.size = size;
			return;
		}
		case "DOMAIN_MIN":
			header.domainMin = triple(rest, line);
			return;
		case "DOMAIN_MAX":
			header.domainMax = triple(rest, line);
			return;
		case "LUT_3D_INPUT_RANGE": {
			const [min = 0, max = 1] = numbers(rest, 2, line);
			header.domainMin = [min, min, min];
			header.domainMax = [max, max, max];
			return;
		}
		default:
			// Vendor keywords (LUT_IN_VIDEO_RANGE, …) do not change the table.
			return;
	}
}

/**
 * Parse and validate a `.cube` 3D LUT. Comments (`#`), `TITLE`,
 * `DOMAIN_MIN`/`DOMAIN_MAX` and `LUT_3D_INPUT_RANGE` are understood; the
 * number of data rows must equal `LUT_3D_SIZE³`.
 */
export function parseCubeLut(text: string): CubeLut {
	if (text.length > MAX_CUBE_BYTES) {
		throw new CubeLutError("The LUT is larger than 5 MB.");
	}
	const header: Header = {
		domainMax: [1, 1, 1],
		domainMin: [0, 0, 0],
		size: undefined,
		title: undefined,
	};
	let data: Float32Array | undefined;
	let rows = 0;
	const lines = text.split(/\r\n|\r|\n/);
	for (const [index, raw] of lines.entries()) {
		const line = index + 1;
		const content = stripComment(raw);
		if (!content) {
			continue;
		}
		const keyword = keywordLine.exec(content);
		if (keyword?.[1]) {
			if (data) {
				throw new CubeLutError("Keywords must come before the table.", line);
			}
			applyKeyword(header, keyword[1], keyword[2] ?? "", line);
			continue;
		}
		if (header.size === undefined) {
			throw new CubeLutError("LUT_3D_SIZE must come before the table.", line);
		}
		const expected = header.size ** 3;
		data ??= new Float32Array(expected * 3);
		if (rows >= expected) {
			throw new CubeLutError(
				`The table has more than the ${expected} rows LUT_3D_SIZE ${header.size} needs.`,
				line
			);
		}
		const [r, g, b] = triple(content, line);
		data[rows * 3] = r;
		data[rows * 3 + 1] = g;
		data[rows * 3 + 2] = b;
		rows += 1;
	}
	if (header.size === undefined) {
		throw new CubeLutError("The file has no LUT_3D_SIZE.");
	}
	const expected = header.size ** 3;
	if (!data || rows !== expected) {
		throw new CubeLutError(
			`The table has ${rows} rows; LUT_3D_SIZE ${header.size} needs ${expected}.`
		);
	}
	for (let channel = 0; channel < 3; channel++) {
		if ((header.domainMax[channel] ?? 1) <= (header.domainMin[channel] ?? 0)) {
			throw new CubeLutError("DOMAIN_MAX must exceed DOMAIN_MIN.");
		}
	}
	return {
		data,
		domainMax: header.domainMax,
		domainMin: header.domainMin,
		size: header.size,
		...(header.title ? { title: header.title } : {}),
	};
}

const formatNumber = (value: number) => Number(value.toFixed(6)).toString();

/** The canonical `.cube` text the sidecar stores and FFmpeg reads. */
export function serializeCubeLut(lut: CubeLut): string {
	const lines: string[] = [];
	if (lut.title) {
		lines.push(`TITLE "${lut.title.replaceAll('"', "'")}"`);
	}
	lines.push(`LUT_3D_SIZE ${lut.size}`);
	lines.push(`DOMAIN_MIN ${lut.domainMin.map(formatNumber).join(" ")}`);
	lines.push(`DOMAIN_MAX ${lut.domainMax.map(formatNumber).join(" ")}`);
	const rows = lut.size ** 3;
	for (let row = 0; row < rows; row++) {
		lines.push(
			`${formatNumber(lut.data[row * 3] ?? 0)} ${formatNumber(lut.data[row * 3 + 1] ?? 0)} ${formatNumber(lut.data[row * 3 + 2] ?? 0)}`
		);
	}
	return `${lines.join("\n")}\n`;
}

/** An identity LUT of `size` points per axis. */
export function identityCubeLut(size: number): CubeLut {
	const data = new Float32Array(size ** 3 * 3);
	let offset = 0;
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				data[offset++] = r / (size - 1);
				data[offset++] = g / (size - 1);
				data[offset++] = b / (size - 1);
			}
		}
	}
	return { data, domainMax: [1, 1, 1], domainMin: [0, 0, 0], size };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Grid coordinate (0..size-1) of an input value on one axis. */
function gridCoordinate(lut: CubeLut, value: number, channel: number): number {
	const min = lut.domainMin[channel] ?? 0;
	const max = lut.domainMax[channel] ?? 1;
	return clamp01((value - min) / (max - min)) * (lut.size - 1);
}

/** Trilinear lookup of one RGB input (the WebGL pass does the same). */
export function sampleCubeLut(
	lut: CubeLut,
	r: number,
	g: number,
	b: number
): Triple {
	const { data, size } = lut;
	const x = gridCoordinate(lut, r, 0);
	const y = gridCoordinate(lut, g, 1);
	const z = gridCoordinate(lut, b, 2);
	const x0 = Math.min(size - 2, Math.floor(x));
	const y0 = Math.min(size - 2, Math.floor(y));
	const z0 = Math.min(size - 2, Math.floor(z));
	const fx = x - x0;
	const fy = y - y0;
	const fz = z - z0;
	const out: Triple = [0, 0, 0];
	for (let corner = 0; corner < 8; corner++) {
		const dx = corner & 1;
		const dy = (corner >> 1) & 1;
		const dz = (corner >> 2) & 1;
		const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
		if (weight === 0) {
			continue;
		}
		const row = x0 + dx + (y0 + dy) * size + (z0 + dz) * size * size;
		out[0] += weight * (data[row * 3] ?? 0);
		out[1] += weight * (data[row * 3 + 1] ?? 0);
		out[2] += weight * (data[row * 3 + 2] ?? 0);
	}
	return out;
}

/**
 * Resample a LUT onto a `size`-point grid over the unit cube (folding its
 * domain in), so the preview can embed a small table.
 */
export function resampleCubeLut(lut: CubeLut, size: number): CubeLut {
	const data = new Float32Array(size ** 3 * 3);
	let offset = 0;
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const [or, og, ob] = sampleCubeLut(
					lut,
					r / (size - 1),
					g / (size - 1),
					b / (size - 1)
				);
				data[offset++] = or;
				data[offset++] = og;
				data[offset++] = ob;
			}
		}
	}
	return { data, domainMax: [1, 1, 1], domainMin: [0, 0, 0], size };
}
