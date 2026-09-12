import { z } from "zod";
import { meshVertexSchema } from "./mesh.ts";

export const meshKeyframePropertySchema = z.enum([
	"x",
	"y",
	"z",
	"rotationX",
	"rotationY",
	"rotationZ",
]);
export type MeshKeyframeProperty = z.infer<typeof meshKeyframePropertySchema>;

export const meshKeyframeSchema = z
	.object({
		id: z.uuid(),
		property: meshKeyframePropertySchema,
		time: z.number().finite().min(0).max(30),
		value: z.number().finite().min(-180).max(180),
	})
	.strict();
export type MeshKeyframe = z.infer<typeof meshKeyframeSchema>;

export const meshRigJointSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		origin: meshVertexSchema,
		parent: z.number().int().min(-1).max(63).default(-1),
		rotationX: z.number().finite().min(-180).max(180).default(0),
		rotationY: z.number().finite().min(-180).max(180).default(0),
		rotationZ: z.number().finite().min(-180).max(180).default(0),
		x: z.number().finite().min(-2).max(2).default(0),
		y: z.number().finite().min(-2).max(2).default(0),
		z: z.number().finite().min(-2).max(2).default(0),
	})
	.strict();
export type MeshRigJoint = z.infer<typeof meshRigJointSchema>;

export const meshRigKeyframeSchema = z
	.object({
		id: z.uuid(),
		joint: z.number().int().min(0).max(63),
		property: meshKeyframePropertySchema,
		time: z.number().finite().min(0).max(30),
		value: z.number().finite().min(-180).max(180),
	})
	.strict();
export type MeshRigKeyframe = z.infer<typeof meshRigKeyframeSchema>;

export const meshRigConstraintSchema = z.discriminatedUnion("type", [
	z
		.object({
			axis: z.enum(["rotationX", "rotationY", "rotationZ"]),
			joint: z.number().int().min(0).max(63),
			max: z.number().finite().min(-180).max(180),
			min: z.number().finite().min(-180).max(180),
			type: z.literal("rotation-limit"),
		})
		.strict(),
	z
		.object({
			axis: z.enum(["x", "y", "z"]),
			joint: z.number().int().min(0).max(63),
			max: z.number().finite().min(-2).max(2),
			min: z.number().finite().min(-2).max(2),
			type: z.literal("translation-limit"),
		})
		.strict(),
]);
export type MeshRigConstraint = z.infer<typeof meshRigConstraintSchema>;

const meshRigInfluenceSchema = z.tuple([
	z.number().int().min(0).max(63),
	z.number().int().min(0).max(63),
	z.number().int().min(0).max(63),
	z.number().int().min(0).max(63),
]);
const meshRigWeightSchema = z.tuple([
	z.number().finite().min(0).max(1),
	z.number().finite().min(0).max(1),
	z.number().finite().min(0).max(1),
	z.number().finite().min(0).max(1),
]);
export const meshRigSchema = z
	.object({
		bindMatrices: z
			.array(z.array(z.number().finite()).length(16))
			.min(1)
			.max(64),
		constraints: z.array(meshRigConstraintSchema).max(64).optional(),
		influences: z.array(meshRigInfluenceSchema).min(3).max(2000),
		joints: z.array(meshRigJointSchema).min(1).max(64),
		keyframes: z.array(meshRigKeyframeSchema).max(384).optional(),
		meshMatrix: z.array(z.number().finite()).length(16),
		vertices: z.array(meshVertexSchema).min(3).max(2000),
		weights: z.array(meshRigWeightSchema).min(3).max(2000),
	})
	.strict();
export type MeshRig = z.infer<typeof meshRigSchema>;

export const meshDeformationFrameSchema = z
	.object({
		time: z.number().finite().min(0).max(30),
		vertices: z.array(meshVertexSchema).min(3).max(2000),
	})
	.strict();
export type MeshDeformationFrame = z.infer<typeof meshDeformationFrameSchema>;

export interface MeshPose {
	rotationX: number;
	rotationY: number;
	rotationZ: number;
	x: number;
	y: number;
	z: number;
}

interface MeshAnimationSource extends MeshPose {
	keyframes?: MeshKeyframe[];
	start: number;
}

export function meshKeyframeValueBounds(property: MeshKeyframeProperty) {
	return ["x", "y", "z"].includes(property)
		? { max: 1, min: -1 }
		: { max: 180, min: -180 };
}

export function meshRigKeyframeValueBounds(property: MeshKeyframeProperty) {
	return ["x", "y", "z"].includes(property)
		? { max: 2, min: -2 }
		: { max: 180, min: -180 };
}

