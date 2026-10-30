import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { z } from "zod";
import {
	meshKeyframePropertySchema,
	meshRigConstraintSchema,
	meshRigKeyframeValueBounds,
} from "../../shared/mesh-animation.ts";
import type { Mesh } from "../../shared/project.ts";
import type { MeshRigEditor } from "./MeshPanel-rig-editor.ts";

const rigConstraintTypeSchema = z.union([
	meshRigConstraintSchema.options[0].shape.type,
	meshRigConstraintSchema.options[1].shape.type,
]);
const rigConstraintAxisSchema = z.union([
	meshRigConstraintSchema.options[0].shape.axis,
	meshRigConstraintSchema.options[1].shape.axis,
]);

/** Joint, rig keyframe and joint-limit fields for one rigged mesh. */
export function MeshRigFields({
	editor,
	index,
	mesh,
}: {
	editor: MeshRigEditor;
	index: number;
	mesh: Mesh & { rig: NonNullable<Mesh["rig"]> };
}) {
	const tl = useLiteralMessages();
	const {
		addRigConstraint,
		addRigKeyframe,
		changeRigJoint,
		removeRigConstraint,
		rigConstraintAxis,
		rigConstraintMax,
		rigConstraintMin,
		rigConstraintType,
		rigJointIndex,
		rigKeyframeProperty,
		rigKeyframeValue,
		setRigConstraintAxis,
		setRigConstraintMax,
		setRigConstraintMin,
		setRigConstraintType,
		setRigJointIndex,
		setRigKeyframeProperty,
		setRigKeyframeValue,
	} = editor;
	return (
		<>
			<RyuAppField label="Rig joint">
				<NativeSelect
					aria-label={tl("Mesh {number} rig joint", { number: index + 1 })}
					onChange={(event) => setRigJointIndex(Number(event.target.value))}
					value={String(Math.min(rigJointIndex, mesh.rig.joints.length - 1))}
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
					aria-label={tl("Mesh {number} rig parent", { number: index + 1 })}
					onChange={(event) =>
						changeRigJoint(mesh, rigJointIndex, {
							parent: Number(event.target.value),
						})
					}
					value={String(
						mesh.rig.joints[Math.min(rigJointIndex, mesh.rig.joints.length - 1)]
							?.parent ?? -1
					)}
				>
					<NativeSelectOption value="-1">None</NativeSelectOption>
					{mesh.rig.joints.map((joint, jointIndex) =>
						jointIndex ===
						Math.min(rigJointIndex, mesh.rig!.joints.length - 1) ? null : (
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
					mesh.rig?.joints[Math.min(rigJointIndex, mesh.rig.joints.length - 1)];
				if (!joint) {
					return null;
				}
				return (
					<RyuAppField key={property} label={label}>
						<Input
							aria-label={tl("Mesh {number} {label}", {
								label,
								number: index + 1,
							})}
							defaultValue={joint[property]}
							key={`${joint.name}:${property}:${joint[property]}`}
							max={max}
							min={min}
							onBlur={(event) => {
								const value = Number(event.target.value);
								if (Number.isFinite(value) && value >= min && value <= max) {
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
					aria-label={tl("Mesh {number} rig keyframe property", {
						number: index + 1,
					})}
					onChange={(event) => {
						const property = meshKeyframePropertySchema.parse(
							event.target.value
						);
						setRigKeyframeProperty(property);
						const bounds = meshRigKeyframeValueBounds(property);
						setRigKeyframeValue(
							Math.max(bounds.min, Math.min(bounds.max, rigKeyframeValue))
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
					aria-label={tl("Mesh {number} rig keyframe value", {
						number: index + 1,
					})}
					max={meshRigKeyframeValueBounds(rigKeyframeProperty).max}
					min={meshRigKeyframeValueBounds(rigKeyframeProperty).min}
					onChange={(event) => setRigKeyframeValue(Number(event.target.value))}
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
					{tl(
						"{count, plural, one {{countText} rig keyframe saved} other {{countText} rig keyframes saved}}",
						{
							count: mesh.rig.keyframes.length,
							countText: String(mesh.rig.keyframes.length),
						}
					)}
				</small>
			) : null}
			<RyuAppField label="Joint constraint type">
				<NativeSelect
					aria-label={tl("Mesh {number} rig constraint type", {
						number: index + 1,
					})}
					onChange={(event) => {
						const type = rigConstraintTypeSchema.parse(event.target.value);
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
					aria-label={tl("Mesh {number} rig constraint axis", {
						number: index + 1,
					})}
					onChange={(event) =>
						setRigConstraintAxis(
							rigConstraintAxisSchema.parse(event.target.value)
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
						aria-label={tl("Mesh {number} rig constraint minimum", {
							number: index + 1,
						})}
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
						aria-label={tl("Mesh {number} rig constraint maximum", {
							number: index + 1,
						})}
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
				Limits clamp keyed local joint values in both preview and export.
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
	);
}
