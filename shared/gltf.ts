import { type ObjMesh, objMeshSchema } from "./mesh.ts";
import {
	type MeshDeformationFrame,
	type MeshKeyframe,
	type MeshRig,
	meshKeyframeSchema,
	meshRigSchema,
} from "./mesh-animation.ts";

const maxGltfBytes = 4 * 1024 * 1024;
const maxBuffers = 8;
const maxNodes = 64;

interface GltfBuffer {
	byteLength?: number;
	uri?: string;
}
interface GltfBufferView {
	buffer?: number;
	byteLength?: number;
	byteOffset?: number;
	byteStride?: number;
}
interface GltfAccessor {
	bufferView?: number;
	byteOffset?: number;
	componentType?: number;
	count?: number;
	type?: string;
}
interface GltfPrimitive {
	attributes?: {
		JOINTS_0?: number;
		POSITION?: number;
		TEXCOORD_0?: number;
		WEIGHTS_0?: number;
	};
	indices?: number;
	material?: number;
	mode?: number;
}
interface GltfMesh {
	name?: string;
	primitives?: GltfPrimitive[];
}
interface GltfNode {
	children?: number[];
	matrix?: number[];
	mesh?: number;
	name?: string;
	rotation?: number[];
	scale?: number[];
	skin?: number;
	translation?: number[];
}
interface GltfMaterial {
	pbrMetallicRoughness?: {
		baseColorFactor?: number[];
		baseColorTexture?: { index?: number };
	};
}
interface GltfImage {
	bufferView?: number;
	mimeType?: string;
	uri?: string;
}
interface GltfTexture {
	source?: number;
}
interface GltfSkin {
	inverseBindMatrices?: number;
	joints?: number[];
}
interface GltfDocument {
	accessors?: GltfAccessor[];
	animations?: GltfAnimation[];
	asset?: { version?: string };
	buffers?: GltfBuffer[];
	bufferViews?: GltfBufferView[];
	images?: GltfImage[];
	materials?: GltfMaterial[];
	meshes?: GltfMesh[];
	nodes?: GltfNode[];
	scene?: number;
	scenes?: Array<{ nodes?: number[] }>;
	skins?: GltfSkin[];
	textures?: GltfTexture[];
}
interface GltfAnimation {
	channels?: GltfAnimationChannel[];
	samplers?: GltfAnimationSampler[];
}
interface GltfAnimationChannel {
	sampler?: number;
	target?: { node?: number; path?: string };
}
interface GltfAnimationSampler {
	input?: number;
	interpolation?: string;
	output?: number;
}

export interface ParsedGltfMesh {
	deformationFrames?: MeshDeformationFrame[];
	fill: string;
	keyframes?: MeshKeyframe[];
	mesh: ObjMesh;
	name: string;
	rig?: MeshRig;
	texture?: string;
}

function quaternionToEuler(quaternion: number[]): [number, number, number] {
	const [x, y, z, w] = quaternion;
	const sinX = 2 * (w! * x! + y! * z!);
	const cosX = 1 - 2 * (x! * x! + y! * y!);
	const pitch = Math.atan2(sinX, cosX);
	const sinY = 2 * (w! * y! - z! * x!);
	const yaw =
		Math.abs(sinY) >= 1 ? (Math.sign(sinY) * Math.PI) / 2 : Math.asin(sinY);
	const sinZ = 2 * (w! * z! + x! * y!);
	const cosZ = 1 - 2 * (y! * y! + z! * z!);
	const roll = Math.atan2(sinZ, cosZ);
	return [
		(pitch * 180) / Math.PI,
		(yaw * 180) / Math.PI,
		(roll * 180) / Math.PI,
	];
}