function valueAt(
	keyframes: MeshKeyframe[],
	property: MeshKeyframeProperty,
	time: number,
	defaultValue: number
): number {
	const points = keyframes
		.filter((keyframe) => keyframe.property === property)
		.sort((a, b) => a.time - b.time);
	if (!points.length) {
		return defaultValue;
	}
	const first = points[0]!;
	const last = points.at(-1)!;
	if (time <= first.time) {
		return first.value;
	}
	if (time >= last.time) {
		return last.value;
	}
	for (let index = 1; index < points.length; index++) {
		const right = points[index]!;
		const left = points[index - 1]!;
		if (time > right.time) {
			continue;
		}
		const span = right.time - left.time;
		const progress = span > 0 ? (time - left.time) / span : 1;
		return left.value + (right.value - left.value) * progress;
	}
	return last.value;
}

export function meshPoseAtTime(
	mesh: MeshAnimationSource,
	time: number
): MeshPose {
	const localTime = Math.max(0, time - mesh.start);
	const keyframes = mesh.keyframes ?? [];
	return {
		rotationX: valueAt(keyframes, "rotationX", localTime, mesh.rotationX),
		rotationY: valueAt(keyframes, "rotationY", localTime, mesh.rotationY),
		rotationZ: valueAt(keyframes, "rotationZ", localTime, mesh.rotationZ),
		x: valueAt(keyframes, "x", localTime, mesh.x),
		y: valueAt(keyframes, "y", localTime, mesh.y),
		z: valueAt(keyframes, "z", localTime, mesh.z),
	};
}

interface MeshDeformationSource {
	deformationFrames?: MeshDeformationFrame[];
	rig?: MeshRig;
	start: number;
	vertices: readonly (readonly [number, number, number])[];
}

