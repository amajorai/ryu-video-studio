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
import { useContext, useState } from "react";
import {
	type AvatarRigProperty,
	avatarRigPropertySchema,
	avatarRigValueBounds,
} from "../../shared/avatar.ts";
import {
	DEFAULT_LIP_SYNC_SENSITIVITY,
	DEFAULT_LIP_SYNC_SMOOTHING,
	type LipSyncEnvelopeKind,
	lipSyncEnvelopeKindSchema,
	lipSyncSourceKey,
	lipSyncSourceOptions,
} from "../../shared/avatar-lipsync.ts";
import type { Asset, Avatar, Project } from "../../shared/project.ts";
import { avatarSchema } from "../../shared/project.ts";
import { PhotorealControls } from "./ai/PhotorealControls.tsx";
import { EditorContext } from "./editor/context.tsx";
import type { EditorRuntime } from "./editor/runtime.ts";

const unitValue = (value: number, fallback: number) =>
	Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;

/** Status line after a lip-sync run, from the route's extras. */
export function lipSyncSummary(extras: Record<string, unknown>): string {
	const keyframes = typeof extras.keyframes === "number" ? extras.keyframes : 0;
	const voiced =
		typeof extras.voicedRatio === "number"
			? Math.round(extras.voicedRatio * 100)
			: 0;
	return `Lip-synced the avatar: ${keyframes} mouth keyframe${keyframes === 1 ? "" : "s"}, mouth open ${voiced}% of the time.`;
}

/**
 * Mouth lip-sync for one avatar: pick the clip or media whose speech drives
 * the mouth, tune sensitivity and smoothing, and run the sidecar route.
 */