function animationKeyframes(
	document: GltfDocument,
	buffers: Uint8Array[],
	nodeIndex: number
): MeshKeyframe[] {
	const animation = document.animations?.[0];
	if (!animation) {
		return [];
	}
	const keyframes: MeshKeyframe[] = [];
	for (const channel of animation.channels ?? []) {
		if (
			channel.target?.node !== nodeIndex ||
			!["rotation", "translation"].includes(channel.target.path ?? "")
		) {
			continue;
		}
		const sampler = animation?.samplers?.[channel.sampler ?? -1];
		if (!sampler || sampler.interpolation === "CUBICSPLINE") {
			continue;
		}
		const times = readAccessor(
			document,
			buffers,
			sampler.input ?? -1,
			"SCALAR",
			120
		).flat();
		const values = readAccessor(
			document,
			buffers,
			sampler.output ?? -1,
			channel.target.path === "rotation" ? "VEC4" : "VEC3",
			120
		);
		const initialTranslation = values[0] ?? [0, 0, 0];
		for (
			let index = 0;
			index < Math.min(times.length, values.length);
			index++
		) {
			const time = Number(times[index]);
			const properties =
				channel.target.path === "rotation"
					? (() => {
							const [rotationX, rotationY, rotationZ] = quaternionToEuler(
								values[index]!
							);
							return [
								["rotationX", rotationX],
								["rotationY", rotationY],
								["rotationZ", rotationZ],
							] as const;
						})()
					: ([
							["x", (values[index]![0]! - initialTranslation[0]!) * 0.5],
							["y", (values[index]![1]! - initialTranslation[1]!) * 0.5],
							["z", (values[index]![2]! - initialTranslation[2]!) * 0.5],
						] as const);
			for (const [property, value] of properties) {
				keyframes.push(
					meshKeyframeSchema.parse({
						id: crypto.randomUUID(),
						property,
						time,
						value: Math.max(-180, Math.min(180, value)),
					})
				);
			}
		}
	}
	return keyframes;
}

function readJson(bytes: Uint8Array): GltfDocument {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!value || typeof value !== "object") {
			throw new Error("glTF JSON must be an object.");
		}
		return value as GltfDocument;
	} catch (error) {
		throw new Error(
			`glTF JSON could not be parsed: ${error instanceof Error ? error.message : "invalid JSON"}`
		);
	}
}

function decodeBase64(value: string): Uint8Array {
	try {
		const binary = atob(value);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new Error("glTF buffer contains invalid base64 data.");
	}
}

function loadBuffers(
	document: GltfDocument,
	binChunk: Uint8Array | undefined
): Uint8Array[] {
	const declarations = document.buffers ?? [];
	if (declarations.length > maxBuffers) {
		throw new Error("glTF contains too many buffers.");
	}
	return declarations.map((buffer, index) => {
		let bytes: Uint8Array;
		if (buffer.uri?.startsWith("data:")) {
			const comma = buffer.uri.indexOf(",");
			if (comma < 0 || !buffer.uri.slice(0, comma).includes(";base64")) {
				throw new Error("glTF buffers must use base64 data URIs.");
			}
			bytes = decodeBase64(buffer.uri.slice(comma + 1));
		} else if (!buffer.uri && index === 0 && binChunk) {
			bytes = binChunk;
		} else {
			throw new Error("External glTF buffers are not accepted.");
		}
		if (
			buffer.byteLength !== undefined &&
			bytes.byteLength < buffer.byteLength
		) {
			throw new Error("glTF buffer is shorter than its declared length.");
		}
		return bytes;
	});
}

function componentReader(
	view: DataView,
	componentType: number,
	offset: number
): number {
	switch (componentType) {
		case 5121:
			return view.getUint8(offset);
		case 5123:
			return view.getUint16(offset, true);
		case 5125:
			return view.getUint32(offset, true);
		case 5126:
			return view.getFloat32(offset, true);
		default:
			throw new Error("glTF uses an unsupported accessor component type.");
	}
}

function componentBytes(componentType: number): number {
	if (componentType === 5121) {
		return 1;
	}
	if (componentType === 5123) {
		return 2;
	}
	if (componentType === 5125 || componentType === 5126) {
		return 4;
	}
	throw new Error("glTF uses an unsupported accessor component type.");
}

function componentCount(type: string | undefined): number {
	switch (type) {
		case "SCALAR":
			return 1;
		case "VEC2":
			return 2;
		case "VEC3":
			return 3;
		case "VEC4":
			return 4;
		case "MAT4":
			return 16;
		default:
			throw new Error("glTF accessor type is unsupported.");
	}
}

