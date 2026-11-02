import {
	RyuAppActions,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
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
	meshKeyframePropertySchema,
	meshKeyframeValueBounds,
} from "../../shared/mesh-animation.ts";
import type { Mesh } from "../../shared/project.ts";
import { studioFormat } from "./i18n/format.ts";
import { useMeshRigEditor } from "./MeshPanel-rig-editor.ts";
import { MeshRigFields } from "./MeshPanel-rig-fields.tsx";

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
	const tl = useLiteralMessages();
	const picker = useRef<HTMLInputElement>(null);
	const [keyframeProperty, setKeyframeProperty] =
		useState<MeshKeyframeProperty>("rotationY");
	const [keyframeValue, setKeyframeValue] = useState(0);
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
					const importedMesh: Mesh = {
						...parsedMesh,
						end: Math.min(7200, time + Math.max(4, deformationDuration)),
						fill,
						id: crypto.randomUUID(),
						keyframes,
						rotationX: 0,
						rotationY: 0,
						rotationZ: 0,
						scale: 0.75 / span,
						start: time,
						x: index * 0.05,
						y: 0,
						z: 0.2 + index * 0.02,
					};
					if (deformationFrames) {
						importedMesh.deformationFrames = deformationFrames;
					}
					if (texture) {
						importedMesh.texture = texture;
					}
					return importedMesh;
				}
			);
			onChange([...meshes, ...imported]);
			onStatus(
				studioFormat(
					"Imported {file} as {count, plural, one {# editable mesh} other {# editable meshes}}.",
					{ count: imported.length, file: file.name }
				)
			);
		} catch (error) {
			onStatus(error instanceof Error ? error.message : "3D import failed.");
		}
	};
	const change = (id: string, patch: Partial<Mesh>) =>
		onChange(
			meshes.map((mesh) => (mesh.id === id ? { ...mesh, ...patch } : mesh))
		);
	const rigEditor = useMeshRigEditor({ change, onStatus, time });
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
					<strong>{tl("Mesh {number}", { number: index + 1 })}</strong>
					<small>
						{tl("{vertices} vertices · {faces} faces", {
							faces: String(mesh.faces.length),
							vertices: String(mesh.vertices.length),
						})}
					</small>
					{mesh.deformationFrames?.length ? (
						<small>
							{tl("Baked skeletal motion · {poses} poses", {
								poses: String(mesh.deformationFrames.length),
							})}
						</small>
					) : null}
					{mesh.rig ? (
						<>
							<small>
								{tl("Interactive skeletal rig · {joints} joints", {
									joints: String(mesh.rig.joints.length),
								})}
							</small>
							<MeshRigFields
								editor={rigEditor}
								index={index}
								mesh={{ ...mesh, rig: mesh.rig }}
							/>
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
								aria-label={tl("Mesh {number} {label}", {
									label,
									number: index + 1,
								})}
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
							triggerAriaLabel={tl("Mesh {number} color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={mesh.fill}
						/>
					</RyuAppField>
					<RyuAppField label="Mesh keyframe property">
						<NativeSelect
							aria-label={tl("Mesh {number} keyframe property", {
								number: index + 1,
							})}
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
							aria-label={tl("Mesh {number} keyframe value", {
								number: index + 1,
							})}
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
							{tl(
								"{count, plural, one {{countText} mesh keyframe saved} other {{countText} mesh keyframes saved}}",
								{
									count: mesh.keyframes.length,
									countText: String(mesh.keyframes.length),
								}
							)}
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
