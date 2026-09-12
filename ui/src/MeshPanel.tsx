import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useRef, useState } from "react";
import { parseGltf } from "../../shared/gltf.ts";
import { meshBounds, parseObj } from "../../shared/mesh.ts";
import {
	type MeshKeyframeProperty,
	type MeshRigConstraint,
	type MeshRigJoint,
	meshKeyframePropertySchema,
	meshKeyframeValueBounds,
	meshRigKeyframeValueBounds,
} from "../../shared/mesh-animation.ts";
import type { Mesh } from "../../shared/project.ts";

const rotationConstraintAxes = ["rotationX", "rotationY", "rotationZ"] as const;
const translationConstraintAxes = ["x", "y", "z"] as const;

export function MeshPanel({
	meshes,
	time,
	onChange,
	onStatus,
}: {
	meshes: Mesh[];
	time: number;
	onChange: (meshes: Mesh[]) => void;
	onStatus: (message: string) => void;
}) {
	const picker = useRef<HTMLInputElement>(null);
	const [keyframeProperty, setKeyframeProperty] =
		useState<MeshKeyframeProperty>("rotationY");
	const [keyframeValue, setKeyframeValue] = useState(0);
	const [rigJointIndex, setRigJointIndex] = useState(0);
	const [rigKeyframeProperty, setRigKeyframeProperty] =
		useState<MeshKeyframeProperty>("rotationY");
	const [rigKeyframeValue, setRigKeyframeValue] = useState(0);
	const [rigConstraintType, setRigConstraintType] =
		useState<MeshRigConstraint["type"]>("rotation-limit");
	const [rigConstraintAxis, setRigConstraintAxis] =
		useState<MeshRigConstraint["axis"]>("rotationZ");
	const [rigConstraintMin, setRigConstraintMin] = useState(-45);
	const [rigConstraintMax, setRigConstraintMax] = useState(45);
	const addMeshFile = async (file: File) => {
		try {
			const extension = file.name.toLowerCase().split(".").at(-1);
			const parsed =
				extension === "obj"
					? [
							{
								keyframes: undefined,
								mesh: parseObj(await file.text()),
								fill: "#a855f7",
								deformationFrames: undefined,
								texture: undefined,
							},
						]
					: parseGltf(new Uint8Array(await file.arrayBuffer()));
			if (!parsed.length) {
				throw new Error("The 3D file contains no supported triangle meshes.");
			}
			const imported = parsed.map(
				(
					{ mesh: parsedMesh, fill, keyframes, texture, deformationFrames },
					index
				) => {
					const bounds = meshBounds(parsedMesh);
					const span = Math.max(
						bounds.maxX - bounds.minX,
						bounds.maxY - bounds.minY,
						bounds.maxZ - bounds.minZ,
						0.001
					);
					const deformationDuration = Math.max(
						0,
						...(deformationFrames ?? []).map((frame) => frame.time)
					);
					return {
						...parsedMesh,
						end: Math.min(7200, time + Math.max(4, deformationDuration)),
						fill,
						id: crypto.randomUUID(),
						keyframes,
						...(deformationFrames ? { deformationFrames } : {}),
						...(texture ? { texture } : {}),
						rotationX: 0,
						rotationY: 0,
						rotationZ: 0,
						scale: 0.75 / span,
						start: time,
						x: index * 0.05,
						y: 0,
						z: 0.2 + index * 0.02,
					} satisfies Mesh;
				}
			);
			onChange([...meshes, ...imported]);
			onStatus(
				`Imported ${file.name} as ${imported.length} editable mesh${imported.length === 1 ? "" : "es"}.`
			);
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "3D import failed.");
		}
	};
	const change = (id: string, patch: Partial<Mesh>) =>
		onChange(
			meshes.map((mesh) => (mesh.id === id ? { ...mesh, ...patch } : mesh))
		);
	const changeRigJoint = (
		mesh: Mesh,
		jointIndex: number,
		patch: Partial<MeshRigJoint>
	) => {
		if (!mesh.rig) {
			return;
		}
		change(mesh.id, {
			rig: {
				...mesh.rig,
				joints: mesh.rig.joints.map((joint, index) =>
					index === jointIndex ? { ...joint, ...patch } : joint
				),
			},
		});
	};
	const addKeyframe = (mesh: Mesh) => {
		const bounds = meshKeyframeValueBounds(keyframeProperty);
		const localTime = Math.max(
			0,
			Math.min(mesh.end - mesh.start, time - mesh.start)
		);
		const keyframe = {
			id: crypto.randomUUID(),
			property: keyframeProperty,
			time: Number(localTime.toFixed(3)),
			value: Math.max(bounds.min, Math.min(bounds.max, keyframeValue)),
		};
		change(mesh.id, {
			keyframes: [
				...(mesh.keyframes ?? []).filter(
					(item) =>
						!(
							item.property === keyframe.property && item.time === keyframe.time
						)
				),
				keyframe,
			].sort((a, b) => a.time - b.time),
		});
	};
	const addRigKeyframe = (mesh: Mesh) => {
		const rig = mesh.rig;
		const joint = rig?.joints[rigJointIndex];
		if (!(rig && joint)) {
			return;
		}
		const bounds = meshRigKeyframeValueBounds(rigKeyframeProperty);
		const localTime = Math.max(
			0,
			Math.min(mesh.end - mesh.start, time - mesh.start)
		);
		const keyframe = {
			id: crypto.randomUUID(),
			joint: rigJointIndex,
			property: rigKeyframeProperty,
			time: Number(localTime.toFixed(3)),
			value: Math.max(bounds.min, Math.min(bounds.max, rigKeyframeValue)),
		};
		change(mesh.id, {
			rig: {
				...rig,
				keyframes: [
					...(rig.keyframes ?? []).filter(
						(item) =>
							!(
								item.joint === keyframe.joint &&
								item.property === keyframe.property &&
								item.time === keyframe.time
							)
					),
					keyframe,
				].sort((a, b) => a.time - b.time),
			},
		});
	};
	const addRigConstraint = (mesh: Mesh) => {
		const rig = mesh.rig;
		if (!rig) {
			return;
		}
		const joint = Math.min(rigJointIndex, rig.joints.length - 1);
		let constraint: MeshRigConstraint;
		let bounds: { max: number; min: number };
		if (rigConstraintType === "rotation-limit") {
			const axis = rotationConstraintAxes.includes(
				rigConstraintAxis as (typeof rotationConstraintAxes)[number]
			)
				? (rigConstraintAxis as (typeof rotationConstraintAxes)[number])
				: "rotationZ";
			bounds = { max: 180, min: -180 };
			constraint = {
				axis,
				joint,
				max: 180,
				min: -180,
				type: rigConstraintType,
			};
		} else {
			const axis = translationConstraintAxes.includes(
				rigConstraintAxis as (typeof translationConstraintAxes)[number]
			)
				? (rigConstraintAxis as (typeof translationConstraintAxes)[number])
				: "x";
			bounds = { max: 2, min: -2 };
			constraint = { axis, joint, max: 2, min: -2, type: rigConstraintType };
		}
		if (
			!(Number.isFinite(rigConstraintMin) && Number.isFinite(rigConstraintMax))
		) {
			onStatus("Enter finite minimum and maximum constraint values.");
			return;
		}
		const min = Math.max(bounds.min, Math.min(bounds.max, rigConstraintMin));
		const max = Math.max(bounds.min, Math.min(bounds.max, rigConstraintMax));
		if (min > max) {
			onStatus("The constraint minimum must be at or below its maximum.");
			return;
		}
		constraint = { ...constraint, max, min };
		change(mesh.id, {
			rig: {
				...rig,
				constraints: [
					...(rig.constraints ?? []).filter(
						(item) =>
							!(
								item.type === constraint.type &&
								item.joint === constraint.joint &&
								item.axis === constraint.axis
							)
					),
					constraint,
				],
			},
		});
		onStatus(
			`${constraint.type === "rotation-limit" ? "Rotation" : "Translation"} limit saved for ${rig.joints[joint]?.name ?? "joint"}.`
		);
	};
	const removeRigConstraint = (mesh: Mesh, constraintIndex: number) => {
		if (!mesh.rig) {
			return;
		}
		change(mesh.id, {
			rig: {
				...mesh.rig,
				constraints: (mesh.rig.constraints ?? []).filter(
					(_, index) => index !== constraintIndex
				),
			},
		});
	};
	return (
		<RyuAppSection title="Meshes">
			<RyuAppActions>
				<Button onClick={() => picker.current?.click()} variant="outline">
					Import 3D mesh
				</Button>
			</RyuAppActions>
			<input
				accept=".obj,.gltf,.glb,text/plain,model/gltf+json,model/gltf-binary"
				hidden
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) {
						void addMeshFile(file);
					}
					event.target.value = "";
				}}
				ref={picker}
				type="file"
			/>
			<p className="text-muted-foreground">
				Import bounded Wavefront OBJ or glTF/GLB geometry. Embedded PNG textures
				stay in the project; external buffers and image URLs are rejected.
				Preview and export use the same camera projection.
			</p>
			{meshes.map((mesh, index) => (
				<div className="studio-scene" key={mesh.id}>
					<strong>Mesh {index + 1}</strong>
					<small>
						{mesh.vertices.length} vertices · {mesh.faces.length} faces
					</small>
					{mesh.deformationFrames?.length ? (
						<small>
							Baked skeletal motion · {mesh.deformationFrames.length} poses
						</small>
					) : null}
					{mesh.rig ? (
						<>
							<small>
								Interactive skeletal rig · {mesh.rig.joints.length} joints
							</small>
							<RyuAppField label="Rig joint">
								<NativeSelect
									aria-label={`Mesh ${index + 1} rig joint`}
									onChange={(event) =>
										setRigJointIndex(Number(event.target.value))
									}
									value={String(
										Math.min(rigJointIndex, mesh.rig.joints.length - 1)
									)}
								>
									{mesh.rig.joints.map((joint, jointIndex) => (
										<NativeSelectOption
											key={`${mesh.id}:joint:${jointIndex}`}
											value={String(jointIndex)}
										>
											{joint.name}
										</NativeSelectOption>
									))}
								</NativeSelect>
							</RyuAppField>
							<RyuAppField label="Rig parent">
								<NativeSelect
									aria-label={`Mesh ${index + 1} rig parent`}
									onChange={(event) =>
										changeRigJoint(mesh, rigJointIndex, {
											parent: Number(event.target.value),
										})
									}
									value={String(
										mesh.rig.joints[
											Math.min(rigJointIndex, mesh.rig.joints.length - 1)
										]?.parent ?? -1
									)}
								>
									<NativeSelectOption value="-1">None</NativeSelectOption>
									{mesh.rig.joints.map((joint, jointIndex) =>
										jointIndex ===
										Math.min(
											rigJointIndex,
											mesh.rig!.joints.length - 1
										) ? null : (
											<NativeSelectOption
												key={`${mesh.id}:parent:${jointIndex}`}
												value={String(jointIndex)}
											>
												{joint.name}
											</NativeSelectOption>
										)
									)}
								</NativeSelect>
							</RyuAppField>
							{(
								[
									["x", "Joint X", -2, 2],
									["y", "Joint Y", -2, 2],
									["z", "Joint Z", -2, 2],
									["rotationX", "Joint rotate X", -180, 180],
									["rotationY", "Joint rotate Y", -180, 180],
									["rotationZ", "Joint rotate Z", -180, 180],
								] as const
							).map(([property, label, min, max]) => {
								const joint =
									mesh.rig?.joints[
										Math.min(rigJointIndex, mesh.rig.joints.length - 1)
									];
								if (!joint) {
									return null;
								}
								return (
									<RyuAppField key={property} label={label}>
										<Input
											aria-label={`Mesh ${index + 1} ${label}`}
											defaultValue={joint[property]}
											key={`${joint.name}:${property}:${joint[property]}`}
											max={max}
											min={min}
											onBlur={(event) => {
												const value = Number(event.target.value);
												if (
													Number.isFinite(value) &&
													value >= min &&
													value <= max
												) {
													changeRigJoint(mesh, rigJointIndex, {
														[property]: value,
													});
												} else {
													event.target.value = String(joint[property]);
												}
											}}
											step={0.01}
											type="number"
										/>
									</RyuAppField>
								);
							})}
							<RyuAppField label="Rig keyframe property">
								<NativeSelect
									aria-label={`Mesh ${index + 1} rig keyframe property`}
									onChange={(event) => {
										const property = meshKeyframePropertySchema.parse(
											event.target.value
										);
										setRigKeyframeProperty(property);
										const bounds = meshRigKeyframeValueBounds(property);
										setRigKeyframeValue(
											Math.max(
												bounds.min,
												Math.min(bounds.max, rigKeyframeValue)
											)
										);
									}}
									value={rigKeyframeProperty}
								>
									<NativeSelectOption value="x">Joint X</NativeSelectOption>
									<NativeSelectOption value="y">Joint Y</NativeSelectOption>
									<NativeSelectOption value="z">Joint Z</NativeSelectOption>
									<NativeSelectOption value="rotationX">
										Joint rotate X
									</NativeSelectOption>
									<NativeSelectOption value="rotationY">
										Joint rotate Y
									</NativeSelectOption>
									<NativeSelectOption value="rotationZ">
										Joint rotate Z
									</NativeSelectOption>
								</NativeSelect>
							</RyuAppField>
							<RyuAppField label="Rig keyframe value">
								<Input
									aria-label={`Mesh ${index + 1} rig keyframe value`}
									max={meshRigKeyframeValueBounds(rigKeyframeProperty).max}
									min={meshRigKeyframeValueBounds(rigKeyframeProperty).min}
									onChange={(event) =>
										setRigKeyframeValue(Number(event.target.value))
									}
									step={0.1}
									type="number"
									value={rigKeyframeValue}
								/>
							</RyuAppField>
							<Button onClick={() => addRigKeyframe(mesh)} variant="outline">
								Add rig keyframe at playhead
							</Button>
							{mesh.rig.keyframes?.length ? (
								<small>
									{mesh.rig.keyframes.length} rig keyframe
									{mesh.rig.keyframes.length === 1 ? "" : "s"} saved
								</small>
							) : null}
							<RyuAppField label="Joint constraint type">
								<NativeSelect
									aria-label={`Mesh ${index + 1} rig constraint type`}
									onChange={(event) => {
										const type = event.target
											.value as MeshRigConstraint["type"];
										setRigConstraintType(type);
										if (type === "rotation-limit") {
											setRigConstraintAxis("rotationZ");
											setRigConstraintMin(-45);
											setRigConstraintMax(45);
										} else {
											setRigConstraintAxis("x");
											setRigConstraintMin(-1);
											setRigConstraintMax(1);
										}
									}}
									value={rigConstraintType}
								>
									<NativeSelectOption value="rotation-limit">
										Rotation limit
									</NativeSelectOption>
									<NativeSelectOption value="translation-limit">
										Translation limit
									</NativeSelectOption>
								</NativeSelect>
							</RyuAppField>
							<RyuAppField label="Joint constraint axis">
								<NativeSelect
									aria-label={`Mesh ${index + 1} rig constraint axis`}
									onChange={(event) =>
										setRigConstraintAxis(
											event.target.value as MeshRigConstraint["axis"]
										)
									}
									value={rigConstraintAxis}
								>
									{rigConstraintType === "rotation-limit" ? (
										<>
											<NativeSelectOption value="rotationX">
												Rotation X
											</NativeSelectOption>
											<NativeSelectOption value="rotationY">
												Rotation Y
											</NativeSelectOption>
											<NativeSelectOption value="rotationZ">
												Rotation Z
											</NativeSelectOption>
										</>
									) : (
										<>
											<NativeSelectOption value="x">Joint X</NativeSelectOption>
											<NativeSelectOption value="y">Joint Y</NativeSelectOption>
											<NativeSelectOption value="z">Joint Z</NativeSelectOption>
										</>
									)}
								</NativeSelect>
							</RyuAppField>
							<div className="grid grid-cols-2 gap-2">
								<RyuAppField label="Limit minimum">
									<Input
										aria-label={`Mesh ${index + 1} rig constraint minimum`}
										max={rigConstraintType === "rotation-limit" ? 180 : 2}
										min={rigConstraintType === "rotation-limit" ? -180 : -2}
										onChange={(event) =>
											setRigConstraintMin(Number(event.target.value))
										}
										step={0.1}
										type="number"
										value={rigConstraintMin}
									/>
								</RyuAppField>
								<RyuAppField label="Limit maximum">
									<Input
										aria-label={`Mesh ${index + 1} rig constraint maximum`}
										max={rigConstraintType === "rotation-limit" ? 180 : 2}
										min={rigConstraintType === "rotation-limit" ? -180 : -2}
										onChange={(event) =>
											setRigConstraintMax(Number(event.target.value))
										}
										step={0.1}
										type="number"
										value={rigConstraintMax}
									/>
								</RyuAppField>
							</div>
							<Button onClick={() => addRigConstraint(mesh)} variant="outline">
								Save joint limit
							</Button>
							<small>
								Limits clamp keyed local joint values in both preview and
								export.
							</small>
							{mesh.rig.constraints?.map((constraint, constraintIndex) => (
								<div
									className="flex items-center justify-between gap-2"
									key={`${mesh.id}:constraint:${constraint.type}:${constraint.axis}`}
								>
									<small>
										{constraint.type === "rotation-limit"
											? `${constraint.axis} ${constraint.min}° to ${constraint.max}°`
											: `${constraint.axis} ${constraint.min} to ${constraint.max}`}
									</small>
									<Button
										onClick={() => removeRigConstraint(mesh, constraintIndex)}
										size="sm"
										variant="ghost"
									>
										Remove
									</Button>
								</div>
							))}
						</>
					) : null}
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Offset X", -1, 1],
							["y", "Offset Y", -1, 1],
							["z", "Depth Z", -1, 1],
							["scale", "Scale", 0.02, 4],
							["rotationX", "Rotate X", -180, 180],
							["rotationY", "Rotate Y", -180, 180],
							["rotationZ", "Rotate Z", -180, 180],
						] as const
					).map(([key, label, min, max]) => (
						<RyuAppField key={key} label={label}>
							<Input
								aria-label={`Mesh ${index + 1} ${label}`}
								defaultValue={mesh[key]}
								key={mesh[key]}
								max={max}
								min={min}
								onBlur={(event) => {
									const value = Number(event.target.value);
									if (Number.isFinite(value) && value >= min && value <= max) {
										change(mesh.id, { [key]: value });
									} else {
										event.target.value = String(mesh[key]);
									}
								}}
								step={0.01}
								type="number"
							/>
						</RyuAppField>
					))}
					<RyuAppField label="Mesh color">
						<ColorPickerPopover
							onValueChange={(value) => change(mesh.id, { fill: value })}
							triggerAriaLabel={`Mesh ${index + 1} color`}
							triggerClassName="w-full justify-start"
							value={mesh.fill}
						/>
					</RyuAppField>
					<RyuAppField label="Mesh keyframe property">
						<NativeSelect
							aria-label={`Mesh ${index + 1} keyframe property`}
							onChange={(event) => {
								const property = meshKeyframePropertySchema.parse(
									event.target.value
								);
								setKeyframeProperty(property);
								const bounds = meshKeyframeValueBounds(property);
								setKeyframeValue(
									Math.max(bounds.min, Math.min(bounds.max, keyframeValue))
								);
							}}
							value={keyframeProperty}
						>
							<NativeSelectOption value="x">Offset X</NativeSelectOption>
							<NativeSelectOption value="y">Offset Y</NativeSelectOption>
							<NativeSelectOption value="z">Depth Z</NativeSelectOption>
							<NativeSelectOption value="rotationX">
								Rotate X
							</NativeSelectOption>
							<NativeSelectOption value="rotationY">
								Rotate Y
							</NativeSelectOption>
							<NativeSelectOption value="rotationZ">
								Rotate Z
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Mesh keyframe value">
						<Input
							aria-label={`Mesh ${index + 1} keyframe value`}
							max={meshKeyframeValueBounds(keyframeProperty).max}
							min={meshKeyframeValueBounds(keyframeProperty).min}
							onChange={(event) => setKeyframeValue(Number(event.target.value))}
							step={0.1}
							type="number"
							value={keyframeValue}
						/>
					</RyuAppField>
					<Button onClick={() => addKeyframe(mesh)} variant="outline">
						Add mesh keyframe at playhead
					</Button>
					{mesh.keyframes?.length ? (
						<small>
							{mesh.keyframes.length} mesh keyframe
							{mesh.keyframes.length === 1 ? "" : "s"} saved
						</small>
					) : null}
					<Button
						onClick={() =>
							onChange(meshes.filter((item) => item.id !== mesh.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove mesh
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