function readAccessor(
	document: GltfDocument,
	buffers: Uint8Array[],
	accessorIndex: number,
	expectedType: string,
	maxCount = 2000
): number[][] {
	const accessor = document.accessors?.[accessorIndex];
	const viewIndex = accessor?.bufferView;
	const bufferView =
		viewIndex === undefined ? undefined : document.bufferViews?.[viewIndex];
	if (!accessor || viewIndex === undefined || !bufferView) {
		throw new Error("glTF accessor is missing its buffer view.");
	}
	if (accessor.type !== expectedType) {
		throw new Error(`glTF accessor must use ${expectedType}.`);
	}
	const count = accessor.count ?? 0;
	if (!Number.isInteger(count) || count < 1 || count > maxCount) {
		throw new Error("glTF accessor count is outside the supported bounds.");
	}
	const components = componentCount(accessor.type);
	const bytes = componentBytes(accessor.componentType ?? 0);
	const stride = bufferView.byteStride ?? bytes * components;
	if (stride < bytes * components || stride > 256) {
		throw new Error("glTF accessor stride is invalid.");
	}
	const buffer = buffers[bufferView.buffer ?? -1];
	if (!buffer) {
		throw new Error("glTF accessor references a missing buffer.");
	}
	const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
	const end = start + (count - 1) * stride + bytes * components;
	if (start < 0 || end > buffer.byteLength) {
		throw new Error("glTF accessor points outside its buffer.");
	}
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength
	);
	return Array.from({ length: count }, (_, row) =>
		Array.from({ length: components }, (_, column) =>
			componentReader(
				view,
				accessor.componentType ?? 0,
				start + row * stride + column * bytes
			)
		)
	);
}

function identity(): number[] {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a: number[], b: number[]): number[] {
	const out = Array.from({ length: 16 }, () => 0);
	for (let column = 0; column < 4; column++) {
		for (let row = 0; row < 4; row++) {
			out[column * 4 + row] =
				a[row]! * b[column * 4]! +
				a[4 + row]! * b[column * 4 + 1]! +
				a[8 + row]! * b[column * 4 + 2]! +
				a[12 + row]! * b[column * 4 + 3]!;
		}
	}
	return out;
}

function inverseMatrix(matrix: number[]): number[] {
	const rows = Array.from({ length: 4 }, (_, row) => [
		matrix[row] ?? 0,
		matrix[4 + row] ?? 0,
		matrix[8 + row] ?? 0,
		matrix[12 + row] ?? 0,
		row === 0 ? 1 : 0,
		row === 1 ? 1 : 0,
		row === 2 ? 1 : 0,
		row === 3 ? 1 : 0,
	]);
	for (let column = 0; column < 4; column++) {
		let pivot = column;
		for (let row = column + 1; row < 4; row++) {
			if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) {
				pivot = row;
			}
		}
		if (Math.abs(rows[pivot]![column]!) < 0.000_001) {
			throw new Error("glTF node transform is not invertible.");
		}
		[rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
		const divisor = rows[column]![column]!;
		for (let index = 0; index < 8; index++) {
			rows[column]![index] = rows[column]![index]! / divisor;
		}
		for (let row = 0; row < 4; row++) {
			if (row === column) {
				continue;
			}
			const factor = rows[row]![column]!;
			for (let index = 0; index < 8; index++) {
				rows[row]![index] = rows[row]![index]! - factor * rows[column]![index]!;
			}
		}
	}
	return Array.from(
		{ length: 16 },
		(_, index) => rows[index % 4]![4 + Math.floor(index / 4)]!
	);
}

function nodeMatrix(node: GltfNode): number[] {
	if (node.matrix?.length === 16) {
		return node.matrix.map(Number);
	}
	const [x, y, z, w] = (
		node.rotation?.length === 4 ? node.rotation : [0, 0, 0, 1]
	) as number[];
	const [sx, sy, sz] = (
		node.scale?.length === 3 ? node.scale : [1, 1, 1]
	) as number[];
	const [tx, ty, tz] = (
		node.translation?.length === 3 ? node.translation : [0, 0, 0]
	) as number[];
	return [
		(1 - 2 * (y! * y! + z! * z!)) * sx!,
		2 * (x! * y! + z! * w!) * sx!,
		2 * (x! * z! - y! * w!) * sx!,
		0,
		2 * (x! * y! - z! * w!) * sy!,
		(1 - 2 * (x! * x! + z! * z!)) * sy!,
		2 * (y! * z! + x! * w!) * sy!,
		0,
		2 * (x! * z! + y! * w!) * sz!,
		2 * (y! * z! - x! * w!) * sz!,
		(1 - 2 * (x! * x! + y! * y!)) * sz!,
		0,
		tx!,
		ty!,
		tz!,
		1,
	];
}

