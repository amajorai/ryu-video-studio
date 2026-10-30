import { avatarPoseAtTime } from "../../../shared/avatar.ts";
import type { Project } from "../../../shared/project.ts";
import type { PreviewStyle } from "./preview-style.ts";

function AvatarLayer({
	avatar,
	time,
}: {
	avatar: Project["avatars"][number];
	time: number;
}) {
	const elapsed = time - avatar.start;
	const progress = avatar.entryDuration
		? Math.min(1, Math.max(0, elapsed / avatar.entryDuration))
		: 1;
	const entryOffset = (1 - progress) * 8;
	const slide =
		avatar.animation === "slide-left"
			? -entryOffset
			: avatar.animation === "slide-right"
				? entryOffset
				: 0;
	const bob =
		avatar.animation === "idle" ? Math.sin(elapsed * Math.PI * 2) * 1.5 : 0;
	const pose = avatarPoseAtTime(avatar, time);
	const avatarStyle: PreviewStyle = {
		"--studio-avatar-shadow-x": `${avatar.depth * 10}px`,
		"--studio-avatar-shadow-y": `${avatar.depth * 14}px`,
		"--studio-avatar-shadow-blur": `${avatar.depth * 8}px`,
		"--studio-avatar-shadow-opacity": `${(0.35 + avatar.depth * 0.25) * 100}%`,
		"--studio-avatar-height": `${avatar.height * 100}%`,
		"--studio-avatar-left": `${avatar.x * 100}%`,
		"--studio-avatar-top": `${avatar.y * 100}%`,
		"--studio-avatar-opacity": `${progress}`,
		"--studio-avatar-transform": `translate(${slide}%, ${bob}%)`,
		"--studio-avatar-width": `${avatar.width * 100}%`,
	};
	const avatarShadowStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.accent,
	};
	const avatarLeftArmStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.skin,
		"--studio-avatar-joint-rotation": `rotate(${pose.leftArm}deg)`,
	};
	const avatarRightArmStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.skin,
		"--studio-avatar-joint-rotation": `rotate(${pose.rightArm}deg)`,
	};
	const avatarLeftLegStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.outfit,
		"--studio-avatar-joint-rotation": `rotate(${pose.leftLeg}deg)`,
	};
	const avatarRightLegStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.outfit,
		"--studio-avatar-joint-rotation": `rotate(${pose.rightLeg}deg)`,
	};
	const avatarBodyStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.outfit,
	};
	const avatarHeadStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.skin,
		"--studio-avatar-head-rotation": `rotate(${pose.head}deg)`,
	};
	const avatarHairStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.accent,
	};
	const avatarMouthStyle: PreviewStyle = {
		"--studio-avatar-mouth-width": `${10 + pose.mouth * 36}%`,
	};
	const avatarBadgeStyle: PreviewStyle = {
		"--studio-avatar-fill": avatar.accent,
	};
	return (
		<div aria-label="2.5D avatar" className="studio-avatar" style={avatarStyle}>
			<div className="studio-avatar-shadow" style={avatarShadowStyle} />
			<div
				className="studio-avatar-arm studio-avatar-arm-left"
				style={avatarLeftArmStyle}
			/>
			<div
				className="studio-avatar-arm studio-avatar-arm-right"
				style={avatarRightArmStyle}
			/>
			<div
				className="studio-avatar-leg studio-avatar-leg-left"
				style={avatarLeftLegStyle}
			/>
			<div
				className="studio-avatar-leg studio-avatar-leg-right"
				style={avatarRightLegStyle}
			/>
			<div className="studio-avatar-body" style={avatarBodyStyle} />
			<div className="studio-avatar-head" style={avatarHeadStyle}>
				<span className="studio-avatar-eye studio-avatar-eye-left" />
				<span className="studio-avatar-eye studio-avatar-eye-right" />
				<span className="studio-avatar-hair" style={avatarHairStyle} />
				<span className="studio-avatar-mouth" style={avatarMouthStyle} />
			</div>
			<div className="studio-avatar-badge" style={avatarBadgeStyle} />
		</div>
	);
}

/** 2.5D avatars visible at `time`, in project order. */
export function PreviewAvatars({
	project,
	time,
}: {
	project: Project;
	time: number;
}) {
	return project.avatars
		.filter((avatar) => time >= avatar.start && time < avatar.end)
		.map((avatar) => (
			<AvatarLayer avatar={avatar} key={avatar.id} time={time} />
		));
}
