import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import {
	type MeshKeyframeProperty,
	type MeshRigConstraint,
	type MeshRigJoint,
	meshRigKeyframeValueBounds,
} from "../../shared/mesh-animation.ts";
import type { Mesh } from "../../shared/project.ts";

const rotationConstraintAxes = ["rotationX", "rotationY", "rotationZ"] as const;
const translationConstraintAxes = ["x", "y", "z"] as const;

/** Rig editing state and actions shared by every mesh row in `MeshPanel`. */
export function useMeshRigEditor({
	time,
	change,
	onStatus,
}: {
	time: number;
	change: (id: string, patch: Partial<Mesh>) => void;
	onStatus: (message: string) => void;
}) {
	const tl = useLiteralMessages();
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
		let bounds: Pick<MeshRigConstraint, "max" | "min">;
		if (rigConstraintType === "rotation-limit") {
			const axis =
				rotationConstraintAxes.find((value) => value === rigConstraintAxis) ??
				"rotationZ";
			bounds = { max: 180, min: -180 };
			constraint = {
				axis,
				joint,
				max: 180,
				min: -180,
				type: rigConstraintType,
			};
		} else {
			const axis =
				translationConstraintAxes.find(
					(value) => value === rigConstraintAxis
				) ?? "x";
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
			constraint.type === "rotation-limit"
				? tl("Rotation limit saved for {joint}.", {
						joint: rig.joints[joint]?.name ?? "joint",
					})
				: tl("Translation limit saved for {joint}.", {
						joint: rig.joints[joint]?.name ?? "joint",
					})
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
	return {
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
	};
}

export type MeshRigEditor = ReturnType<typeof useMeshRigEditor>;