function transform(
	matrix: number[],
	point: number[]
): [number, number, number] {
	const [x, y, z] = point;
	return [
		matrix[0]! * x! + matrix[4]! * y! + matrix[8]! * z! + matrix[12]!,
		matrix[1]! * x! + matrix[5]! * y! + matrix[9]! * z! + matrix[13]!,
		matrix[2]! * x! + matrix[6]! * y! + matrix[10]! * z! + matrix[14]!,
	];
}

function matrixAtTime(
	document: GltfDocument,
	buffers: Uint8Array[],
	nodeIndex: number,
	time: number
): number[] {
	const node = document.nodes?.[nodeIndex];
	if (!node) {
		return identity();
	}
	const animated = {
		...node,
		rotation: node.rotation?.slice() ?? [0, 0, 0, 1],
		scale: node.scale?.slice() ?? [1, 1, 1],
		translation: node.translation?.slice() ?? [0, 0, 0],
	};
	const animation = document.animations?.[0];
	for (const channel of animation?.channels ?? []) {
		if (channel.target?.node !== nodeIndex) {
			continue;
		}
		const sampler = animation?.samplers?.[channel.sampler ?? -1];
		if (!sampler || sampler.interpolation === "CUBICSPLINE") {
			continue;
		}
		const times = readAccessor(
			document,
			buffers,
			sampler.input ?? -1,
			"SCALAR",
			120
		).flat();
		const type = channel.target?.path === "rotation" ? "VEC4" : "VEC3";
		const values = readAccessor(
			document,
			buffers,
			sampler.output ?? -1,
			type,
			120
		);
		const index = times.findIndex((value, item) => value >= time && item > 0);
		const nextIndex = index < 0 ? times.length - 1 : index;
		const previousIndex = Math.max(0, nextIndex - 1);
		const start = times[previousIndex] ?? 0;
		const end = times[nextIndex] ?? start;
		const progress =
			end > start
				? Math.max(0, Math.min(1, (time - start) / (end - start)))
				: 0;
		const a = values[previousIndex] ?? [];
		const b = values[nextIndex] ?? a;
		const value = a.map(
			(entry, component) => entry + ((b[component] ?? entry) - entry) * progress
		);
		if (channel.target?.path === "rotation") {
			const length = Math.hypot(...value);
			animated.rotation =
				length > 0 ? value.map((entry) => entry / length) : [0, 0, 0, 1];
		} else if (channel.target?.path === "translation") {
			animated.translation = value;
		} else if (channel.target?.path === "scale") {
			animated.scale = value;
		}
	}
	return nodeMatrix(animated);
}

function parentNodes(document: GltfDocument): Map<number, number> {
	const parents = new Map<number, number>();
	for (const [index, node] of (document.nodes ?? []).entries()) {
		for (const child of node.children ?? []) {
			parents.set(child, index);
		}
	}
	return parents;
}

function globalMatrixAtTime(
	document: GltfDocument,
	buffers: Uint8Array[],
	nodeIndex: number,
	time: number,
	parents: Map<number, number>,
	seen = new Set<number>()
): number[] {
	if (seen.has(nodeIndex)) {
		throw new Error("glTF node hierarchy contains a cycle.");
	}
	seen.add(nodeIndex);
	const parent = parents.get(nodeIndex);
	const local = matrixAtTime(document, buffers, nodeIndex, time);
	return parent === undefined
		? local
		: multiply(
				globalMatrixAtTime(document, buffers, parent, time, parents, seen),
				local
			);
}

function animationTimes(
	document: GltfDocument,
	buffers: Uint8Array[],
	joints: number[]
): number[] {
	const values = new Set<number>([0]);
	for (const channel of document.animations?.[0]?.channels ?? []) {
		if (!joints.includes(channel.target?.node ?? -1)) {
			continue;
		}
		const sampler = document.animations?.[0]?.samplers?.[channel.sampler ?? -1];
		if (!sampler) {
			continue;
		}
		for (const time of readAccessor(
			document,
			buffers,
			sampler.input ?? -1,
			"SCALAR",
			120
		).flat()) {
			if (Number.isFinite(time)) {
				values.add(Math.max(0, Math.min(30, time)));
			}
		}
	}
	return [...values].sort((a, b) => a - b).slice(0, 30);
}