export function AvatarLipSyncControls({
	assets,
	avatar,
	label,
	project,
	runtime,
}: {
	assets: readonly Asset[];
	avatar: Avatar;
	label: string;
	project: Project;
	runtime: Pick<EditorRuntime, "busy" | "routeEdit">;
}) {
	const tl = useLiteralMessages();
	const options = lipSyncSourceOptions(project, assets, avatar);
	const [choice, setChoice] = useState<string | undefined>(undefined);
	const [sensitivity, setSensitivity] = useState(DEFAULT_LIP_SYNC_SENSITIVITY);
	const [smoothing, setSmoothing] = useState(DEFAULT_LIP_SYNC_SMOOTHING);
	const [envelope, setEnvelope] = useState<LipSyncEnvelopeKind>("audio");
	const keys = options.map(lipSyncSourceKey);
	const selectedKey =
		[choice, keys[0]].find((key) => key !== undefined && keys.includes(key)) ??
		"";
	const selected = options.find(
		(option) => lipSyncSourceKey(option) === selectedKey
	);
	const mouthKeyframes = (avatar.rigKeyframes ?? []).filter(
		(keyframe) => keyframe.property === "mouth"
	).length;
	const run = () => {
		if (!selected) {
			return;
		}
		void runtime.routeEdit(
			"avatars/lip-sync",
			{
				avatarId: avatar.id,
				envelope,
				sensitivity,
				smoothing,
				...(selected.segmentId
					? { segmentId: selected.segmentId }
					: { assetId: selected.assetId }),
			},
			lipSyncSummary
		);
	};
	return (
		<div className="flex flex-col gap-2" data-avatar-lipsync={avatar.id}>
			<RyuAppField label="Lip-sync audio">
				<NativeSelect
					aria-label={tl("{avatar} lip-sync audio", { avatar: label })}
					disabled={!options.length}
					onChange={(event) => setChoice(event.target.value)}
					value={selectedKey}
				>
					{options.length ? null : (
						<NativeSelectOption value="">No audible media</NativeSelectOption>
					)}
					{options.map((option) => (
						<NativeSelectOption
							key={lipSyncSourceKey(option)}
							value={lipSyncSourceKey(option)}
						>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Lip-sync loudness">
				<NativeSelect
					aria-label={tl("{avatar} lip-sync loudness", { avatar: label })}
					onChange={(event) =>
						setEnvelope(lipSyncEnvelopeKindSchema.parse(event.target.value))
					}
					value={envelope}
				>
					<NativeSelectOption value="audio">
						Speech loudness (20 ms)
					</NativeSelectOption>
					<NativeSelectOption value="analysis">
						Media analysis waveform (faster, coarser)
					</NativeSelectOption>
				</NativeSelect>
			</RyuAppField>
			<RyuAppField label="Lip-sync sensitivity">
				<Input
					aria-label={tl("{avatar} lip-sync sensitivity", { avatar: label })}
					max={1}
					min={0}
					onChange={(event) =>
						setSensitivity(unitValue(Number(event.target.value), sensitivity))
					}
					step={0.05}
					type="number"
					value={sensitivity}
				/>
			</RyuAppField>
			<RyuAppField label="Lip-sync smoothing">
				<Input
					aria-label={tl("{avatar} lip-sync smoothing", { avatar: label })}
					max={1}
					min={0}
					onChange={(event) =>
						setSmoothing(unitValue(Number(event.target.value), smoothing))
					}
					step={0.05}
					type="number"
					value={smoothing}
				/>
			</RyuAppField>
			<Button
				disabled={runtime.busy || !selected}
				onClick={run}
				variant="outline"
			>
				Lip-sync mouth to audio
			</Button>
			<small className="text-muted-foreground">
				{mouthKeyframes
					? tl(
							"{count, plural, one {# mouth keyframe} other {# mouth keyframes}}. Lip-sync replaces them; other rig keyframes stay. Muted clips are not offered.",
							{ count: mouthKeyframes }
						)
					: "Generates mouth keyframes from speech loudness and transcript words (up to 100 rig keyframes per avatar)."}
			</small>
		</div>
	);
}

export function AvatarPanel({
	avatars,
	time,
	onChange,
}: {
	avatars: Avatar[];
	time: number;
	onChange: (avatars: Avatar[]) => void;
}) {
	// Optional: lip-sync needs the open project, so the panel also renders
	// without an editor (the controls are hidden then).
	const runtime = useContext(EditorContext);
	const tl = useLiteralMessages();
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
			{runtime?.project ? (
				<PhotorealControls assets={runtime.assets} runtime={runtime} />
			) : null}
			{avatars.map((avatar, index) => (
				<div className="studio-scene" key={avatar.id}>
					<strong>{tl("Avatar {number}", { number: index + 1 })}</strong>
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
								aria-label={tl("Avatar {number} {field}", {
									field: tl(label),
									number: index + 1,
								})}
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
							triggerAriaLabel={tl("Avatar {number} skin color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={avatar.skin}
						/>
					</RyuAppField>
					<RyuAppField label="Outfit color">
						<ColorPickerPopover
							onValueChange={(value) => change(avatar.id, { outfit: value })}
							triggerAriaLabel={tl("Avatar {number} outfit color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={avatar.outfit}
						/>
					</RyuAppField>
					<RyuAppField label="Accent color">
						<ColorPickerPopover
							onValueChange={(value) => change(avatar.id, { accent: value })}
							triggerAriaLabel={tl("Avatar {number} accent color", {
								number: index + 1,
							})}
							triggerClassName="w-full justify-start"
							value={avatar.accent}
						/>
					</RyuAppField>
					<RyuAppField label="Pose">
						<NativeSelect
							aria-label={tl("Avatar {number} pose", {
								number: index + 1,
							})}
							onChange={(event) =>
								change(avatar.id, {
									pose: avatarSchema.shape.pose.parse(event.target.value),
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
							aria-label={tl("Avatar {number} motion", {
								number: index + 1,
							})}
							onChange={(event) =>
								change(avatar.id, {
									animation: avatarSchema.shape.animation.parse(
										event.target.value
									),
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
							aria-label={tl("Avatar {number} rig keyframe property", {
								number: index + 1,
							})}
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
							aria-label={tl("Avatar {number} rig keyframe value", {
								number: index + 1,
							})}
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
							{tl(
								"{count, plural, one {# rig keyframe} other {# rig keyframes}} saved",
								{ count: avatar.rigKeyframes.length }
							)}
						</small>
					) : null}
					{runtime?.project ? (
						<AvatarLipSyncControls
							assets={runtime.assets}
							avatar={avatar}
							label={tl("Avatar {number}", { number: index + 1 })}
							project={runtime.project}
							runtime={runtime}
						/>
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