function identityMatrix(): number[] {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(a: number[], b: number[]): number[] {
	const result = Array.from({ length: 16 }, () => 0);
	for (let column = 0; column < 4; column++) {
		for (let row = 0; row < 4; row++) {
			result[column * 4 + row] =
				a[row]! * b[column * 4]! +
				a[4 + row]! * b[column * 4 + 1]! +
				a[8 + row]! * b[column * 4 + 2]! +
				a[12 + row]! * b[column * 4 + 3]!;
		}
	}
	return result;
}

function transformPoint(
	matrix: number[],
	point: readonly [number, number, number]
) {
	return [
		matrix[0]! * point[0] +
			matrix[4]! * point[1] +
			matrix[8]! * point[2] +
			matrix[12]!,
		matrix[1]! * point[0] +
			matrix[5]! * point[1] +
			matrix[9]! * point[2] +
			matrix[13]!,
		matrix[2]! * point[0] +
			matrix[6]! * point[1] +
			matrix[10]! * point[2] +
			matrix[14]!,
	] as [number, number, number];
}

function translationMatrix(x: number, y: number, z: number): number[] {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function rotationMatrix(joint: MeshRigJoint): number[] {
	const x = (joint.rotationX * Math.PI) / 180;
	const y = (joint.rotationY * Math.PI) / 180;
	const z = (joint.rotationZ * Math.PI) / 180;
	const sx = Math.sin(x);
	const cx = Math.cos(x);
	const sy = Math.sin(y);
	const cy = Math.cos(y);
	const sz = Math.sin(z);
	const cz = Math.cos(z);
	return [
		cy * cz,
		cy * sz,
		-sy,
		0,
		sx * sy * cz - cx * sz,
		sx * sy * sz + cx * cz,
		sx * cy,
		0,
		cx * sy * cz + sx * sz,
		cx * sy * sz - sx * cz,
		cx * cy,
		0,
		0,
		0,
		0,
		1,
	];
}

function rigJointPoseAtTime(
	joint: MeshRigJoint,
	keyframes: MeshRigKeyframe[],
	jointIndex: number,
	time: number,
	constraints: readonly MeshRigConstraint[]
): MeshRigJoint {
	const pose = { ...joint };
	for (const property of [
		"x",
		"y",
		"z",
		"rotationX",
		"rotationY",
		"rotationZ",
	] as const) {
		const points = keyframes
			.filter(
				(keyframe) =>
					keyframe.joint === jointIndex && keyframe.property === property
			)
			.sort((a, b) => a.time - b.time);
		if (!points.length) {
			continue;
		}
		const first = points[0]!;
		const last = points.at(-1)!;
		let value = last.value;
		if (time <= first.time) {
			value = first.value;
		} else if (time < last.time) {
			for (let index = 1; index < points.length; index++) {
				const right = points[index]!;
				const left = points[index - 1]!;
				if (time <= right.time) {
					const progress =
						right.time > left.time
							? (time - left.time) / (right.time - left.time)
							: 1;
					value = left.value + (right.value - left.value) * progress;
					break;
				}
			}
		}
		pose[property] = value;
	}
	return applyMeshRigConstraints(pose, constraints, jointIndex);
}

/** Apply deterministic local-space limits to an evaluated joint pose. */
export function applyMeshRigConstraints(
	pose: MeshRigJoint,
	constraints: readonly MeshRigConstraint[],
	jointIndex: number
): MeshRigJoint {
	const constrained = { ...pose };
	for (const constraint of constraints) {
		if (constraint.joint !== jointIndex) {
			continue;
		}
		const value = constrained[constraint.axis];
		constrained[constraint.axis] = Math.max(
			constraint.min,
			Math.min(constraint.max, value)
		);
	}
	return constrained;
}

function rigPoseMatrix(joint: MeshRigJoint): number[] {
	return multiplyMatrices(
		translationMatrix(
			joint.origin[0] + joint.x,
			joint.origin[1] + joint.y,
			joint.origin[2] + joint.z
		),
		multiplyMatrices(
			rotationMatrix(joint),
			translationMatrix(-joint.origin[0], -joint.origin[1], -joint.origin[2])
		)
	);
}

function rigVerticesAtTime(
	mesh: MeshDeformationSource,
	time: number
): readonly (readonly [number, number, number])[] {
	const rig = mesh.rig;
	if (!rig) {
		return mesh.vertices;
	}
	const localTime = Math.max(0, time - mesh.start);
	const keyframes = rig.keyframes ?? [];
	const deltas: Array<number[] | undefined> = Array.from({
		length: rig.joints.length,
	});
	const deltaAt = (index: number, stack = new Set<number>()): number[] => {
		const cached = deltas[index];
		if (cached) {
			return cached;
		}
		if (stack.has(index)) {
			throw new Error("Mesh rig joint hierarchy contains a cycle.");
		}
		const nextStack = new Set(stack).add(index);
		const joint = rig.joints[index]!;
		const local = rigPoseMatrix(
			rigJointPoseAtTime(
				joint,
				keyframes,
				index,
				localTime,
				rig.constraints ?? []
			)
		);
		const delta =
			joint.parent >= 0
				? multiplyMatrices(deltaAt(joint.parent, nextStack), local)
				: local;
		deltas[index] = delta;
		return delta;
	};
	const matrices = rig.joints.map((_, index) =>
		multiplyMatrices(
			deltaAt(index),
			rig.bindMatrices[index] ?? identityMatrix()
		)
	);
	return rig.vertices.map((vertex, vertexIndex) => {
		const indices = rig.influences[vertexIndex] ?? [0, 0, 0, 0];
		const weights = rig.weights[vertexIndex] ?? [1, 0, 0, 0];
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		const blended: [number, number, number] = [0, 0, 0];
		for (let influence = 0; influence < 4; influence++) {
			const matrix = matrices[indices[influence] ?? 0] ?? identityMatrix();
			const transformed = transformPoint(matrix, vertex);
			const weight = total > 0 ? (weights[influence] ?? 0) / total : 0;
			blended[0] += transformed[0] * weight;
			blended[1] += transformed[1] * weight;
			blended[2] += transformed[2] * weight;
		}
		return transformPoint(rig.meshMatrix, blended);
	});
}

export function meshVerticesAtTime(
	mesh: MeshDeformationSource,
	time: number
): readonly (readonly [number, number, number])[] {
	if (mesh.rig) {
		return rigVerticesAtTime(mesh, time);
	}
	const frames = mesh.deformationFrames;
	if (!frames?.length) {
		return mesh.vertices;
	}
	const localTime = Math.max(0, time - mesh.start);
	const ordered = [...frames].sort((a, b) => a.time - b.time);
	const first = ordered[0]!;
	if (localTime <= first.time) {
		return first.vertices;
	}
	for (let index = 1; index < ordered.length; index++) {
		const next = ordered[index]!;
		const previous = ordered[index - 1]!;
		if (localTime <= next.time) {
			const span = Math.max(0.0001, next.time - previous.time);
			const progress = Math.max(
				0,
				Math.min(1, (localTime - previous.time) / span)
			);
			return previous.vertices.map((vertex, vertexIndex) => {
				const target = next.vertices[vertexIndex] ?? vertex;
				return [
					vertex[0] + (target[0] - vertex[0]) * progress,
					vertex[1] + (target[1] - vertex[1]) * progress,
					vertex[2] + (target[2] - vertex[2]) * progress,
				] as const;
			});
		}
	}
	return ordered.at(-1)!.vertices;
}
