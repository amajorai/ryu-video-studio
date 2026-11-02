import { z } from "zod";

const coordinate = z.number().finite().min(-100).max(100);
export const meshVertexSchema = z.tuple([coordinate, coordinate, coordinate]);
export const meshUvSchema = z.tuple([
	z.number().finite().min(-10).max(10),
	z.number().finite().min(-10).max(10),
]);
export const meshFaceSchema = z
	.array(z.number().int().min(0).max(1999))
	.min(3)
	.max(8);

export const objMeshSchema = z
	.object({
		faces: z.array(meshFaceSchema).min(1).max(2000),
		uvs: z.array(meshUvSchema).max(2000).optional(),
		vertices: z.array(meshVertexSchema).min(3).max(2000),
	})
	.strict();
export type ObjMesh = z.infer<typeof objMeshSchema>;

function parseIndex(raw: string, vertexCount: number): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value === 0) {
		throw new Error("OBJ face contains an invalid vertex index.");
	}
	const index = value < 0 ? vertexCount + value : value - 1;
	if (index < 0 || index >= vertexCount) {
		throw new Error("OBJ face references a missing vertex.");
	}
	return index;
}

export function parseObj(text: string): ObjMesh {
	if (text.length > 2_000_000) {
		throw new Error("OBJ files are limited to 2 MB.");
	}
	const vertices: [number, number, number][] = [];
	const faces: number[][] = [];
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const [kind, ...parts] = line.split(/\s+/u);
		if (kind === "v") {
			if (parts.length < 3 || vertices.length >= 2000) {
				throw new Error("OBJ has too many or malformed vertices.");
			}
			const values = parts.slice(0, 3).map(Number);
			if (values.some((value) => !Number.isFinite(value))) {
				throw new Error("OBJ vertex contains a non-finite coordinate.");
			}
			vertices.push([values[0]!, values[1]!, values[2]!]);
		} else if (kind === "f") {
			if (parts.length < 3 || faces.length >= 2000) {
				throw new Error("OBJ has too many or malformed faces.");
			}
			faces.push(
				parts.map((part) =>
					parseIndex(part.split("/")[0] ?? "", vertices.length)
				)
			);
		}
	}
	return objMeshSchema.parse({ faces, vertices });
}

export function meshBounds(mesh: ObjMesh) {
	const values = mesh.vertices;
	return values.reduce(
		(bounds, [x, y, z]) => ({
			maxX: Math.max(bounds.maxX, x),
			maxY: Math.max(bounds.maxY, y),
			maxZ: Math.max(bounds.maxZ, z),
			minX: Math.min(bounds.minX, x),
			minY: Math.min(bounds.minY, y),
			minZ: Math.min(bounds.minZ, z),
		}),
		{
			maxX: Number.NEGATIVE_INFINITY,
			maxY: Number.NEGATIVE_INFINITY,
			maxZ: Number.NEGATIVE_INFINITY,
			minX: Number.POSITIVE_INFINITY,
			minY: Number.POSITIVE_INFINITY,
			minZ: Number.POSITIVE_INFINITY,
		}
	);
}