function skeletalFrames(
	document: GltfDocument,
	buffers: Uint8Array[],
	nodeIndex: number,
	skinIndex: number,
	positions: number[][],
	joints: number[][],
	weights: number[][]
): Array<{ time: number; vertices: [number, number, number][] }> | undefined {
	const skin = document.skins?.[skinIndex];
	const jointNodes = skin?.joints ?? [];
	if (!(skin && jointNodes.length)) {
		return undefined;
	}
	const inverse =
		skin.inverseBindMatrices === undefined
			? jointNodes.map(() => identity())
			: readAccessor(
					document,
					buffers,
					skin.inverseBindMatrices,
					"MAT4",
					64
				).map((value) => value);
	if (inverse.length !== jointNodes.length) {
		throw new Error("glTF inverse bind matrices must match skin joints.");
	}
	if (
		joints.length !== positions.length ||
		weights.length !== positions.length
	) {
		throw new Error("glTF skin attributes must match POSITION vertices.");
	}
	const parents = parentNodes(document);
	const times = animationTimes(document, buffers, jointNodes);
	return times.map((time) => {
		const meshMatrix = globalMatrixAtTime(
			document,
			buffers,
			nodeIndex,
			time,
			parents
		);
		const meshInverse = inverseMatrix(meshMatrix);
		const matrices = jointNodes.map((joint, index) =>
			multiply(
				meshInverse,
				multiply(
					globalMatrixAtTime(document, buffers, joint, time, parents),
					inverse[index]!
				)
			)
		);
		const vertices = positions.map((position, vertexIndex) => {
			const jointIndices = joints[vertexIndex] ?? [0, 0, 0, 0];
			const jointWeights = weights[vertexIndex] ?? [1, 0, 0, 0];
			const totalWeight = jointWeights.reduce(
				(sum, weight) => sum + Math.max(0, weight),
				0
			);
			if (!(totalWeight > 0)) {
				throw new Error("glTF skin weights must include a positive influence.");
			}
			const blended: [number, number, number] = [0, 0, 0];
			for (let influence = 0; influence < 4; influence++) {
				const jointIndex = jointIndices[influence] ?? -1;
				if (
					!Number.isInteger(jointIndex) ||
					jointIndex < 0 ||
					jointIndex >= matrices.length
				) {
					throw new Error("glTF skin joint index is outside the skin.");
				}
				const weight = Math.max(0, jointWeights[influence] ?? 0) / totalWeight;
				const matrix = matrices[jointIndex]!;
				const transformed = transform(matrix, position);
				blended[0] += transformed[0] * weight;
				blended[1] += transformed[1] * weight;
				blended[2] += transformed[2] * weight;
			}
			return transform(meshMatrix, blended) as [number, number, number];
		});
		return { time, vertices };
	});
}

function hasJointAnimation(
	document: GltfDocument,
	jointNodes: number[]
): boolean {
	return (document.animations?.[0]?.channels ?? []).some((channel) =>
		jointNodes.includes(channel.target?.node ?? -1)
	);
}

function skeletalRig(
	document: GltfDocument,
	buffers: Uint8Array[],
	nodeIndex: number,
	skinIndex: number,
	positions: number[][],
	joints: number[][],
	weights: number[][]
): MeshRig | undefined {
	const skin = document.skins?.[skinIndex];
	const jointNodes = skin?.joints ?? [];
	if (!(skin && jointNodes.length) || hasJointAnimation(document, jointNodes)) {
		return undefined;
	}
	const inverse =
		skin.inverseBindMatrices === undefined
			? jointNodes.map(() => identity())
			: readAccessor(
					document,
					buffers,
					skin.inverseBindMatrices,
					"MAT4",
					64
				).map((value) => value);
	if (inverse.length !== jointNodes.length) {
		throw new Error("glTF inverse bind matrices must match skin joints.");
	}
	const parents = parentNodes(document);
	const jointIndexes = new Map(
		jointNodes.map((joint, index) => [joint, index] as const)
	);
	const meshMatrix = globalMatrixAtTime(
		document,
		buffers,
		nodeIndex,
		0,
		parents
	);
	const meshInverse = inverseMatrix(meshMatrix);
	const bindMatrices = jointNodes.map((joint, index) =>
		multiply(
			meshInverse,
			multiply(
				globalMatrixAtTime(document, buffers, joint, 0, parents),
				inverse[index]!
			)
		)
	);
	const rig = {
		bindMatrices,
		influences: joints,
		joints: jointNodes.map((joint, index) => {
			const matrix = globalMatrixAtTime(document, buffers, joint, 0, parents);
			const origin = transform(meshInverse, [
				matrix[12]!,
				matrix[13]!,
				matrix[14]!,
			]);
			return {
				name: document.nodes?.[joint]?.name ?? `Joint ${index + 1}`,
				origin,
				parent: jointIndexes.get(parents.get(joint) ?? -1) ?? -1,
			};
		}),
		meshMatrix,
		vertices: positions,
		weights,
	};
	return meshRigSchema.parse(rig);
}

