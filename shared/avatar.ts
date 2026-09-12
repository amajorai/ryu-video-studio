import { z } from "zod";

const avatarTime = z.number().finite().min(0).max(7200);

export const avatarRigPropertySchema = z.enum([
	"leftArm",
	"rightArm",
	"leftLeg",
	"rightLeg",
	"head",
	"mouth",
]);
export type AvatarRigProperty = z.infer<typeof avatarRigPropertySchema>;

export const avatarRigKeyframeSchema = z
	.object({
		id: z.uuid(),
		property: avatarRigPropertySchema,
		time: avatarTime,
		value: z.number().finite().min(-180).max(180),
	})
	.strict();
export type AvatarRigKeyframe = z.infer<typeof avatarRigKeyframeSchema>;

export interface AvatarRigPose {
	head: number;
	leftArm: number;
	leftLeg: number;
	mouth: number;
	rightArm: number;
	rightLeg: number;
}

interface AvatarRigSource {
	animation: "none" | "idle" | "slide-left" | "slide-right";
	pose: "neutral" | "wave" | "point";
	rigKeyframes?: AvatarRigKeyframe[];
	start: number;
}

export const avatarBasePose = (
	pose: AvatarRigSource["pose"]
): AvatarRigPose => {
	switch (pose) {
		case "wave":
			return {
				leftArm: -34,
				rightArm: 16,
				leftLeg: 0,
				rightLeg: 0,
				head: 0,
				mouth: 0.25,
			};
		case "point":
			return {
				leftArm: -8,
				rightArm: 42,
				leftLeg: 0,
				rightLeg: 0,
				head: 4,
				mouth: 0.18,
			};
		default:
			return {
				leftArm: 0,
				rightArm: 0,
				leftLeg: 0,
				rightLeg: 0,
				head: 0,
				mouth: 0.12,
			};
	}
};

function idleAdjustment(
	avatar: AvatarRigSource,
	property: AvatarRigProperty
): string {
	if (avatar.animation !== "idle") {
		return "0";
	}
	if (property === "leftArm") {
		return `sin((t-${avatar.start})*6.283185)*4`;
	}
	if (property === "rightArm") {
		return `0-sin((t-${avatar.start})*6.283185)*4`;
	}
	if (property === "head") {
		return `sin((t-${avatar.start})*6.283185)*2`;
	}
	return "0";
}

/** Build the matching FFmpeg expression for an animated rig property. */
export function avatarRigExpression(
	avatar: AvatarRigSource,
	property: AvatarRigProperty
): string {
	const defaults = avatarBasePose(avatar.pose);
	const keyframes = (avatar.rigKeyframes ?? [])
		.filter((keyframe) => keyframe.property === property)
		.sort((a, b) => a.time - b.time);
	if (!keyframes.length) {
		return `(${defaults[property]}+${idleAdjustment(avatar, property)})`;
	}
	const local = `(t-${avatar.start})`;
	let expression = String(keyframes.at(-1)!.value);
	for (let index = keyframes.length - 2; index >= 0; index--) {
		const left = keyframes[index]!;
		const right = keyframes[index + 1]!;
		const span = right.time - left.time;
		const value = `${left.value}+(${right.value}-(${left.value}))*(${local}-${left.time})/${span}`;
		expression = `if(lt(${local},${right.time}),${value},${expression})`;
	}
	return `if(lt(${local},${keyframes[0]!.time}),${keyframes[0]!.value},${expression})`;
}

function valueAt(
	keyframes: AvatarRigKeyframe[],
	property: AvatarRigProperty,
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
		const next = points[index]!;
		const previous = points[index - 1]!;
		if (time > next.time) {
			continue;
		}
		const span = next.time - previous.time;
		const progress = span > 0 ? (time - previous.time) / span : 1;
		return previous.value + (next.value - previous.value) * progress;
	}
	return last.value;
}

/** Resolve an avatar's pose from its preset, idle motion, and local keyframes. */
export function avatarPoseAtTime(
	avatar: AvatarRigSource,
	time: number
): AvatarRigPose {
	const elapsed = Math.max(0, time - avatar.start);
	const pose = avatarBasePose(avatar.pose);
	if (avatar.animation === "idle") {
		const sway = Math.sin(elapsed * Math.PI * 2) * 4;
		pose.leftArm += sway;
		pose.rightArm -= sway;
		pose.head += Math.sin(elapsed * Math.PI * 2) * 2;
	}
	const localTime = elapsed;
	const keyframes = avatar.rigKeyframes ?? [];
	return {
		leftArm: valueAt(keyframes, "leftArm", localTime, pose.leftArm),
		rightArm: valueAt(keyframes, "rightArm", localTime, pose.rightArm),
		leftLeg: valueAt(keyframes, "leftLeg", localTime, pose.leftLeg),
		rightLeg: valueAt(keyframes, "rightLeg", localTime, pose.rightLeg),
		head: valueAt(keyframes, "head", localTime, pose.head),
		mouth: Math.max(
			0,
			Math.min(1, valueAt(keyframes, "mouth", localTime, pose.mouth))
		),
	};
}

export function avatarRigValueBounds(property: AvatarRigProperty) {
	return property === "mouth" ? { min: 0, max: 1 } : { min: -180, max: 180 };
}
