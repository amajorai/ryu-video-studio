import { deflateSync, inflateSync } from "node:zlib";
import { meshBounds } from "../../shared/mesh.ts";
import {
	meshPoseAtTime,
	meshVerticesAtTime,
} from "../../shared/mesh-animation.ts";
import type { Mesh, Project } from "../../shared/project.ts";

const clamp = (value: number, min: number, max: number) =>
	Math.max(min, Math.min(max, value));

function color(value: string, factor: number): [number, number, number] {
	const hex = value.replace("#", "");
	return [0, 2, 4].map((offset) =>
		clamp(
			Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * factor),
			0,
			255
		)
	) as [number, number, number];
}

interface DecodedTexture {
	height: number;
	pixels: Uint8Array;
	width: number;
}

function decodeTexture(dataUrl: string): DecodedTexture {
	const comma = dataUrl.indexOf(",");
	if (!dataUrl.startsWith("data:image/png;base64,") || comma < 0) {
		throw new Error("Mesh textures must be embedded PNG data URLs.");
	}
	const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	if (!bytes.subarray(0, 8).equals(signature)) {
		throw new Error("Mesh texture PNG signature is invalid.");
	}
	let width = 0;
	let height = 0;
	let colorType = 0;
	let interlace = 0;
	const idat: Buffer[] = [];
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const size = bytes.readUInt32BE(offset);
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		const body = bytes.subarray(offset + 8, offset + 8 + size);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			if (body[8] !== 8 || ![2, 6].includes(body[9] ?? -1) || body[12] !== 0) {
				throw new Error("Mesh PNG must use 8-bit RGB/RGBA without interlace.");
			}
			colorType = body[9]!;
			interlace = body[12]!;
		} else if (type === "IDAT") {
			idat.push(body);
		} else if (type === "IEND") {
			break;
		}
		offset += size + 12;
	}
	if (!(width && height) || interlace !== 0 || width > 1024 || height > 1024) {
		throw new Error("Mesh texture dimensions exceed the supported bound.");
	}
	const channels = colorType === 6 ? 4 : 3;
	const rowBytes = width * channels;
	const decoded = inflateSync(Buffer.concat(idat));
	if (decoded.length !== (rowBytes + 1) * height) {
		throw new Error("Mesh texture PNG data is truncated.");
	}
	const pixels = new Uint8Array(width * height * 4);
	const rows = new Uint8Array(rowBytes * height);
	const paeth = (a: number, b: number, c: number) => {
		const estimate = a + b - c;
		const pa = Math.abs(estimate - a);
		const pb = Math.abs(estimate - b);
		const pc = Math.abs(estimate - c);
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};
	for (let y = 0; y < height; y++) {
		const filter = decoded[y * (rowBytes + 1)]!;
		const source = decoded.subarray(
			y * (rowBytes + 1) + 1,
			(y + 1) * (rowBytes + 1)
		);
		const rowOffset = y * rowBytes;
		const previousOffset = (y - 1) * rowBytes;
		for (let x = 0; x < rowBytes; x++) {
			const left = x >= channels ? rows[rowOffset + x - channels]! : 0;
			const up = y > 0 ? rows[previousOffset + x]! : 0;
			const upperLeft =
				y > 0 && x >= channels ? rows[previousOffset + x - channels]! : 0;
			const value = source[x]!;
			rows[rowOffset + x] =
				filter === 0
					? value
					: filter === 1
						? (value + left) & 255
						: filter === 2
							? (value + up) & 255
							: filter === 3
								? (value + Math.floor((left + up) / 2)) & 255
								: filter === 4
									? (value + paeth(left, up, upperLeft)) & 255
									: (() => {
											throw new Error(
												"Mesh texture PNG uses an unsupported filter."
											);
										})();
		}
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const source = y * rowBytes + x * channels;
			const target = (y * width + x) * 4;
			pixels[target] = rows[source]!;
			pixels[target + 1] = rows[source + 1]!;
			pixels[target + 2] = rows[source + 2]!;
			pixels[target + 3] = channels === 4 ? rows[source + 3]! : 255;
		}
	}
	return { height, pixels, width };
}

function textureColor(
	texture: DecodedTexture,
	u: number,
	v: number
): [number, number, number] {
	const x = Math.max(
		0,
		Math.min(texture.width - 1, Math.floor(u * texture.width))
	);
	const y = Math.max(
		0,
		Math.min(texture.height - 1, Math.floor((1 - v) * texture.height))
	);
	const offset = (y * texture.width + x) * 4;
	return [
		texture.pixels[offset]!,
		texture.pixels[offset + 1]!,
		texture.pixels[offset + 2]!,
	];
}

function rotate(
	vertex: readonly [number, number, number],
	mesh: Mesh,
	center: { x: number; y: number; z: number },
	span: number,
	pose: ReturnType<typeof meshPoseAtTime>
) {
	let [x, y, z] = vertex.map(
		(value, index) =>
			((value - [center.x, center.y, center.z][index]!) / span) * mesh.scale
	) as [number, number, number];
	for (const [angle, axis] of [
		[pose.rotationX, "x"],
		[pose.rotationY, "y"],
		[pose.rotationZ, "z"],
	] as const) {
		const radians = (angle * Math.PI) / 180;
		const sin = Math.sin(radians);
		const cos = Math.cos(radians);
		if (axis === "x") {
			[y, z] = [y * cos - z * sin, y * sin + z * cos];
		} else if (axis === "y") {
			[x, z] = [x * cos + z * sin, -x * sin + z * cos];
		} else {
			[x, y] = [x * cos - y * sin, x * sin + y * cos];
		}
	}
	return [x, y, z] as const;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xff_ff_ff_ff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xed_b8_83_20 : 0);
		}
	}
	return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type);
	const result = new Uint8Array(12 + data.length);
	const view = new DataView(result.buffer);
	view.setUint32(0, data.length);
	result.set(typeBytes, 4);
	result.set(data, 8);
	view.setUint32(8 + data.length, crc32(result.slice(4, 8 + data.length)));
	return result;
}

