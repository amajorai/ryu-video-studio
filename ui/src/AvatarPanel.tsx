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
import { useState } from "react";
import {
	type AvatarRigProperty,
	avatarRigPropertySchema,
	avatarRigValueBounds,
} from "../../shared/avatar.ts";
import type { Avatar } from "../../shared/project.ts";

export function AvatarPanel({
	avatars,
	time,
	onChange,
}: {
	avatars: Avatar[];
	time: number;
	onChange: (avatars: Avatar[]) => void;
}) {
	const [rigProperty, setRigProperty] = useState<AvatarRigProperty>("leftArm");
	const [rigValue, setRigValue] = useState(0);
	const add = () =>
		onChange([
			...avatars,
			{
				accent: "#f97316",
				animation: "idle",
				depth: 0.45,
				end: Math.min(7200, time + 4),
				entryDuration: 0.35,
				height: 0.64,
				id: crypto.randomUUID(),
				outfit: "#4f46e5",
				pose: "neutral",
				skin: "#f4c7a1",
				start: time,
				width: 0.28,
				x: 0.62,
				y: 0.2,
			},
		]);
	const change = (id: string, patch: Partial<Avatar>) =>
		onChange(
			avatars.map((avatar) =>
				avatar.id === id ? { ...avatar, ...patch } : avatar
			)
		);
	const addRigKeyframe = (avatar: Avatar) => {
		const bounds = avatarRigValueBounds(rigProperty);
		const value = Math.max(bounds.min, Math.min(bounds.max, rigValue));
		const localTime = Math.max(
			0,
			Math.min(avatar.end - avatar.start, time - avatar.start)
		);
		const keyframe = {
			id: crypto.randomUUID(),
			property: rigProperty,
			time: Number(localTime.toFixed(3)),
			value,
		};
		const keyframes = [
			...(avatar.rigKeyframes ?? []).filter(
				(item) =>
					!(item.property === keyframe.property && item.time === keyframe.time)
			),
			keyframe,
		].sort((a, b) => a.time - b.time);
		change(avatar.id, { rigKeyframes: keyframes });
	};
	return (
		<RyuAppSection title="Avatars">
			<RyuAppActions>
				<Button disabled={time > 7199} onClick={add} variant="outline">
					Add 2.5D avatar
				</Button>
			</RyuAppActions>
			<p className="text-muted-foreground">
				Build a lightweight character stage from editable depth, pose, and color
				layers. It renders locally with the timeline.
			</p>
			{avatars.map((avatar, index) => (
				<div className="studio-scene" key={avatar.id}>
					<strong>Avatar {index + 1}</strong>
					{(
						[
							["start", "Start", 0, 7200],
							["end", "End", 0, 7200],
							["x", "Left", 0, 1],
							["y", "Top", 0, 1],
							["width", "Width", 0.08, 1],
							["height", "Height", 0.08, 1],
							["depth", "Depth", 0, 1],
							["entryDuration", "Entry duration", 0, 10],
						] as const
					).map(([key, label, min, max]) => (
						<RyuAppField key={key} label={label}>
							<Input
								aria-label={`Avatar ${index + 1} ${label}`}
								defaultValue={avatar[key]}
								key={avatar[key]}
								max={max}
								min={min}
								onBlur={(event) => {
									const value = Number(event.target.value);
									if (Number.isFinite(value) && value >= min && value <= max) {
										change(avatar.id, { [key]: value });
									} else {
										event.target.value = String(avatar[key]);
									}
								}}
								step={0.01}
								type="number"
							/>
						</RyuAppField>
					))}
					<RyuAppField label="Skin color">
						<ColorPickerPopover
							onValueChange={(value) => change(avatar.id, { skin: value })}
							triggerAriaLabel={`Avatar ${index + 1} skin color`}
							triggerClassName="w-full justify-start"
							value={avatar.skin}
						/>
					</RyuAppField>
					<RyuAppField label="Outfit color">
						<ColorPickerPopover
							onValueChange={(value) => change(avatar.id, { outfit: value })}
							triggerAriaLabel={`Avatar ${index + 1} outfit color`}
							triggerClassName="w-full justify-start"
							value={avatar.outfit}
						/>
					</RyuAppField>
					<RyuAppField label="Accent color">
						<ColorPickerPopover
							onValueChange={(value) => change(avatar.id, { accent: value })}
							triggerAriaLabel={`Avatar ${index + 1} accent color`}
							triggerClassName="w-full justify-start"
							value={avatar.accent}
						/>
					</RyuAppField>
					<RyuAppField label="Pose">
						<NativeSelect
							aria-label={`Avatar ${index + 1} pose`}
							onChange={(event) =>
								change(avatar.id, {
									pose: event.target.value as Avatar["pose"],
								})
							}
							value={avatar.pose}
						>
							<NativeSelectOption value="neutral">Neutral</NativeSelectOption>
							<NativeSelectOption value="wave">Wave</NativeSelectOption>
							<NativeSelectOption value="point">Point</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Motion">
						<NativeSelect
							aria-label={`Avatar ${index + 1} motion`}
							onChange={(event) =>
								change(avatar.id, {
									animation: event.target.value as Avatar["animation"],
								})
							}
							value={avatar.animation}
						>
							<NativeSelectOption value="none">None</NativeSelectOption>
							<NativeSelectOption value="idle">Idle bob</NativeSelectOption>
							<NativeSelectOption value="slide-left">
								Slide left
							</NativeSelectOption>
							<NativeSelectOption value="slide-right">
								Slide right
							</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Rig keyframe property">
						<NativeSelect
							aria-label={`Avatar ${index + 1} rig keyframe property`}
							onChange={(event) => {
								const property = avatarRigPropertySchema.parse(
									event.target.value
								);
								setRigProperty(property);
								const bounds = avatarRigValueBounds(property);
								setRigValue(
									Math.max(bounds.min, Math.min(bounds.max, rigValue))
								);
							}}
							value={rigProperty}
						>
							<NativeSelectOption value="leftArm">Left arm</NativeSelectOption>
							<NativeSelectOption value="rightArm">
								Right arm
							</NativeSelectOption>
							<NativeSelectOption value="leftLeg">Left leg</NativeSelectOption>
							<NativeSelectOption value="rightLeg">
								Right leg
							</NativeSelectOption>
							<NativeSelectOption value="head">Head turn</NativeSelectOption>
							<NativeSelectOption value="mouth">Mouth open</NativeSelectOption>
						</NativeSelect>
					</RyuAppField>
					<RyuAppField label="Rig keyframe value">
						<Input
							aria-label={`Avatar ${index + 1} rig keyframe value`}
							max={avatarRigValueBounds(rigProperty).max}
							min={avatarRigValueBounds(rigProperty).min}
							onChange={(event) => setRigValue(Number(event.target.value))}
							step={0.1}
							type="number"
							value={rigValue}
						/>
					</RyuAppField>
					<Button onClick={() => addRigKeyframe(avatar)} variant="outline">
						Add rig keyframe at playhead
					</Button>
					{avatar.rigKeyframes?.length ? (
						<small>
							{avatar.rigKeyframes.length} rig keyframe
							{avatar.rigKeyframes.length === 1 ? "" : "s"} saved
						</small>
					) : null}
					<Button
						onClick={() =>
							onChange(avatars.filter((item) => item.id !== avatar.id))
						}
						size="sm"
						variant="ghost"
					>
						Remove avatar
					</Button>
				</div>
			))}
		</RyuAppSection>
	);
}