function materialColor(
	document: GltfDocument,
	index: number | undefined
): string {
	const factor =
		document.materials?.[index ?? -1]?.pbrMetallicRoughness?.baseColorFactor;
	if (!factor || factor.length < 3) {
		return "#a855f7";
	}
	return `#${factor
		.slice(0, 3)
		.map((channel) =>
			Math.max(0, Math.min(255, Math.round(Number(channel) * 255)))
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function embeddedTexture(
	document: GltfDocument,
	buffers: Uint8Array[],
	materialIndex: number | undefined
): string | undefined {
	const textureIndex =
		document.materials?.[materialIndex ?? -1]?.pbrMetallicRoughness
			?.baseColorTexture?.index;
	const imageIndex = document.textures?.[textureIndex ?? -1]?.source;
	const image = document.images?.[imageIndex ?? -1];
	if (!image) {
		return undefined;
	}
	if (image.uri?.startsWith("data:")) {
		if (!image.uri.startsWith("data:image/png;base64,")) {
			throw new Error("glTF textures must use embedded PNG data URIs.");
		}
		if (image.uri.length > 1_900_000) {
			throw new Error("glTF texture exceeds the supported 1.5 MB bound.");
		}
		return image.uri;
	}
	if (image.uri) {
		throw new Error("External glTF textures are not accepted.");
	}
	const view = document.bufferViews?.[image.bufferView ?? -1];
	const buffer = buffers[view?.buffer ?? -1];
	if (!(view && buffer) || image.mimeType !== "image/png") {
		throw new Error(
			"Embedded glTF textures must be PNG images in a buffer view."
		);
	}
	const bytes = buffer.subarray(
		view.byteOffset ?? 0,
		(view.byteOffset ?? 0) + (view.byteLength ?? 0)
	);
	if (bytes.byteLength > 1_400_000) {
		throw new Error("glTF texture exceeds the supported 1.5 MB bound.");
	}
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (!signature.every((value, index) => bytes[index] === value)) {
		throw new Error("Embedded glTF texture is not a PNG image.");
	}
	return `data:image/png;base64,${base64(bytes)}`;
}

function parseDocument(
	document: GltfDocument,
	buffers: Uint8Array[]
): ParsedGltfMesh[] {
	if (document.asset?.version !== "2.0") {
		throw new Error("Only glTF 2.0 assets are supported.");
	}
	const nodes = document.nodes ?? [];
	if (nodes.length > maxNodes) {
		throw new Error("glTF contains too many nodes.");
	}
	const roots = document.scenes?.[document.scene ?? 0]?.nodes ?? [];
	const meshes: ParsedGltfMesh[] = [];
	const visit = (nodeIndex: number, parent: number[]) => {
		const node = nodes[nodeIndex];
		if (!node) {
			return;
		}
		const matrix = multiply(parent, nodeMatrix(node));
		const source =
			node.mesh === undefined ? undefined : document.meshes?.[node.mesh];
		for (const [primitiveIndex, primitive] of (
			source?.primitives ?? []
		).entries()) {
			if (
				(primitive.mode ?? 4) !== 4 ||
				primitive.attributes?.POSITION === undefined
			) {
				throw new Error(
					"glTF primitive must be a triangle mesh with POSITION data."
				);
			}
			const positions = readAccessor(
				document,
				buffers,
				primitive.attributes.POSITION,
				"VEC3"
			);
			const uvs =
				primitive.attributes?.TEXCOORD_0 === undefined
					? undefined
					: readAccessor(
							document,
							buffers,
							primitive.attributes.TEXCOORD_0,
							"VEC2"
						);
			if (uvs && uvs.length !== positions.length) {
				throw new Error(
					"glTF texture coordinates must match POSITION vertices."
				);
			}
			const skeletal =
				node.skin !== undefined &&
				primitive.attributes?.JOINTS_0 !== undefined &&
				primitive.attributes?.WEIGHTS_0 !== undefined
					? skeletalFrames(
							document,
							buffers,
							nodeIndex,
							node.skin,
							positions,
							readAccessor(
								document,
								buffers,
								primitive.attributes.JOINTS_0,
								"VEC4"
							),
							readAccessor(
								document,
								buffers,
								primitive.attributes.WEIGHTS_0,
								"VEC4"
							)
						)
					: undefined;
			const rig =
				node.skin !== undefined &&
				primitive.attributes?.JOINTS_0 !== undefined &&
				primitive.attributes?.WEIGHTS_0 !== undefined &&
				!hasJointAnimation(document, document.skins?.[node.skin]?.joints ?? [])
					? skeletalRig(
							document,
							buffers,
							nodeIndex,
							node.skin,
							positions,
							readAccessor(
								document,
								buffers,
								primitive.attributes.JOINTS_0,
								"VEC4"
							),
							readAccessor(
								document,
								buffers,
								primitive.attributes.WEIGHTS_0,
								"VEC4"
							)
						)
					: undefined;
			const indices =
				primitive.indices === undefined
					? positions.map((_, index) => index)
					: readAccessor(document, buffers, primitive.indices, "SCALAR").flat();
			if (indices.length < 3 || indices.length % 3 !== 0) {
				throw new Error("glTF triangle indices are incomplete.");
			}
			const vertices =
				skeletal?.[0]?.vertices ??
				positions.map((point) => transform(matrix, point));
			const faces: number[][] = [];
			for (let index = 0; index < indices.length; index += 3) {
				const face = indices.slice(index, index + 3).map(Number);
				if (
					face.some(
						(value) =>
							!Number.isInteger(value) || value < 0 || value >= vertices.length
					)
				) {
					throw new Error("glTF triangle references a missing vertex.");
				}
				faces.push(face);
			}
			const mesh = objMeshSchema.parse({
				faces,
				...(uvs ? { uvs } : {}),
				vertices,
			});
			meshes.push({
				fill: materialColor(document, primitive.material),
				keyframes: animationKeyframes(document, buffers, nodeIndex),
				mesh,
				name: node.name ?? source?.name ?? `Mesh ${primitiveIndex + 1}`,
				...(skeletal ? { deformationFrames: skeletal } : {}),
				...(rig ? { rig } : {}),
				texture: embeddedTexture(document, buffers, primitive.material),
			});
		}
		for (const child of node.children ?? []) {
			visit(child, matrix);
		}
	};
	for (const root of roots) {
		visit(root, identity());
	}
	if (!meshes.length && document.meshes?.length) {
		visit(0, identity());
	}
	return meshes;
}

function readGlb(bytes: Uint8Array): {
	document: GltfDocument;
	bin?: Uint8Array;
} {
	if (bytes.byteLength < 20) {
		throw new Error("GLB file is truncated.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		view.getUint32(0, true) !== 0x46_54_6c_67 ||
		view.getUint32(4, true) !== 2
	) {
		throw new Error("GLB header is invalid.");
	}
	const length = view.getUint32(8, true);
	if (length > bytes.byteLength) {
		throw new Error("GLB length exceeds the file.");
	}
	let offset = 12;
	let document: GltfDocument | undefined;
	let bin: Uint8Array | undefined;
	while (offset + 8 <= length) {
		const chunkLength = view.getUint32(offset, true);
		const chunkType = view.getUint32(offset + 4, true);
		const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
		if (chunkType === 0x4e_4f_53_4a) {
			document = readJson(chunk);
		}
		if (chunkType === 0x00_4e_49_42) {
			bin = chunk;
		}
		offset += 8 + chunkLength;
	}
	if (!document) {
		throw new Error("GLB JSON chunk is missing.");
	}
	return { bin, document };
}

export function parseGltf(bytes: Uint8Array): ParsedGltfMesh[] {
	if (bytes.byteLength > maxGltfBytes) {
		throw new Error("glTF files are limited to 4 MB.");
	}
	const isGlb =
		bytes.byteLength >= 4 &&
		new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) ===
			0x46_54_6c_67;
	const parsed = isGlb ? readGlb(bytes) : { document: readJson(bytes) };
	return parseDocument(
		parsed.document,
		loadBuffers(parsed.document, parsed.bin)
	);
}