function png(width: number, height: number, pixels: Uint8Array): Uint8Array {
	const scanlines = new Uint8Array(height * (width * 4 + 1));
	for (let y = 0; y < height; y++) {
		const source = y * width * 4;
		const target = y * (width * 4 + 1);
		scanlines[target] = 0;
		scanlines.set(pixels.subarray(source, source + width * 4), target + 1);
	}
	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, width);
	headerView.setUint32(4, height);
	header[8] = 8;
	header[9] = 6;
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			Buffer.from(chunk("IHDR", header)),
			Buffer.from(chunk("IDAT", deflateSync(scanlines))),
			Buffer.from(chunk("IEND", new Uint8Array())),
		])
	);
}

function fillTriangle(
	pixels: Uint8Array,
	zBuffer: Float32Array,
	width: number,
	height: number,
	a: readonly [number, number, number, number, number],
	b: readonly [number, number, number, number, number],
	c: readonly [number, number, number, number, number],
	rgb: readonly [number, number, number],
	texture?: DecodedTexture,
	aUv: readonly [number, number] = [0, 0],
	bUv: readonly [number, number] = [0, 0],
	cUv: readonly [number, number] = [0, 0]
) {
	const minX = clamp(Math.floor(Math.min(a[0], b[0], c[0])), 0, width - 1);
	const maxX = clamp(Math.ceil(Math.max(a[0], b[0], c[0])), 0, width - 1);
	const minY = clamp(Math.floor(Math.min(a[1], b[1], c[1])), 0, height - 1);
	const maxY = clamp(Math.ceil(Math.max(a[1], b[1], c[1])), 0, height - 1);
	const denominator =
		(b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
	if (Math.abs(denominator) < 0.0001) {
		return;
	}
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const alpha =
				((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator;
			const beta =
				((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator;
			const gamma = 1 - alpha - beta;
			if (alpha < 0 || beta < 0 || gamma < 0) {
				continue;
			}
			const z = alpha * a[2] + beta * b[2] + gamma * c[2];
			const offset = y * width + x;
			if (z <= zBuffer[offset]!) {
				continue;
			}
			zBuffer[offset] = z;
			const pixel = offset * 4;
			const u = alpha * aUv[0] + beta * bUv[0] + gamma * cUv[0];
			const v = alpha * aUv[1] + beta * bUv[1] + gamma * cUv[1];
			const sampled = texture ? textureColor(texture, u, v) : rgb;
			pixels[pixel] = sampled[0];
			pixels[pixel + 1] = sampled[1];
			pixels[pixel + 2] = sampled[2];
			pixels[pixel + 3] = 255;
		}
	}
}

export function renderMeshPng(
	project: Project,
	mesh: Mesh,
	width: number,
	height: number,
	time = mesh.start
): Uint8Array {
	const pose = meshPoseAtTime(mesh, time);
	const texture = mesh.texture ? decodeTexture(mesh.texture) : undefined;
	const bounds = meshBounds(mesh);
	const center = {
		x: (bounds.minX + bounds.maxX) / 2,
		y: (bounds.minY + bounds.maxY) / 2,
		z: (bounds.minZ + bounds.maxZ) / 2,
	};
	const span = Math.max(
		bounds.maxX - bounds.minX,
		bounds.maxY - bounds.minY,
		bounds.maxZ - bounds.minZ,
		0.001
	);
	const vertices = meshVerticesAtTime(mesh, time).map((vertex) =>
		rotate(vertex, mesh, center, span, pose)
	);
	const pixels = new Uint8Array(width * height * 4);
	const zBuffer = new Float32Array(width * height).fill(
		Number.NEGATIVE_INFINITY
	);
	const faces = [...mesh.faces].sort(
		(a, b) =>
			b.reduce((sum, index) => sum + (vertices[index]?.[2] ?? 0), 0) /
				b.length -
			a.reduce((sum, index) => sum + (vertices[index]?.[2] ?? 0), 0) / a.length
	);
	for (const [faceIndex, face] of faces.entries()) {
		const projected = face.map((index) => {
			const [x, y, z] = vertices[index]!;
			const depth = pose.z + z + project.stageCamera.orbit;
			const worldX = pose.x - project.stageCamera.x + depth * 0.12;
			const worldY =
				pose.y -
				project.stageCamera.y -
				depth * 0.08 +
				project.stageCamera.tilt * depth * 0.08;
			const uv = mesh.uvs?.[index] ?? [0, 0];
			return [
				(0.5 + (worldX + x) * 0.5 * project.stageCamera.zoom) * width,
				(0.5 + (worldY + y) * 0.5 * project.stageCamera.zoom) * height,
				z,
				uv[0],
				uv[1],
			] as const;
		});
		const rgb = color(mesh.fill, 0.78 + (faceIndex % 3) * 0.11);
		for (let index = 1; index < projected.length - 1; index++) {
			fillTriangle(
				pixels,
				zBuffer,
				width,
				height,
				projected[0]!,
				projected[index]!,
				projected[index + 1]!,
				rgb,
				texture,
				projected[0]!.slice(3) as [number, number],
				projected[index]!.slice(3) as [number, number],
				projected[index + 1]!.slice(3) as [number, number]
			);
		}
	}
	return png(width, height, pixels);
}
