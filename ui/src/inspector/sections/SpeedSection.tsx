import { RyuAppField } from "@ryu/blocks/companion/app-ui";
import { Button, Switch } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HIGH_SPEED_MUTE_ABOVE,
	highSpeedMutedOf,
	maxGroupSpeedFor,
	SPEED_PRESETS,
	speedGroupOf,
	withClipSpeed,
} from "../../../../shared/clip-speed.ts";
import {
	clipVolumeFromDb,
	displayDb,
	formatDb,
	gainToDb,
	MAX_CLIP_GAIN,
	SILENCE_DB,
} from "../../../../shared/decibels.ts";
import {
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "../../../../shared/project.ts";
import { preservePitchOf } from "../../../../shared/schema/defaults.ts";
import { ClipEditActions } from "../../ClipEditActions.tsx";
import { splitEditSelected } from "../../editor/actions/split.ts";
import { useEditorProject } from "../../editor/context.tsx";
import { clock } from "../../editor/format.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";
import { NumberField } from "../../NumberField.tsx";
import type { ClipSectionProps } from "../section-props.ts";

const TIMELINE_LIMIT = 7200;
/** Highest clip gain in decibels (linear 4). */
const MAX_CLIP_DB = Math.floor(gainToDb(MAX_CLIP_GAIN) * 10) / 10;

const speedLabel = (speed: number) => `${speed}x`;

/**
 * Change the clip's speed through `withClipSpeed`: the request is clamped to
 * what keeps the clip valid (length, fades, exit transition, keyframes) and
 * link-group partners follow, so linked audio and video stay in sync.
 */
export function changeClipSpeed(
	runtime: Pick<EditorRuntime, "edit" | "project" | "setStatus">,
	segment: Pick<Segment, "id">,
	requested: number
): void {
	const { project } = runtime;
	if (!project) {
		return;
	}
	const locked = speedGroupOf(project, segment.id).some(
		(member) => trackSettingFor(project, member.track).locked
	);
	if (locked) {
		runtime.setStatus("Unlock this clip's tracks before changing its speed.");
		return;
	}
	const change = withClipSpeed(project, segment.id, requested);
	if (!change) {
		return;
	}
	runtime.edit(change.project, "Change clip speed");
	const notes: string[] = [];
	if (change.limited) {
		notes.push(
			`Speed limited to ${speedLabel(change.speed)} so the clip stays longer than its fades, transitions and keyframes.`
		);
	}
	if (change.partners > 0) {
		notes.push(
			`${change.partners === 1 ? "The linked clip" : `${change.partners} linked clips`} followed.`
		);
	}
	if (notes.length > 0) {
		runtime.setStatus(notes.join(" "));
	}
}

/**
 * Clip speed (0.1x-100x) with pitch handling and high-speed muting, volume in
 * decibels, and the time-based clip operations: freeze frame, reverse, and J/L
 * split edits (detach/recover audio lives in `DetachSection`).
 */
export function SpeedSection({ onChange, segment }: ClipSectionProps) {
	const runtime = useEditorProject();
	const { assets, busy, project, splitSettings, time } = runtime;
	const hasAudio =
		assets.find((asset) => asset.id === segment.assetId)?.hasAudio ?? false;
	const volumeDb = displayDb(gainToDb(segment.volume));
	const maxSpeed = project ? maxGroupSpeedFor(project, segment.id) : 100;
	const setSpeed = (speed: number) => changeClipSpeed(runtime, segment, speed);
	const tl = useLiteralMessages();
	const speedText = segment.speedCurve
		? tl("Speed curve · averages {speed}", {
				speed: speedLabel(Number(segment.speed.toFixed(2))),
			})
		: speedLabel(segment.speed);
	const duration = clock(segmentDuration(segment));
	const maxSpeedText = speedLabel(maxSpeed);
	const keepAudioLabel = tl("Keep audio above {speed}x", {
		speed: HIGH_SPEED_MUTE_ABOVE,
	});
	return (
		<>
			<RyuAppField label="Speed">
				<div className="flex flex-wrap gap-1">
					{SPEED_PRESETS.map((speed) => (
						<Button
							aria-pressed={segment.speed === speed}
							disabled={speed > maxSpeed}
							key={speed}
							onClick={() => setSpeed(speed)}
							size="sm"
							title={
								speed > maxSpeed
									? tl("Too fast: this clip allows up to {maxSpeed}", {
											maxSpeed: maxSpeedText,
										})
									: undefined
							}
							variant={segment.speed === speed ? "default" : "outline"}
						>
							{speedLabel(speed)}
						</Button>
					))}
				</div>
				<small>
					{maxSpeed < 100
						? tl(
								"{speed} · plays for {duration} · up to {maxSpeed} for this clip",
								{ duration, maxSpeed: maxSpeedText, speed: speedText }
							)
						: tl("{speed} · plays for {duration}", {
								duration,
								speed: speedText,
							})}
				</small>
				{segment.speedCurve && (
					<small>
						Choosing a constant speed replaces the curve. Edit the curve in
						Speed &amp; beat.
					</small>
				)}
			</RyuAppField>
			<NumberField
				label={tl("Custom speed (0.1x-{maxSpeed})", { maxSpeed: maxSpeedText })}
				max={maxSpeed}
				min={0.1}
				onChange={setSpeed}
				step={0.05}
				value={segment.speed}
			/>
			{hasAudio && (
				<>
					<RyuAppField label="Preserve pitch">
						<Switch
							aria-label="Preserve pitch"
							checked={preservePitchOf(segment)}
							onCheckedChange={(checked) =>
								onChange({ preservePitch: checked ? undefined : false })
							}
						/>
						<small>
							Off plays tape-style: faster clips sound higher, slower clips
							lower.
						</small>
					</RyuAppField>
					{segment.speed > HIGH_SPEED_MUTE_ABOVE && (
						<RyuAppField label={keepAudioLabel}>
							<Switch
								aria-label={keepAudioLabel}
								checked={!highSpeedMutedOf(segment)}
								onCheckedChange={(checked) =>
									onChange({ muted: checked ? false : undefined })
								}
							/>
							<small>
								{tl(
									"Audio faster than {speed}x is muted by default because it is rarely intelligible.",
									{ speed: HIGH_SPEED_MUTE_ABOVE }
								)}
							</small>
						</RyuAppField>
					)}
					<NumberField
						label={tl("Volume (dB) · {volume}", { volume: formatDb(volumeDb) })}
						max={MAX_CLIP_DB}
						min={SILENCE_DB}
						onChange={(db) => onChange({ volume: clipVolumeFromDb(db) })}
						step={0.5}
						value={Math.round(volumeDb * 10) / 10}
					/>
				</>
			)}
			<ClipEditActions
				assets={assets}
				busy={busy}
				onFreezeFrame={({ duration: holdFor, mode }) =>
					void runtime.routeEdit(
						"freeze-frame",
						{
							at: Math.max(0, Math.min(TIMELINE_LIMIT, time)),
							clipId: segment.id,
							duration: holdFor,
							mode,
						},
						() =>
							`Froze a ${holdFor.toFixed(1)}s still ${mode === "insert" ? `at ${clock(time)}` : "after the clip"} and rippled later layers.`,
						{ refreshAssets: true }
					)
				}
				onReverse={() =>
					void runtime.routeEdit(
						"reverse",
						{ clipIds: [segment.id] },
						() => "Clip direction changed; linked partners followed.",
						{ refreshAssets: true }
					)
				}
				onSettingsChange={runtime.setSplitSettings}
				onSplitEdit={(kind) => splitEditSelected(runtime, kind)}
				project={project}
				segment={segment}
				settings={splitSettings}
				time={time}
			/>
		</>
	);
}
